import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendEmail } from "@/lib/email";

const bodySchema = z.object({
  // Re-invoice registrants who were already invoiced (still skips PAID).
  force: z.boolean().optional().default(false),
  // Invoice only these registrations. When omitted, invoice every active,
  // unpaid registrant who hasn't been invoiced yet (or all of them if force).
  registrationIds: z.array(z.string()).optional(),
});

// POST /api/events/[id]/bill-registrants
// Mass-invoice event registrants for a variable-cost event. Works for BOTH:
//   OFFICIAL  — split variableCostTotal across actual active registrants
//               (the "bill after the event" flow).
//   ESTIMATED — split the estimated shared total by expected signups
//               (the "bill before the event when you choose" flow).
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

  if (!event.variableCostEnabled) {
    return NextResponse.json(
      { error: "This event isn't set up for variable-cost billing." },
      { status: 400 },
    );
  }
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

  // Resolve the per-head amount based on mode.
  let total: number;
  let divisor: number;
  if (mode === "OFFICIAL") {
    if (!event.variableCostTotal || Number(event.variableCostTotal) <= 0) {
      return NextResponse.json(
        { error: "Set the official total cost on the event before sending invoices." },
        { status: 400 },
      );
    }
    total = Number(event.variableCostTotal);
    divisor = activeCount;
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
        { error: "Set an estimated total cost on the event before sending invoices." },
        { status: 400 },
      );
    }
    total = estTotal;
    divisor =
      event.variableCostEstimatedSignups && event.variableCostEstimatedSignups > 0
        ? event.variableCostEstimatedSignups
        : activeCount;
  }

  const perHead = +(total / divisor).toFixed(2);
  const amountCents = Math.round(perHead * 100);
  if (amountCents <= 0) {
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

  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
  const splitNote =
    mode === "OFFICIAL"
      ? `Official split: $${total.toFixed(2)} ÷ ${activeCount} attendees`
      : `Estimated split: $${total.toFixed(2)} ÷ ${divisor} attendees`;

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
                  name: `${event.name} — cost share`,
                  description: splitNote,
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
          amountDue: perHead,
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
              <h2 style="color:#1c1917">${event.name} — cost share</h2>
              <p style="color:#57534e;line-height:1.6">
                Hi ${reg.name}, your share for <strong>${event.name}</strong> is
                <strong>$${perHead.toFixed(2)}</strong> (${splitNote}).
              </p>
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

  await prisma.event.update({
    where: { id: event.id },
    data: { variableCostBilledAt: new Date() },
  });

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
