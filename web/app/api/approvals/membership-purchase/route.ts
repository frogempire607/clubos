import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { MEMBERSHIP_PURCHASE_KIND } from "@/lib/approvals";
import { findValidDiscount, discountedPrice, recordDiscountUse } from "@/lib/discounts";

// POST /api/approvals/membership-purchase
//
// Owner/staff respond to a member's in-portal cash/check membership request.
// Approving mirrors the owner-side MANUAL assignment: an active MANUAL
// MemberSubscription (no Stripe, no auto-renew), member flips ACTIVE, and an
// unpaid manual invoice Transaction is recorded so the money owed shows up in
// Financials until it's collected. Declining just closes the request.
const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
});

type Payload = {
  membershipId?: string;
  optionLabel?: string;
  paymentMethod?: string;
  requestingUserId?: string;
  discountCode?: string;
};

type Option = { label: string; price: number; billingPeriod: string };

function computeEndDate(start: Date, billingPeriod: string): Date {
  const d = new Date(start);
  switch (billingPeriod) {
    case "WEEKLY":      d.setDate(d.getDate() + 7);   break;
    case "MONTHLY":     d.setMonth(d.getMonth() + 1); break;
    case "QUARTERLY":   d.setMonth(d.getMonth() + 3); break;
    case "SEMI_ANNUAL": d.setMonth(d.getMonth() + 6); break;
    case "ANNUAL":      d.setFullYear(d.getFullYear() + 1); break;
    default:            d.setFullYear(d.getFullYear() + 1); break;
  }
  return d;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Starting a membership + recording money owed is a financial action —
  // same gate as membership cancellations.
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const clubId = session.user.clubId;
  const approval = await prisma.pendingApproval.findFirst({
    where: { id: body.approvalId, clubId, kind: MEMBERSHIP_PURCHASE_KIND, status: "PENDING" },
    include: { member: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!approval) return NextResponse.json({ error: "Request not found or already handled." }, { status: 404 });

  const payload = (approval.payload ?? {}) as Payload;
  const paymentMethod = payload.paymentMethod === "CHECK" ? "CHECK" : "CASH";

  async function close(status: "APPROVED" | "DECLINED") {
    await prisma.pendingApproval.update({
      where: { id: approval!.id },
      data: { status, respondedAt: new Date(), respondedById: session!.user.id },
    });
  }

  async function notifyRequester(text: string) {
    if (!payload.requestingUserId) return;
    await prisma.message
      .create({
        data: {
          clubId,
          senderId: session!.user.id,
          recipientId: payload.requestingUserId,
          body: text,
        },
      })
      .catch(() => {});
  }

  const who = `${approval.member.firstName} ${approval.member.lastName}`.trim();

  if (body.decision === "DECLINE") {
    await close("DECLINED");
    await notifyRequester(
      `Your ${paymentMethod.toLowerCase()} membership request for ${who} wasn't approved. Reach out to the club if you have questions.`,
    );
    return NextResponse.json({ ok: true, declined: true });
  }

  // APPROVE — re-resolve the plan/option so a since-edited membership can't
  // activate at a stale price.
  const membership = payload.membershipId
    ? await prisma.membership.findFirst({
        where: { id: payload.membershipId, clubId, deletedAt: null },
      })
    : null;
  if (!membership) {
    return NextResponse.json(
      { error: "The requested membership no longer exists. Decline this request and have them re-purchase." },
      { status: 400 },
    );
  }
  let options: Option[] = [];
  try { options = JSON.parse(String(membership.options)); } catch {}
  const option = options.find((o) => o.label === payload.optionLabel);
  if (!option) {
    return NextResponse.json(
      { error: "The requested pricing option no longer exists on that membership. Decline and have them re-purchase." },
      { status: 400 },
    );
  }

  // Re-validate the discount the member requested with — approving IS the
  // staff sign-off on the discounted price. If the code died since the
  // request, surface that instead of silently charging full price.
  let discount = null as import("@/lib/discounts").ValidDiscount | null;
  if (payload.discountCode) {
    const check = await findValidDiscount(clubId, payload.discountCode, membership.id);
    if (!check.ok) {
      return NextResponse.json(
        { error: `This request used discount code ${payload.discountCode}, but it's no longer valid (${check.error}) Decline the request and have them re-purchase.` },
        { status: 400 },
      );
    }
    discount = check.discount;
  }
  const finalPrice = discount ? discountedPrice(option.price, discount) : option.price;

  const startDate = new Date();
  const isOneTime = option.billingPeriod === "ONE_TIME";
  await prisma.memberSubscription.create({
    data: {
      memberId: approval.memberId,
      membershipId: membership.id,
      optionLabel: option.label,
      price: finalPrice,
      billingPeriod: option.billingPeriod,
      billingType: "MANUAL",
      startDate,
      endDate: isOneTime ? computeEndDate(startDate, option.billingPeriod) : null,
      autoRenew: false,
      status: "active",
      startedAt: new Date(),
      discountCode: discount?.code || null,
      notes: `In-portal ${paymentMethod.toLowerCase()} purchase approved by staff.${discount ? ` Discount ${discount.code} applied.` : ""}`,
    },
  });
  if (discount) await recordDiscountUse(discount.id);
  await prisma.member.update({
    where: { id: approval.memberId },
    data: { membershipId: membership.id },
  });
  await recomputeMemberStatus(approval.memberId, clubId);

  // Money owed until collected: an unpaid manual invoice keeps it visible in
  // Financials (Invoiced/unpaid channel) without claiming revenue was taken.
  if (finalPrice > 0) {
    await prisma.transaction.create({
      data: {
        clubId,
        memberId: approval.memberId,
        amount: finalPrice,
        status: "PENDING",
        type: "INVOICE",
        category: "memberships",
        paymentMethod,
        description: `Membership (${paymentMethod.toLowerCase()}): ${membership.name} — ${option.label}${discount ? ` (code ${discount.code})` : ""}`,
        manual: true,
        txDate: new Date(),
      },
    });
  }

  await close("APPROVED");
  await notifyRequester(
    `Your membership for ${who} (${membership.name} — ${option.label}) is active. The club will collect your ${paymentMethod.toLowerCase()} payment.`,
  );
  return NextResponse.json({ ok: true, activated: true });
}
