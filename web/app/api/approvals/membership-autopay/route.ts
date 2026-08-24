import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { MEMBERSHIP_AUTOPAY_KIND } from "@/lib/approvals";
import { turnAutopayOff, turnAutopayOn } from "@/lib/autopay";
import { SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";

// POST /api/approvals/membership-autopay
//
// Owner/staff respond to a member's autopay request (§8.6.3, D8). Approving
// performs the real transition; declining closes the request and changes
// nothing.
//
// `billing:full` — the same gate as the owner-initiated `set_autopay` action,
// because it does the identical thing. A queue you can see is not a queue you
// may act on.
const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
});

type Payload = { subscriptionId?: string; direction?: "on" | "off"; optionLabel?: string | null };

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    where: { id: body.approvalId, clubId, kind: MEMBERSHIP_AUTOPAY_KIND, status: "PENDING" },
    select: { id: true, memberId: true, payload: true },
  });
  if (!approval) return NextResponse.json({ error: "Request not found." }, { status: 404 });

  if (body.decision === "DECLINE") {
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: "DECLINED", respondedAt: new Date(), respondedById: session.user.id },
    });
    return NextResponse.json({ ok: true, approved: false });
  }

  const payload = (approval.payload as Payload | null) ?? {};
  if (!payload.subscriptionId || (payload.direction !== "on" && payload.direction !== "off")) {
    return NextResponse.json({ error: "This request is missing what it asked for." }, { status: 400 });
  }

  const actor = { userId: session.user.id, source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION };
  const result =
    payload.direction === "off"
      ? await turnAutopayOff(payload.subscriptionId, clubId, actor)
      : await turnAutopayOn(payload.subscriptionId, clubId, actor);

  // Hard-fail, leaving the approval PENDING so the owner can retry — the same
  // discipline as the cancellation route. Marking a request approved when the
  // transition did not happen is how a member ends up believing their card was
  // switched off while Stripe keeps billing it.
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: 502 });
  }

  await prisma.pendingApproval.update({
    where: { id: approval.id },
    data: { status: "APPROVED", respondedAt: new Date(), respondedById: session.user.id },
  });

  return NextResponse.json({
    ok: true,
    approved: true,
    direction: result.direction,
    effectiveAt: result.effectiveAt,
    message: result.message,
  });
}
