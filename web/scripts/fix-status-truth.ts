// Status-truth corrections (2026-07-15 owner batch). DRY-RUN by default.
//
//   npx tsx scripts/fix-status-truth.ts                      # dry run
//   npx tsx scripts/fix-status-truth.ts --apply --members <id|email>,…
//
// --apply REFUSES to run without an explicit --members allowlist. Every action
// preserves history (nothing hard-deleted), writes BillingAuditLog rows, and
// re-reads what it changed. Actions per case (owner-approved list only):
//
//  PLACEHOLDER  member holds a $0 MANUAL sub on a retired "Continued
//               membership" plan → cancel the sub (kept, canceledAt+note),
//               clear member.membershipId, status → PROSPECT (they never had
//               a real membership). Profile review flags (COMPLETED/APPROVED)
//               are kept — profile state is separate from membership status.
//  PROFILE_ONLY member is PENDING_APPROVAL with NO membership configured →
//               approvalStatus APPROVED + migrationStatus COMPLETED (profile
//               reviewed); stays PROSPECT; nothing billing-related touched.
//  GUARDIAN_FIX guardian-only signup that became a member: link her User to
//               the child (Guardian profile + member_guardian_users +
//               child.guardianId), then SOFT-delete her member row (deletedAt
//               + breadcrumb note; login, documents, and history remain).
//  LINK_PLAN    member has a real active sub but member.membershipId is null →
//               point it at the sub's plan (display-only correctness).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const membersArg = args.includes("--members") ? args[args.indexOf("--members") + 1] : null;
const allow = new Set(
  (membersArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

if (APPLY && allow.size === 0) {
  console.error("--apply requires an explicit --members <id|email>,… allowlist. Run the dry run first.");
  process.exit(1);
}

type Action =
  | { kind: "PLACEHOLDER"; memberId: string; name: string; subId: string; planId: string }
  | { kind: "PROFILE_ONLY"; memberId: string; name: string }
  | { kind: "GUARDIAN_FIX"; memberId: string; name: string; userId: string; childId: string; childName: string }
  | { kind: "LINK_PLAN"; memberId: string; name: string; planId: string; planName: string };

async function collect(): Promise<Action[]> {
  const actions: Action[] = [];

  // PLACEHOLDER: active $0 MANUAL subs on "Continued membership" plans.
  const placeholderSubs = await prisma.memberSubscription.findMany({
    where: {
      status: "active",
      billingType: "MANUAL",
      price: 0,
      stripeSubscriptionId: null,
      membership: { name: { contains: "Continued", mode: "insensitive" } },
    },
    select: {
      id: true,
      membershipId: true,
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  for (const s of placeholderSubs) {
    actions.push({
      kind: "PLACEHOLDER",
      memberId: s.member.id,
      name: `${s.member.firstName} ${s.member.lastName ?? ""}`.trim(),
      subId: s.id,
      planId: s.membershipId!,
    });
  }

  // PROFILE_ONLY: pending-approval members with nothing configured
  // (JSON-null filtering in prisma is awkward — filter in JS).
  const pendingAll = await prisma.member.findMany({
    where: { deletedAt: null, approvalStatus: "PENDING_APPROVAL" },
    select: {
      id: true, firstName: true, lastName: true,
      migrationMembershipId: true, migrationSelectedOption: true,
      migrationPriceOverride: true, legacyMembershipName: true, legacyMembershipPrice: true,
    },
  });
  for (const m of pendingAll) {
    const nothingConfigured =
      !m.migrationMembershipId &&
      (m.migrationSelectedOption == null || typeof m.migrationSelectedOption !== "object") &&
      m.migrationPriceOverride == null &&
      !m.legacyMembershipName &&
      m.legacyMembershipPrice == null;
    if (nothingConfigured) {
      actions.push({
        kind: "PROFILE_ONLY",
        memberId: m.id,
        name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
      });
    }
  }

  // GUARDIAN_FIX: adult members with a login, no subs/attendance/transactions,
  // whose login email is some minor's guardianEmail (guardian-only accounts).
  const guardianish = await prisma.member.findMany({
    where: {
      deletedAt: null,
      isMinor: false,
      userId: { not: null },
      subscriptions: { none: {} },
      attendanceRecords: { none: {} },
      transactions: { none: {} },
    },
    select: { id: true, firstName: true, lastName: true, userId: true, clubId: true, user: { select: { email: true } } },
  });
  for (const g of guardianish) {
    const email = g.user?.email?.toLowerCase();
    if (!email) continue;
    const child = await prisma.member.findFirst({
      where: { clubId: g.clubId, deletedAt: null, isMinor: true, guardianEmail: { equals: email, mode: "insensitive" } },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!child) continue; // not a guardian-only pattern — leave alone
    actions.push({
      kind: "GUARDIAN_FIX",
      memberId: g.id,
      name: `${g.firstName} ${g.lastName ?? ""}`.trim(),
      userId: g.userId!,
      childId: child.id,
      childName: `${child.firstName} ${child.lastName ?? ""}`.trim(),
    });
  }

  // LINK_PLAN: real active sub, member.membershipId null.
  const linkCandidates = await prisma.memberSubscription.findMany({
    where: { status: "active", member: { deletedAt: null, membershipId: null } },
    select: {
      membershipId: true,
      stripeSubscriptionId: true,
      membership: { select: { name: true } },
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  const seenLink = new Set<string>();
  for (const s of linkCandidates) {
    if (!s.membershipId || !s.stripeSubscriptionId) continue; // real Stripe-backed subs only
    if (seenLink.has(s.member.id)) continue;
    seenLink.add(s.member.id);
    actions.push({
      kind: "LINK_PLAN",
      memberId: s.member.id,
      name: `${s.member.firstName} ${s.member.lastName ?? ""}`.trim(),
      planId: s.membershipId,
      planName: s.membership?.name ?? "?",
    });
  }

  return actions;
}

async function allowed(memberId: string, name: string): Promise<boolean> {
  if (allow.size === 0) return true; // dry run shows everything
  if (allow.has(memberId.toLowerCase())) return true;
  const m = await prisma.member.findUnique({ where: { id: memberId }, select: { email: true } });
  return !!(m?.email && allow.has(m.email.toLowerCase())) || allow.has(name.toLowerCase());
}

async function main() {
  const actions = await collect();
  console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"} — ${actions.length} proposed action(s) ===\n`);
  for (const a of actions) {
    const inAllow = APPLY ? await allowed(a.memberId, a.name) : true;
    const mark = APPLY && !inAllow ? "✗ (not in allowlist)" : "→";
    if (a.kind === "PLACEHOLDER")
      console.log(`${mark} PLACEHOLDER  ${a.name} (${a.memberId}): cancel $0 sub ${a.subId}, clear membershipId, status → PROSPECT (profile flags kept)`);
    if (a.kind === "PROFILE_ONLY")
      console.log(`${mark} PROFILE_ONLY ${a.name} (${a.memberId}): approvalStatus → APPROVED, migrationStatus → COMPLETED; stays PROSPECT; no membership/billing`);
    if (a.kind === "GUARDIAN_FIX")
      console.log(`${mark} GUARDIAN_FIX ${a.name} (${a.memberId}): link user → child ${a.childName} (${a.childId}), then SOFT-delete the guardian's member row (login+history kept)`);
    if (a.kind === "LINK_PLAN")
      console.log(`${mark} LINK_PLAN    ${a.name} (${a.memberId}): member.membershipId → ${a.planName} (${a.planId})`);
  }
  if (!APPLY) {
    console.log("\nDry run only — nothing written. Re-run with --apply --members <ids> after owner approval.");
    return;
  }

  for (const a of actions) {
    if (!(await allowed(a.memberId, a.name))) continue;
    const member = await prisma.member.findUnique({ where: { id: a.memberId }, select: { clubId: true, status: true, notes: true, membershipId: true, approvalStatus: true, migrationStatus: true } });
    if (!member) continue;

    if (a.kind === "PLACEHOLDER") {
      await prisma.memberSubscription.update({
        where: { id: a.subId },
        data: {
          status: "canceled",
          canceledAt: new Date(),
          notes: "Canceled 2026-07-15 (owner-approved): $0 placeholder 'Continued membership' created by the old approve fallback — never a real membership.",
        },
      });
      await prisma.member.update({
        where: { id: a.memberId },
        data: { status: "PROSPECT", ...(member.membershipId === a.planId ? { membershipId: null } : {}) },
      });
      await prisma.billingAuditLog.create({
        data: {
          clubId: member.clubId, memberId: a.memberId, actorUserId: null,
          action: "PLACEHOLDER_MEMBERSHIP_RETIRED",
          before: { subId: a.subId, status: member.status, membershipId: member.membershipId },
          after: { subStatus: "canceled", memberStatus: "PROSPECT", membershipId: null },
          note: "Owner-approved: fake $0 'Continued membership' retired; profile/guardians/cards/attendance untouched; member is a prospect until a real membership exists.",
        },
      });
    }
    if (a.kind === "PROFILE_ONLY") {
      await prisma.member.update({
        where: { id: a.memberId },
        data: { approvalStatus: "APPROVED", migrationStatus: "COMPLETED", migrationCompletedAt: new Date() },
      });
      await prisma.billingAuditLog.create({
        data: {
          clubId: member.clubId, memberId: a.memberId, actorUserId: null,
          action: "PROFILE_APPROVED_NO_MEMBERSHIP",
          before: { approvalStatus: member.approvalStatus, migrationStatus: member.migrationStatus },
          after: { approvalStatus: "APPROVED", migrationStatus: "COMPLETED" },
          note: "Owner-approved: profile review closed with NO membership/billing created; member remains a prospect.",
        },
      });
    }
    if (a.kind === "GUARDIAN_FIX") {
      const child = await prisma.member.findUnique({ where: { id: a.childId }, select: { clubId: true, guardianName: true, guardianEmail: true, guardianPhone: true } });
      const user = await prisma.user.findUnique({ where: { id: a.userId }, select: { email: true, firstName: true, lastName: true } });
      if (!child || !user) continue;
      const guardianProfile = await prisma.guardian.upsert({
        where: { clubId_email: { clubId: child.clubId, email: user.email.toLowerCase() } },
        update: { userId: a.userId },
        create: {
          clubId: child.clubId, firstName: user.firstName, lastName: user.lastName,
          email: user.email.toLowerCase(), phone: child.guardianPhone || "", userId: a.userId,
        },
      });
      await prisma.memberGuardianUser.upsert({
        where: { userId_memberId: { userId: a.userId, memberId: a.childId } },
        update: {},
        create: { userId: a.userId, memberId: a.childId, relationship: "GUARDIAN" },
      });
      await prisma.member.update({ where: { id: a.childId }, data: { guardianId: guardianProfile.id } });
      await prisma.member.update({
        where: { id: a.memberId },
        data: {
          deletedAt: new Date(),
          notes: `${member.notes ? member.notes + "\n" : ""}Hidden 2026-07-15 (owner-approved): guardian-only account — this person manages ${a.childName} and is not an athlete/member. Login, documents, and history preserved; restore by clearing deletedAt.`,
        },
      });
      await prisma.billingAuditLog.create({
        data: {
          clubId: member.clubId, memberId: a.childId, actorUserId: null,
          action: "GUARDIAN_LINK_REPAIRED",
          before: { guardianUserId: a.userId, linked: false, guardianMemberRow: a.memberId },
          after: { guardianUserId: a.userId, linked: true, guardianMemberRowHidden: true },
          note: `Owner-approved: linked guardian account (${user.email}) to ${a.childName}; the guardian's own member row was soft-hidden (guardian-only accounts are not athletes).`,
        },
      });
    }
    if (a.kind === "LINK_PLAN") {
      await prisma.member.update({ where: { id: a.memberId }, data: { membershipId: a.planId } });
      await prisma.billingAuditLog.create({
        data: {
          clubId: member.clubId, memberId: a.memberId, actorUserId: null,
          action: "MEMBERSHIP_POINTER_LINKED",
          before: { membershipId: null },
          after: { membershipId: a.planId },
          note: "Owner-approved: member.membershipId linked to the plan of their real active subscription (display correctness; no billing change).",
        },
      });
    }
    console.log(`applied ${a.kind} for ${a.name}`);
  }

  console.log("\nVerifying…");
  const after = await collect();
  console.log(`${after.length} remaining proposed action(s) after apply (allowlist may exclude some).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
