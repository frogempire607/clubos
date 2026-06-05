import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/member/family/approvals/[id]
//
// Body: { action: "APPROVE" | "DECLINE" }
//
// Only the guardian of the row's member can respond. We re-verify the
// guardian link inside the same query that loads the approval so we
// can't be tricked by a forged memberId.

const bodySchema = z.object({
  action: z.enum(["APPROVE", "DECLINE"]),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let action: "APPROVE" | "DECLINE";
  try {
    ({ action } = bodySchema.parse(await req.json()));
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const approval = await prisma.pendingApproval.findFirst({
    where: {
      id: params.id,
      clubId: session.user.clubId,
      status: "PENDING",
      // Guardian gate: only rows whose member is linked to the signed-in
      // user via MemberGuardianUser are loadable.
      member: {
        guardianLinks: { some: { userId: session.user.id } },
      },
    },
    select: { id: true, kind: true, memberId: true },
  });

  if (!approval) {
    // Either the row doesn't exist, it's already been responded to, or
    // the caller isn't the guardian. Don't leak which.
    return NextResponse.json({ error: "Approval not available" }, { status: 404 });
  }

  await prisma.pendingApproval.update({
    where: { id: approval.id },
    data: {
      status: action === "APPROVE" ? "APPROVED" : "DECLINED",
      respondedAt: new Date(),
      respondedById: session.user.id,
    },
  });

  return NextResponse.json({ ok: true });
}
