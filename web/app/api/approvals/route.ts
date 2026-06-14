import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";
import { MEMBERSHIP_CANCEL_KIND } from "@/lib/approvals";

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
  if (isOwner || hasPermission(perms, "members", "view")) kinds.push(GUARDIAN_LINK_KIND);
  if (isOwner || hasPermission(perms, "finances", "view")) kinds.push(MEMBERSHIP_CANCEL_KIND);
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
    new Set(rows.map((r) => (r.payload as Payload | null)?.requestingUserId).filter(Boolean) as string[]),
  );
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const approvals = rows.map((r) => {
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

  return NextResponse.json({ approvals });
}
