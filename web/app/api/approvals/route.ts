import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";
import {
  MEMBERSHIP_CANCEL_KIND,
  MEMBERSHIP_PURCHASE_KIND,
  PRIVATE_PACKAGE_PURCHASE_KIND,
  INVOICE_SPLIT_KIND,
} from "@/lib/approvals";
import { MIGRATION_STATUS } from "@/lib/migration";

// GET /api/approvals
//
// Aggregated PENDING owner-surfaced approvals for the club's dashboard queue.
// Each row is enriched with the member's name and the kind-specific detail.
// Results are permission-filtered per requester:
//   GUARDIAN_LINK     → members:view
//   MEMBERSHIP_CANCEL → finances:view
// Owners see everything. The per-kind action routes enforce their own perms.

type Payload = {
  requestingUserId?: string;
  requestingUserEmail?: string | null;
  relationship?: string | null;
  optionLabel?: string | null;
  reason?: string | null;
  subscriptionId?: string;
  membershipId?: string;
  packageId?: string;
  paymentMethod?: string | null;
  discountCode?: string | null;
  // INVOICE_SPLIT
  splitId?: string;
  responderUserId?: string;
  proposerPercent?: number;
  responderPercent?: number;
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = (session.user as { role?: string }).role;
  if (role !== "OWNER" && role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const perms = (session.user as { permissions?: Record<string, unknown> | null }).permissions ?? null;
  const isOwner = role === "OWNER";

  const kinds: string[] = [];
  if (isOwner || hasPermission(perms, "members", "view")) {
    // INVOICE_SPLIT rides the members gate — it configures family billing
    // structure, not money movement; the action route requires members:edit.
    kinds.push(GUARDIAN_LINK_KIND, INVOICE_SPLIT_KIND);
  }
  if (isOwner || hasPermission(perms, "finances", "view")) {
    kinds.push(MEMBERSHIP_CANCEL_KIND, MEMBERSHIP_PURCHASE_KIND, PRIVATE_PACKAGE_PURCHASE_KIND);
  }
  if (kinds.length === 0) return NextResponse.json({ approvals: [] });

  const clubId = session.user.clubId;
  const rows = await prisma.pendingApproval.findMany({
    where: { clubId, status: "PENDING", kind: { in: kinds } },
    orderBy: { requestedAt: "desc" },
    select: { id: true, kind: true, memberId: true, payload: true, amount: true, requestedAt: true },
  });

  const memberIds = Array.from(new Set(rows.map((r) => r.memberId)));
  const members = memberIds.length
    ? await prisma.member.findMany({
        where: { id: { in: memberIds }, clubId },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const memberById = new Map(members.map((m) => [m.id, m]));

  const userIds = Array.from(
    new Set(
      rows
        .flatMap((r) => {
          const p = r.payload as Payload | null;
          return [p?.requestingUserId, p?.responderUserId];
        })
        .filter(Boolean) as string[],
    ),
  );
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  // Names for the cash/check purchase kinds so the queue reads like a
  // sentence ("Gold — Monthly · cash") instead of raw ids.
  const membershipIds = Array.from(
    new Set(
      rows
        .filter((r) => r.kind === MEMBERSHIP_PURCHASE_KIND)
        .map((r) => (r.payload as Payload | null)?.membershipId)
        .filter(Boolean) as string[],
    ),
  );
  const membershipsById = new Map(
    (membershipIds.length
      ? await prisma.membership.findMany({
          where: { id: { in: membershipIds }, clubId },
          select: { id: true, name: true },
        })
      : []
    ).map((m) => [m.id, m.name]),
  );
  const packageIds = Array.from(
    new Set(
      rows
        .filter((r) => r.kind === PRIVATE_PACKAGE_PURCHASE_KIND)
        .map((r) => (r.payload as Payload | null)?.packageId)
        .filter(Boolean) as string[],
    ),
  );
  const packagesById = new Map(
    (packageIds.length
      ? await prisma.privatePackage.findMany({
          where: { id: { in: packageIds }, clubId },
          select: { id: true, title: true },
        })
      : []
    ).map((p) => [p.id, p.title]),
  );

  const pendingApprovals = rows.map((r) => {
    const p = (r.payload as Payload | null) ?? {};
    const m = memberById.get(r.memberId);
    const memberName = m ? `${m.firstName} ${m.lastName}`.trim() : "Member";
    const u = p.requestingUserId ? userById.get(p.requestingUserId) : undefined;
    const requester = u
      ? { name: `${u.firstName} ${u.lastName}`.trim(), email: u.email }
      : p.requestingUserEmail
        ? { name: null, email: p.requestingUserEmail }
        : null;

    if (r.kind === GUARDIAN_LINK_KIND) {
      return {
        id: r.id,
        kind: r.kind,
        memberId: r.memberId,
        memberName,
        requestedAt: r.requestedAt,
        requester,
        relationship: p.relationship ?? null,
      };
    }
    if (r.kind === MEMBERSHIP_PURCHASE_KIND) {
      return {
        id: r.id,
        kind: r.kind,
        memberId: r.memberId,
        memberName,
        requestedAt: r.requestedAt,
        requester,
        planName: (p.membershipId && membershipsById.get(p.membershipId)) || "Membership",
        optionLabel: p.optionLabel ?? null,
        paymentMethod: p.paymentMethod ?? null,
        amount: r.amount != null ? Number(r.amount) : null,
        discountCode: p.discountCode ?? null,
      };
    }
    if (r.kind === INVOICE_SPLIT_KIND) {
      const responder = p.responderUserId ? userById.get(p.responderUserId) : undefined;
      return {
        id: r.id,
        kind: r.kind,
        memberId: r.memberId,
        memberName,
        requestedAt: r.requestedAt,
        requester,
        responderName: responder ? `${responder.firstName} ${responder.lastName}`.trim() : null,
        proposerPercent: typeof p.proposerPercent === "number" ? p.proposerPercent : null,
        responderPercent: typeof p.responderPercent === "number" ? p.responderPercent : null,
      };
    }
    if (r.kind === PRIVATE_PACKAGE_PURCHASE_KIND) {
      return {
        id: r.id,
        kind: r.kind,
        memberId: r.memberId,
        memberName,
        requestedAt: r.requestedAt,
        requester,
        planName: (p.packageId && packagesById.get(p.packageId)) || "Lesson package",
        optionLabel: null,
        paymentMethod: p.paymentMethod ?? null,
        amount: r.amount != null ? Number(r.amount) : null,
        discountCode: p.discountCode ?? null,
      };
    }
    // MEMBERSHIP_CANCEL
    return {
      id: r.id,
      kind: r.kind,
      memberId: r.memberId,
      memberName,
      requestedAt: r.requestedAt,
      requester,
      optionLabel: p.optionLabel ?? null,
      reason: p.reason ?? null,
      amount: r.amount != null ? Number(r.amount) : null,
    };
  });

  // Migration BILLING approvals: members who activated + saved a card (or chose
  // cash/check) and are awaiting the owner to approve and start their
  // membership. These live on the Member row (migrationStatus=ACTIVATED,
  // approvalStatus=PENDING_APPROVAL), NOT as PendingApproval rows — which is why
  // they only showed in the migration tool before. Surface them here too.
  // Gated by members:edit (the approve action route enforces the same).
  type MigrationApproval = {
    id: string;
    kind: "MIGRATION_BILLING";
    memberId: string;
    memberName: string;
    requestedAt: Date;
    optionLabel: string;
    price: number | null;
    billingPeriod: string;
    paymentMethod: string | null;
    requestedBillingDate: string | null;
    requestedCancellationDate: string | null;
  };
  let migrationApprovals: MigrationApproval[] = [];
  if (isOwner || hasPermission(perms, "members", "edit")) {
    const pendingMembers = await prisma.member.findMany({
      where: {
        clubId,
        deletedAt: null,
        migrationStatus: MIGRATION_STATUS.ACTIVATED,
        approvalStatus: "PENDING_APPROVAL",
      },
      orderBy: { activatedAt: "desc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        activatedAt: true,
        migrationSelectedOption: true,
        migrationPriceOverride: true,
        legacyMembershipName: true,
        legacyMembershipPrice: true,
        legacyBillingFrequency: true,
        requestedPaymentMethod: true,
        requestedBillingDate: true,
        requestedCancellationDate: true,
      },
    });
    migrationApprovals = pendingMembers.map((m) => {
      const sel =
        (m.migrationSelectedOption as { label?: unknown; price?: unknown; billingPeriod?: unknown } | null) ?? null;
      const price =
        m.migrationPriceOverride != null
          ? Number(m.migrationPriceOverride)
          : sel && typeof sel.price === "number"
            ? sel.price
            : m.legacyMembershipPrice != null
              ? Number(m.legacyMembershipPrice)
              : null;
      const optionLabel =
        (sel && typeof sel.label === "string" && sel.label) || m.legacyMembershipName || "Membership";
      const billingPeriod =
        (sel && typeof sel.billingPeriod === "string" && sel.billingPeriod) || m.legacyBillingFrequency || "MONTHLY";
      return {
        id: `migration:${m.id}`,
        kind: "MIGRATION_BILLING" as const,
        memberId: m.id,
        memberName: `${m.firstName} ${m.lastName}`.trim(),
        requestedAt: m.activatedAt ?? new Date(),
        optionLabel,
        price,
        billingPeriod,
        paymentMethod: m.requestedPaymentMethod ?? null,
        requestedBillingDate: m.requestedBillingDate ? m.requestedBillingDate.toISOString() : null,
        requestedCancellationDate: m.requestedCancellationDate ? m.requestedCancellationDate.toISOString() : null,
      };
    });
  }

  const approvals = [...pendingApprovals, ...migrationApprovals].sort(
    (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
  );

  return NextResponse.json({ approvals });
}
