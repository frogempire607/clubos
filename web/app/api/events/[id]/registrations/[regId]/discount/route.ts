import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { resolveStaffDiscount } from "@/lib/staffPayments";
import { recordDiscountUse } from "@/lib/discounts";
import {
  grossExpectedAmount,
  pricingLockReason,
  isCanceledRegistration,
  collectionBreakdown,
} from "@/lib/eventRepricing";
import { registrationDiscountFields, discountLineLabel } from "@/lib/eventDiscounts";

// POST /api/events/[id]/registrations/[regId]/discount
// Staff applying (or clearing) a discount code on someone's behalf from the
// event roster — the "they told me on the phone they have the sibling code"
// case, and the fix path when a family registered without entering it.
//
// Rewrites what a family will be billed, so it is gated exactly like the
// reprice route (events:edit) and refuses any registration whose money is
// already committed. Nothing here talks to Stripe and nothing emails anyone:
// it changes what a FUTURE invoice says. Re-send the payment link afterwards.
//
// No stacking: the five discount columns are overwritten wholesale every time,
// so applying a second code REPLACES the first rather than adding to it.
const bodySchema = z.object({
  // null / "" clears the discount and restores the full price.
  discountCode: z.string().max(50).optional().nullable(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string; regId: string }> },
) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    }
    throw err;
  }

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const reg = await prisma.eventRegistration.findFirst({
    where: { id: params.regId, eventId: event.id, clubId: session.user.clubId },
  });
  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  if (isCanceledRegistration(reg)) {
    return NextResponse.json({ error: "This registration was removed." }, { status: 409 });
  }

  // Same lock rule the reprice route uses: once money is committed against a
  // number, changing the number underneath it desyncs a Stripe authorization,
  // a recorded Transaction, or a receipt already in someone's inbox.
  const lock = pricingLockReason(reg);
  if (lock) {
    return NextResponse.json(
      {
        error: "REGISTRATION_LOCKED",
        message: `Can't change the discount — ${lock}. Void or refund that payment first.`,
      },
      { status: 409 },
    );
  }

  const check = await resolveStaffDiscount(session.user.clubId, body.discountCode, {
    type: "EVENT",
    eventId: event.id,
  });
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const discount = check.discount;

  // Apply to the event's CURRENT price, not the figure the row is carrying —
  // a stale snapshot must not become the base a discount is taken off.
  const activeCount = await prisma.eventRegistration.count({
    where: { eventId: event.id, status: { not: "CANCELED" } },
  });
  const gross = grossExpectedAmount(event, activeCount);
  if (!(gross > 0)) {
    return NextResponse.json(
      { error: "This event has no price to discount yet — set a price first." },
      { status: 400 },
    );
  }

  const fields = registrationDiscountFields(
    discount ? { id: discount.id, code: discount.code, type: discount.type, value: discount.value } : null,
    gross,
  );

  const before = {
    amountDue: reg.amountDue == null ? null : Number(reg.amountDue),
    discountCode: reg.discountCode ?? null,
  };

  // Guarded on the row still being repriceable so a payment landing mid-request
  // can't be overwritten.
  const res = await prisma.eventRegistration.updateMany({
    where: {
      id: reg.id,
      clubId: session.user.clubId,
      status: { notIn: ["PAID", "SCHEDULED", "CANCELED", "AWAITING_CASH", "AWAITING_CHECK"] },
      transactionId: null,
    },
    data: fields,
  });
  if (res.count === 0) {
    return NextResponse.json(
      { error: "That registration was just settled — reload the roster." },
      { status: 409 },
    );
  }

  // Count the redemption only when a NEW code landed. Re-applying the same code
  // (a double-click, or staff re-saving the row) must not burn a second use.
  if (discount && discount.code !== before.discountCode) {
    await recordDiscountUse(discount.id);
  }

  await writeBillingAudit({
    clubId: session.user.clubId,
    memberId: reg.memberId,
    actorUserId: session.user.id ?? null,
    action: "EVENT_REGISTRATION_DISCOUNT_SET",
    before: { registrationId: reg.id, name: reg.name, ...before },
    after: {
      registrationId: reg.id,
      name: reg.name,
      amountDue: fields.amountDue,
      discountCode: fields.discountCode,
      discountAmount: fields.discountAmount,
    },
    note: discount
      ? `Applied ${discountLineLabel(discount)} to ${reg.name} on ${event.name}. No money moved.`
      : `Cleared the discount on ${reg.name} for ${event.name}. No money moved.`,
  });

  const updated = { ...reg, ...fields };
  return NextResponse.json({
    ok: true,
    registrationId: reg.id,
    discountCode: fields.discountCode,
    discountAmount: fields.discountAmount,
    amountDue: fields.amountDue,
    breakdown: collectionBreakdown(event, updated, activeCount),
    // Staff must re-send the link: the old one still points at the old amount.
    reinvoiceNeeded: reg.invoiceCount > 0,
  });
}
