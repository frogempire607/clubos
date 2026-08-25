import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { MEMBERSHIP_CHANGE_KIND } from "@/lib/approvals";

// POST /api/approvals/membership-change
//
// Close a member's membership-change request.
//
// This deliberately performs NO billing action. The request is an ask, and the
// change itself is made in the billing centre where the owner can see the
// proration, the commitment and the Stripe object before touching anything.
// Auto-executing here would mean editing a live subscription from a queue —
// including, for a period change, editing a Stripe billing interval in place,
// which this project has already decided is unsafe.
//
// So APPROVE means "handled", not "applied". The response carries the billing
// centre link so the next step is one click away.
const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
  note: z.string().max(1000).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Reading the queue rides billing:view; closing an item is a billing
  // decision about what the family will be charged.
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const clubId = session.user.clubId;
  const approval = await prisma.pendingApproval.findFirst({
    where: { id: body.approvalId, clubId, kind: MEMBERSHIP_CHANGE_KIND, status: "PENDING" },
    select: { id: true, memberId: true },
  });
  if (!approval) return NextResponse.json({ error: "Request not found." }, { status: 404 });

  await prisma.pendingApproval.update({
    where: { id: approval.id },
    data: {
      status: body.decision === "APPROVE" ? "APPROVED" : "DECLINED",
      respondedAt: new Date(),
      respondedById: session.user.id,
    },
  });

  return NextResponse.json({
    ok: true,
    approved: body.decision === "APPROVE",
    billingUrl: `/dashboard/members/${approval.memberId}/billing`,
    message:
      body.decision === "APPROVE"
        ? "Marked handled. Make the actual change in the billing centre — nothing was billed from here."
        : "Request declined. The member's membership is unchanged.",
  });
}
