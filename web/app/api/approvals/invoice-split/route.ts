import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { INVOICE_SPLIT_KIND } from "@/lib/approvals";
import { invoiceSplitEnabled } from "@/lib/featureFlags";

// POST /api/approvals/invoice-split
//
// Staff stage of invoice splitting (Client UX Phase 7, behind
// FEATURE_INVOICE_SPLIT). Both guardians already agreed; the club gives the
// final OK. Approving flips the InvoiceSplit ACTIVE; declining closes it.
// Guarding on members:edit — it configures how a member's family is billed
// going forward, not a charge itself.

const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const guard = requirePermission(session, "members", "edit");
  if (guard) return guard;
  if (!invoiceSplitEnabled()) return NextResponse.json({ error: "Not available" }, { status: 404 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const approval = await prisma.pendingApproval.findFirst({
    where: {
      id: data.approvalId,
      clubId: session.user.clubId,
      kind: INVOICE_SPLIT_KIND,
      status: "PENDING",
    },
  });
  if (!approval) return NextResponse.json({ error: "Approval not found" }, { status: 404 });

  const splitId = (approval.payload as { splitId?: string } | null)?.splitId;
  const split = splitId
    ? await prisma.invoiceSplit.findFirst({
        where: { id: splitId, clubId: session.user.clubId },
      })
    : null;
  if (!split || split.status !== "PENDING_STAFF") {
    // Split was revoked or already handled — close the queue row either way.
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: "EXPIRED", respondedAt: new Date(), respondedById: session.user.id },
    });
    return NextResponse.json({ error: "This split is no longer awaiting review." }, { status: 409 });
  }

  const now = new Date();
  const events = Array.isArray(split.events) ? [...split.events] : [];
  events.push({
    at: now.toISOString(),
    byUserId: session.user.id,
    action: data.decision === "APPROVE" ? "STAFF_APPROVED" : "STAFF_DECLINED",
  });

  await prisma.$transaction([
    prisma.invoiceSplit.update({
      where: { id: split.id },
      data: {
        status: data.decision === "APPROVE" ? "ACTIVE" : "DECLINED",
        staffReviewedAt: now,
        staffUserId: session.user.id,
        events: events as Prisma.InputJsonValue,
      },
    }),
    prisma.pendingApproval.update({
      where: { id: approval.id },
      data: {
        status: data.decision === "APPROVE" ? "APPROVED" : "DECLINED",
        respondedAt: now,
        respondedById: session.user.id,
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    message:
      data.decision === "APPROVE"
        ? "Split approved — it's now the family's standing cost arrangement."
        : "Split declined.",
  });
}
