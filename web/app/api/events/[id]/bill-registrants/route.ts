import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { sendEmail } from "@/lib/email";

// POST /api/events/[id]/bill-registrants
// For an ATTEND tournament with OFFICIAL variable cost: split the official
// total evenly across all non-canceled registrants and bill each one.
//
// This is the action that runs "on unpublish" — the owner triggers it (the
// Events page also calls it automatically once the event's unpublish date has
// passed). Idempotent via `event.variableCostBilledAt`; pass { force: true }
// to re-bill anyone still unpaid.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = await req
    .json()
    .then((b) => !!b?.force)
    .catch(() => false);

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: { club: true },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!event.variableCostEnabled || event.variableCostMode !== "OFFICIAL") {
    return NextResponse.json(
      { error: "This event isn't set up for official post-tournament billing." },
      { status: 400 }
    );
  }
  if (!event.variableCostTotal || Number(event.variableCostTotal) <= 0) {
    return NextResponse.json({ error: "Set the official total cost first." }, { status: 400 });
  }
  if (event.variableCostBilledAt && !force) {
    return NextResponse.json(
      { error: "Registrants were already billed. Re-run with force to bill anyone still unpaid." },
      { status: 409 }
    );
  }
  if (!event.club.stripeAccountId || !event.club.stripeChargesEnabled) {
    return NextResponse.json(
      { error: "Connect Stripe before billing registrants." },
      { status: 400 }
    );
  }

  const registrations = await prisma.eventRegistration.findMany({
    where: { eventId: event.id, status: { not: "CANCELED" } },
  });
  if (registrations.length === 0) {
    return NextResponse.json({ error: "No active registrations to bill." }, { status: 400 });
  }

  const perHead = +(Number(event.variableCostTotal) / registrations.length).toFixed(2);
  const amountCents = Math.round(perHead * 100);
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";

  let billed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const reg of registrations) {
    if (reg.status === "PAID") {
      skipped++;
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
                  name: `${event.name} — tournament cost share`,
                  description: `Official split: $${Number(event.variableCostTotal).toFixed(2)} ÷ ${registrations.length} attendees`,
                },
              },
            },
          ],
          success_url: `${baseUrl}/e/${event.publicSlug ?? ""}?paid=true`,
          cancel_url: `${baseUrl}/e/${event.publicSlug ?? ""}?canceled=true`,
          payment_intent_data: {
            application_fee_amount: calculatePlatformFee(amountCents, event.club.tier),
            metadata: { eventRegistrationId: reg.id, eventId: event.id, clubId: event.clubId },
          },
          metadata: { eventRegistrationId: reg.id, eventId: event.id, clubId: event.clubId },
        },
        { stripeAccount: event.club.stripeAccountId }
      );

      await prisma.eventRegistration.update({
        where: { id: reg.id },
        data: {
          amountDue: perHead,
          paymentUrl: checkout.url,
          stripeCheckoutSessionId: checkout.id,
        },
      });

      // Email the payment link. Non-fatal if email isn't configured.
      try {
        await sendEmail({
          to: reg.email,
          subject: `Payment due for ${event.name}`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto">
              <h2 style="color:#1c1917">Tournament cost share</h2>
              <p style="color:#57534e;line-height:1.6">
                Hi ${reg.name}, the final cost for <strong>${event.name}</strong> has been
                calculated. Your share is <strong>$${perHead.toFixed(2)}</strong>
                ($${Number(event.variableCostTotal).toFixed(2)} split across ${registrations.length} attendees).
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
    perHead,
    attendees: registrations.length,
    billed,
    skipped,
    errors,
  });
}
