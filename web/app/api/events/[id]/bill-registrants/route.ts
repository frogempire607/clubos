import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { publicFixedPrice } from "@/lib/eventPricing";

const bodySchema = z.object({
  // Re-invoice registrants who were already invoiced (still skips PAID).
  force: z.boolean().optional().default(false),
  // Invoice only these registrations. When omitted, invoice every active,
  // unpaid registrant who hasn't been invoiced yet (or all of them if force).
  registrationIds: z.array(z.string()).optional(),
});

// POST /api/events/[id]/bill-registrants
// Mass-invoice event registrants.
//
// Variable-cost events (both modes):
//   OFFICIAL  — split variableCostTotal across actual active registrants
//               (the "bill after the event" flow).
//   ESTIMATED — split the estimated shared total by expected signups
//               (the "bill before the event when you choose" flow).
//
// Fixed-price events: a public registrant is recorded BEFORE Stripe Checkout,
// so an abandoned checkout leaves a REGISTERED row owing the price with no
// way to pay. This route emails each unpaid registrant a fresh payment link
// for their recorded amountDue (falling back to the event's public price).
//
// Owner/staff trigger this whenever they're ready; payment never has to
// happen at registration time.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: { club: true },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isVariable = !!event.variableCostEnabled;
  if (!event.club.stripeAccountId || !event.club.stripeChargesEnabled) {
    return NextResponse.json(
      { error: "Connect Stripe before sending invoices." },
      { status: 400 },
    );
  }

  const mode = event.variableCostMode === "OFFICIAL" ? "OFFICIAL" : "ESTIMATED";

  const allActive = await prisma.eventRegistration.findMany({
    where: { eventId: event.id, status: { not: "CANCELED" } },
  });
  const activeCount = allActive.length;
  if (activeCount === 0) {
    return NextResponse.json({ error: "No active registrations to invoice." }, { status: 400 });
  }

  // Fixed-price events: each registrant owes their recorded amountDue (set at
  // registration), falling back to the event's current public price.
  const fixedPrice = isVariable ? 0 : publicFixedPrice(event);

  // Divisor: actual attendees (OFFICIAL) or expected signups (ESTIMATED).
  const divisor =
    !isVariable || mode === "OFFICIAL"
      ? activeCount
      : event.variableCostEstimatedSignups && event.variableCostEstimatedSignups > 0
        ? event.variableCostEstimatedSignups
        : activeCount;

  // Itemized expense breakdown (P1) takes precedence when present: per-athlete
  // items are charged in full to each registrant; shared items are split across
  // the divisor. With no items, behavior is unchanged (single variableCostTotal).
  const expenseItems = isVariable
    ? await prisma.eventExpenseItem.findMany({
        where: { eventId: event.id, clubId: event.clubId },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const perAthleteSum = expenseItems
    .filter((i) => i.perAthlete)
    .reduce((s, i) => s + Number(i.amount), 0);
  const sharedSum = expenseItems
    .filter((i) => !i.perAthlete)
    .reduce((s, i) => s + Number(i.amount), 0);
  const itemsSum = perAthleteSum + sharedSum;

  let total: number | null = null;
  let perHead: number | null = null;
  if (!isVariable) {
    // Per-registrant amounts resolve inside the send loop (amountDue first).
    perHead = fixedPrice > 0 ? fixedPrice : null;
  } else if (itemsSum > 0) {
    perHead = +(perAthleteSum + sharedSum / divisor).toFixed(2);
    total = +(perAthleteSum * divisor + sharedSum).toFixed(2);
  } else if (mode === "OFFICIAL") {
    if (!event.variableCostTotal || Number(event.variableCostTotal) <= 0) {
      return NextResponse.json(
        { error: "Set the official total cost (or add expense items) before sending invoices." },
        { status: 400 },
      );
    }
    total = Number(event.variableCostTotal);
    perHead = +(total / divisor).toFixed(2);
  } else {
    // ESTIMATED: prefer the entered total, fall back to the display estimate.
    const estTotal =
      event.variableCostTotal != null
        ? Number(event.variableCostTotal)
        : event.variableCostEstimatedTotal != null
          ? Number(event.variableCostEstimatedTotal)
          : 0;
    if (estTotal <= 0) {
      return NextResponse.json(
        { error: "Set an estimated total cost (or add expense items) before sending invoices." },
        { status: 400 },
      );
    }
    total = estTotal;
    perHead = +(total / divisor).toFixed(2);
  }

  if (isVariable && (perHead == null || Math.round(perHead * 100) <= 0)) {
    return NextResponse.json({ error: "Computed share is $0 — check the total and split." }, { status: 400 });
  }

  // Decide which registrants to invoice.
  let targets = allActive.filter((r) => r.status !== "PAID");
  if (body.registrationIds && body.registrationIds.length > 0) {
    const idSet = new Set(body.registrationIds);
    targets = targets.filter((r) => idSet.has(r.id));
  } else if (!body.force) {
    // Default: only registrants who haven't been invoiced yet.
    targets = targets.filter((r) => r.invoiceCount === 0);
  }

  if (targets.length === 0) {
    return NextResponse.json(
      { error: "No matching unpaid registrants to invoice. Use re-send to invoice everyone still unpaid." },
      { status: 400 },
    );
  }

  const baseUrl = getAppBaseUrl();
  const splitNote = !isVariable
    ? "Event registration"
    : itemsSum > 0
      ? `Your share across ${divisor} attendee${divisor === 1 ? "" : "s"}`
      : mode === "OFFICIAL"
        ? `Official split: $${(total ?? 0).toFixed(2)} ÷ ${activeCount} attendees`
        : `Estimated split: $${(total ?? 0).toFixed(2)} ÷ ${divisor} attendees`;

  // Parent-facing breakdown (same per-head for every registrant): per-athlete
  // items at full price, shared items shown as their per-head split.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const breakdownHtml = expenseItems.length
    ? `<table style="width:100%;border-collapse:collapse;margin:4px 0 16px;font-size:14px"><tbody>${expenseItems
        .map((i) => {
          const each = i.perAthlete ? Number(i.amount) : Number(i.amount) / divisor;
          const tag = i.perAthlete ? "per athlete" : `split ÷ ${divisor}`;
          return `<tr><td style="padding:4px 0;color:#57534e">${esc(i.label)}${
            i.description ? ` <span style="color:#a8a29e">— ${esc(i.description)}</span>` : ""
          } <span style="color:#a8a29e">(${tag})</span></td><td style="padding:4px 0;text-align:right;color:#1c1917;white-space:nowrap">$${each.toFixed(2)}</td></tr>`;
        })
        .join(
          "",
        )}</tbody><tfoot><tr><td style="padding-top:8px;border-top:1px solid #e7e5e4;color:#1c1917;font-weight:600">Your total</td><td style="padding-top:8px;border-top:1px solid #e7e5e4;text-align:right;color:#1c1917;font-weight:600">$${(perHead ?? 0).toFixed(
        2,
      )}</td></tr></tfoot></table>`
    : "";

  let billed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const reg of targets) {
    if (reg.status === "PAID") {
      skipped++;
      continue;
    }
    if (!reg.email) {
      errors.push(`${reg.name}: no email on file`);
      continue;
    }
    // Fixed-price: what they owed at registration wins; fall back to the
    // event's current public price for rows recorded before a price was set.
    const amount = isVariable
      ? (perHead as number)
      : reg.amountDue && Number(reg.amountDue) > 0
        ? Number(reg.amountDue)
        : fixedPrice;
    const amountCents = Math.round(amount * 100);
    if (amountCents <= 0) {
      errors.push(`${reg.name}: no price to collect — set a price on the event first`);
      continue;
    }
    try {
      const checkout = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer_email: reg.email,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: amountCents,
                product_data: {
                  name: isVariable ? `${event.name} — cost share` : event.name,
                  description: isVariable
                    ? splitNote
                    : event.isTournament
                      ? "Tournament registration"
                      : "Event registration",
                },
              },
            },
            ...(() => {
              const fi = processingFeeLineItem(amountCents, event.club.passProcessingFees);
              return fi ? [fi] : [];
            })(),
          ],
          success_url: `${baseUrl}/e/${event.publicSlug ?? ""}?paid=true`,
          cancel_url: `${baseUrl}/e/${event.publicSlug ?? ""}?canceled=true`,
          payment_intent_data: {
            application_fee_amount: calculatePlatformFee(amountCents, event.club.tier),
            metadata: { eventRegistrationId: reg.id, eventId: event.id, clubId: event.clubId },
          },
          metadata: { eventRegistrationId: reg.id, eventId: event.id, clubId: event.clubId },
        },
        { stripeAccount: event.club.stripeAccountId },
      );

      await prisma.eventRegistration.update({
        where: { id: reg.id },
        data: {
          amountDue: amount,
          paymentUrl: checkout.url,
          stripeCheckoutSessionId: checkout.id,
          invoicedAt: new Date(),
          invoiceCount: { increment: 1 },
        },
      });

      try {
        await sendEmail({
          to: reg.email,
          subject: `Payment due for ${event.name}`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto">
              <h2 style="color:#1c1917">${esc(event.name)}${isVariable ? " — cost share" : ""}</h2>
              <p style="color:#57534e;line-height:1.6">
                Hi ${esc(reg.name)}, your ${isVariable ? "share" : "registration fee"} for <strong>${esc(event.name)}</strong> is
                <strong>$${amount.toFixed(2)}</strong>${isVariable ? ` (${splitNote})` : ""}.
              </p>
              ${breakdownHtml}
              <p><a href="${checkout.url}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Pay now</a></p>
            </div>`,
        });
      } catch (e) {
        console.error("Bill-registrant email failed:", e);
      }

      billed++;
    } catch (e) {
      errors.push(`${reg.email}: ${String(e)}`);
    }
  }

  if (isVariable) {
    await prisma.event.update({
      where: { id: event.id },
      data: { variableCostBilledAt: new Date() },
    });
  }

  return NextResponse.json({
    ok: true,
    mode,
    perHead,
    total,
    divisor,
    attendees: activeCount,
    targeted: targets.length,
    billed,
    skipped,
    errors,
  });
}
