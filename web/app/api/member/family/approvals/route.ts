import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/family/approvals
//
// Returns every PENDING parental-approval row across the guardian's
// linked children. Powers the small "Pending approvals" card on
// /member/profile (and is the data source the Approve/Decline buttons
// post against, by id).
//
// Guardian gate: scope by `guardianOf` (MemberGuardianUser) so a member
// can never see another family's approvals. A member who is not a
// guardian of anyone just gets an empty list.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const viewer = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      guardianOf: { select: { memberId: true } },
    },
  });
  const childIds = (viewer?.guardianOf ?? []).map((g) => g.memberId);
  if (childIds.length === 0) {
    return NextResponse.json({ approvals: [] });
  }

  const rows = await prisma.pendingApproval.findMany({
    where: {
      clubId: session.user.clubId,
      memberId: { in: childIds },
      status: "PENDING",
    },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      kind: true,
      payload: true,
      amount: true,
      requestedAt: true,
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  return NextResponse.json({
    approvals: rows.map((r) => ({
      ...r,
      amount: r.amount == null ? null : Number(r.amount),
    })),
  });
}
