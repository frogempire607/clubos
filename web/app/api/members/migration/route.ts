import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { MIGRATION_STATUS, PAYMENT_SETUP } from "@/lib/migration";
import { deriveReadiness, resolveOfferPricing, READINESS_LABELS, type Readiness } from "@/lib/billingAdmin";
import type { Prisma } from "@prisma/client";

// GET /api/members/migration?filter=&page=&pageSize=&q=&group=&readiness=
// Migration dashboard: bucket counts + a paginated, filtered member list.
// NOT tier-gated. Permission-gated on `members` view like the rest of the app.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter") || "all";
  const q = (url.searchParams.get("q") || "").trim();
  const group = url.searchParams.get("group") || "";
  const readinessFilter = (url.searchParams.get("readiness") || "") as Readiness | "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get("pageSize") || "25", 10)));

  // Only members that went through migration (migrationStatus set).
  const base: Prisma.MemberWhereInput = {
    clubId,
    deletedAt: null,
    migrationStatus: { not: null },
  };

  const filterWhere: Prisma.MemberWhereInput =
    // "not_invited" is the actionable initial-invite bucket: still IMPORTED means
    // no activation link has gone out yet (the first send — email OR a family
    // token — flips a member to INVITED). "imported" kept as an alias.
    filter === "imported" || filter === "not_invited"
      ? { migrationStatus: MIGRATION_STATUS.IMPORTED }
      : filter === "invited"
        ? { migrationStatus: MIGRATION_STATUS.INVITED }
        : filter === "activated"
          ? { migrationStatus: MIGRATION_STATUS.ACTIVATED }
          : filter === "completed"
            ? { migrationStatus: MIGRATION_STATUS.COMPLETED }
            : filter === "needs_review"
              ? { migrationStatus: { in: [MIGRATION_STATUS.NEEDS_REVIEW, MIGRATION_STATUS.FAILED] } }
              : filter === "payment_required"
                ? {
                    paymentSetupStatus: PAYMENT_SETUP.REQUIRED,
                    migrationStatus: { not: MIGRATION_STATUS.COMPLETED },
                  }
                : filter === "legacy"
                  ? // Clients who carried a membership over from the previous
                    // software — the set an owner needs to activate/set up.
                    { legacyMembershipName: { not: null } }
                  : {};

  const search: Prisma.MemberWhereInput = q
    ? {
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { guardianEmail: { contains: q, mode: "insensitive" } },
          { legacyMemberId: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  // Operational group filter (Group A/B/C / Leave alone / …). "none" = not
  // yet classified.
  const groupWhere: Prisma.MemberWhereInput = group
    ? group === "none"
      ? ({ migrationGroup: null } as Prisma.MemberWhereInput)
      : ({ migrationGroup: group } as Prisma.MemberWhereInput)
    : {};

  const where: Prisma.MemberWhereInput = { AND: [base, filterWhere, search, groupWhere] };

  // Readiness is DERIVED per row (plan + date + saved card + triage), so a
  // readiness filter can't run in SQL — pull the whole candidate set (capped),
  // derive, then paginate in memory. Fine at this club's scale (~hundreds).
  const readinessMode = !!readinessFilter;

  const [
    total,
    imported,
    invited,
    activated,
    completed,
    needsReview,
    paymentRequired,
    missingContact,
    emailsSentAgg,
    rows,
    pageCount,
  ] = await Promise.all([
    prisma.member.count({ where: base }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.IMPORTED } }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.INVITED } }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.ACTIVATED } }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.COMPLETED } }),
    prisma.member.count({
      where: { ...base, migrationStatus: { in: [MIGRATION_STATUS.NEEDS_REVIEW, MIGRATION_STATUS.FAILED] } },
    }),
    prisma.member.count({
      where: { ...base, paymentSetupStatus: PAYMENT_SETUP.REQUIRED, migrationStatus: { not: MIGRATION_STATUS.COMPLETED } },
    }),
    prisma.member.count({
      where: { ...base, email: null, guardianEmail: null },
    }),
    prisma.member.aggregate({ where: base, _sum: { activationEmailSendCount: true } }),
    prisma.member.findMany({
      where,
      orderBy: { importedAt: "desc" },
      skip: readinessMode ? 0 : (page - 1) * pageSize,
      take: readinessMode ? 1000 : pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isMinor: true,
        guardianName: true,
        guardianEmail: true,
        legacySource: true,
        legacyMembershipName: true,
        legacyMembershipPrice: true,
        legacyBillingFrequency: true,
        billingAnchorDate: true,
        commitmentEndDate: true,
        migrationStatus: true,
        approvalStatus: true,
        paymentSetupStatus: true,
        requestedBillingDate: true,
        activationEmailSentAt: true,
        activationEmailSendCount: true,
        activatedAt: true,
        migrationCompletedAt: true,
        importedAt: true,
        // Owner-configured setup signals (set by the Set-up drawer's PATCH), used
        // to derive `setupComplete` below. Not surfaced raw to the client.
        migrationMembershipId: true,
        migrationSelectedOption: true,
        migrationPriceOverride: true,
        migrationFinalPeriodPaid: true,
        // Billing-control triage + readiness inputs.
        migrationGroup: true,
        migrationFinalAction: true,
        migrationGroupNote: true,
        migrationFinalBillingDate: true,
        requestedPaymentMethod: true,
        stripeSetupPaymentMethodId: true,
        subscriptions: {
          select: { status: true, stripeSubscriptionId: true, stripeStatus: true, billingType: true },
        },
      },
    }),
    prisma.member.count({ where }),
  ]);

  // A member is "set up" once an owner/staff configured their migration (picked
  // a plan / option / price override / final-paid) OR an activation invite went
  // out OR they've progressed past IMPORTED. billingAnchorDate is deliberately
  // NOT a signal — it can be pre-filled from the CSV import. This drives the
  // "Set up ✓" badge so staff don't redo a member another staffer already set up.
  // Who configured each row, and when: every Set-up drawer PATCH logs a NOTE
  // MemberMigrationEvent with the actor, so the latest one per member tells a
  // second staffer the setup isn't theirs to redo. actorUserId is a bare
  // string (no relation), hence the two-step name lookup.
  const pageIds = rows.map((r) => r.id);
  const setupEvents = pageIds.length
    ? await prisma.memberMigrationEvent.findMany({
        where: {
          memberId: { in: pageIds },
          type: "NOTE",
          message: { startsWith: "Migration setup updated" },
        },
        orderBy: { createdAt: "desc" },
        select: { memberId: true, createdAt: true, actorUserId: true },
      })
    : [];
  const latestSetupByMember = new Map<string, { createdAt: Date; actorUserId: string | null }>();
  for (const e of setupEvents) {
    if (!latestSetupByMember.has(e.memberId)) latestSetupByMember.set(e.memberId, e);
  }
  const actorIds = [
    ...new Set([...latestSetupByMember.values()].map((e) => e.actorUserId).filter((x): x is string => !!x)),
  ];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const actorName = new Map(actors.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

  // Readiness inputs shared across rows: club Stripe flags, the plans rows
  // reference (for real option prices), and each row's latest reactivation.
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { stripeAccountId: true, stripeChargesEnabled: true },
  });
  const planIds = [...new Set(rows.map((r) => r.migrationMembershipId).filter((x): x is string => !!x))];
  const plans = planIds.length
    ? await prisma.membership.findMany({
        where: { id: { in: planIds }, clubId, deletedAt: null },
        select: { id: true, name: true, options: true },
      })
    : [];
  const planById = new Map(plans.map((p) => [p.id, p]));
  const reactivations = pageIds.length || readinessMode
    ? await prisma.membershipReactivation.findMany({
        where: { memberId: { in: rows.map((r) => r.id) }, clubId },
        orderBy: { createdAt: "desc" },
        select: { memberId: true, status: true },
      })
    : [];
  const latestReactivation = new Map<string, string>();
  for (const r of reactivations) {
    if (!latestReactivation.has(r.memberId)) latestReactivation.set(r.memberId, r.status);
  }
  const LIVE = new Set(["active", "trialing", "past_due", "unpaid"]);

  const mapped = rows.map((r) => {
    const {
      migrationMembershipId,
      migrationSelectedOption,
      migrationPriceOverride,
      migrationFinalPeriodPaid,
      requestedPaymentMethod,
      stripeSetupPaymentMethodId,
      subscriptions,
      ...rest
    } = r;
    const setupComplete =
      !!(
        migrationMembershipId ||
        migrationSelectedOption ||
        migrationPriceOverride ||
        migrationFinalPeriodPaid ||
        rest.activationEmailSentAt
      ) ||
      rest.migrationStatus === MIGRATION_STATUS.INVITED ||
      rest.migrationStatus === MIGRATION_STATUS.ACTIVATED ||
      rest.migrationStatus === MIGRATION_STATUS.COMPLETED;
    const setupEvent = latestSetupByMember.get(r.id);

    const plan = migrationMembershipId ? planById.get(migrationMembershipId) ?? null : null;
    const pricing = resolveOfferPricing(
      {
        legacyMembershipName: rest.legacyMembershipName,
        legacyMembershipPrice: rest.legacyMembershipPrice as unknown as string | null,
        legacyBillingFrequency: rest.legacyBillingFrequency,
        migrationSelectedOption,
        migrationPriceOverride: migrationPriceOverride as unknown as string | null,
      },
      plan ? { name: plan.name, options: plan.options } : null,
    );
    const hasPlan = !!plan || !!rest.legacyMembershipName;
    const hasLiveStripeSub = subscriptions.some(
      (s) =>
        s.stripeSubscriptionId &&
        (s.status === "active" || s.status === "past_due") &&
        (!s.stripeStatus || LIVE.has(s.stripeStatus)),
    );
    const offlineIntended =
      !club?.stripeAccountId ||
      !club?.stripeChargesEnabled ||
      requestedPaymentMethod === "CASH" ||
      requestedPaymentMethod === "CHECK";
    const readiness = deriveReadiness({
      migrationGroup: rest.migrationGroup,
      migrationFinalAction: rest.migrationFinalAction,
      migrationStatus: rest.migrationStatus,
      approvalStatus: rest.approvalStatus,
      price: hasPlan || migrationPriceOverride != null ? pricing.price : null,
      hasPlan,
      hasCapturedCard: !!stripeSetupPaymentMethodId,
      offlineIntended,
      finalPeriodPaid: migrationFinalPeriodPaid,
      finalBillingDate: rest.migrationFinalBillingDate ?? rest.billingAnchorDate ?? null,
      hasLiveStripeSub,
      reactivationStatus: latestReactivation.get(r.id) ?? null,
    });

    return {
      ...rest,
      setupComplete,
      setupBy: setupEvent?.actorUserId ? actorName.get(setupEvent.actorUserId) ?? null : null,
      setupAt: setupEvent?.createdAt ?? null,
      hasCapturedCard: !!stripeSetupPaymentMethodId,
      resolvedPrice: hasPlan || migrationPriceOverride != null ? pricing.price : null,
      resolvedPeriod: pricing.period,
      readiness: readiness.state,
      readinessLabel: READINESS_LABELS[readiness.state],
      readinessReasons: readiness.reasons,
      reactivationStatus: latestReactivation.get(r.id) ?? null,
    };
  });

  // Readiness filter paginates in memory (derived value, see above).
  const filtered = readinessMode ? mapped.filter((m) => m.readiness === readinessFilter) : mapped;
  const members = readinessMode ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;
  const totalInFilter = readinessMode ? filtered.length : pageCount;

  // Group counts for the filter chips.
  const groupCounts = await prisma.member.groupBy({
    by: ["migrationGroup"],
    where: base,
    _count: { _all: true },
  });

  return NextResponse.json({
    stats: {
      total,
      imported,
      invited,
      activated,
      completed,
      needsReview,
      paymentRequired,
      missingContact,
      activationEmailsSent: emailsSentAgg._sum.activationEmailSendCount ?? 0,
      groups: Object.fromEntries(groupCounts.map((g) => [g.migrationGroup ?? "none", g._count._all])),
    },
    members,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(totalInFilter / pageSize)),
    totalInFilter,
  });
}
