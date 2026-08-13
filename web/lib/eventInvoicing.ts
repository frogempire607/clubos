// Send ONE registrant a payment link — the single implementation.
//
// This was the body of the loop inside POST /api/events/[id]/bill-registrants.
// Phase 5 §5.4.6 gives it a second caller: approving a registration whose
// payment intent is INVOICE bills that one person immediately, and §5.6's
// escalation cron re-bills the same way. The plan is explicit that
// bill-registrants must not be forked (§5.0: "the automatic escalation cron
// calls the same code path per-registrant"), so the mass route now calls this
// too rather than keeping a second copy that can drift.
//
// What deliberately stayed in the route: choosing WHO to bill, the per-head
// split math, the preview payload, and the AMOUNT_MISMATCH confirmation gate.
// Those are decisions about a whole event. This function is handed a resolved
// net amount and does not compute a price — the caller resolves it through
// lib/eventRepricing, which is what keeps the preview the owner approved
// identical to what actually gets emailed.

import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendEmail } from "@/lib/email";
import { registrationReturnUrl } from "@/lib/registrationUrl";

export type BillOneRegistrantArgs = {
  event: {
    id: string;
    clubId: string;
    name: string;
    publicSlug?: string | null;
    isTournament?: boolean | null;
  };
  club: { stripeAccountId: string; tier: string; passProcessingFees: boolean };
  registration: { id: string; name: string };
  recipientEmail: string;
  /** NET of any discount. Resolved by the caller through lib/eventRepricing. */
  amount: number;
  discountCode?: string | null;
  discountOff?: number;
  /** Line-item description: "Event registration", or the variable-cost split note. */
  lineNote: string;
  /** Stripe product name — "<event>" or "<event> — cost share". */
  productName: string;
  /** SHARE renders "your share … (<split note>)"; FEE renders "your registration fee". */
  kind?: "FEE" | "SHARE";
  /** Optional itemized table rendered in the email body. */
  breakdownHtml?: string;
  /** getAppBaseUrl() from cron/jobs; baseUrlFromRequest(req) on request paths. */
  baseUrl: string;
};

export type BillOneRegistrantResult =
  | { ok: true; url: string; sessionId: string }
  | { ok: false; error: string };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function billOneRegistrant(args: BillOneRegistrantArgs): Promise<BillOneRegistrantResult> {
  const { event, club, registration: reg, recipientEmail, amount, baseUrl } = args;
  const amountCents = Math.round(amount * 100);
  if (amountCents <= 0) {
    return { ok: false, error: "no price to collect — set a price on the event first" };
  }

  const code = args.discountCode ?? null;
  const off = args.discountOff ?? 0;
  const discountNote = code ? ` · ${code} applied — $${off.toFixed(2)} off` : "";

  // The live confirmation surface either way — it reads the row, so it is
  // correct whether the payer completed the checkout, abandoned it, or opened
  // the link a week later. This replaced a split between the public event page
  // (which rendered success from a query parameter) and /pay/complete (which
  // existed only because `/e/${publicSlug ?? ""}` 404s on an event with no
  // slug). One address, one truth.
  const returnUrl = (outcome: "paid" | "canceled") =>
    registrationReturnUrl(baseUrl, event, reg.id, outcome);

  let checkout: { id: string; url: string | null };
  try {
    checkout = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: recipientEmail,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: amountCents,
              product_data: {
                name: args.productName,
                description: args.lineNote + discountNote,
              },
            },
          },
          ...(() => {
            const fi = processingFeeLineItem(amountCents, club.passProcessingFees);
            return fi ? [fi] : [];
          })(),
        ],
        success_url: returnUrl("paid"),
        cancel_url: returnUrl("canceled"),
        payment_intent_data: {
          application_fee_amount: calculatePlatformFee(amountCents, club.tier),
          metadata: { eventRegistrationId: reg.id, eventId: event.id, clubId: event.clubId },
        },
        metadata: {
          eventRegistrationId: reg.id,
          eventId: event.id,
          clubId: event.clubId,
          ...(code ? { discountCode: code, discountAmount: String(off) } : {}),
        },
      },
      { stripeAccount: club.stripeAccountId },
    );
  } catch (e) {
    return { ok: false, error: String(e) };
  }

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
      to: recipientEmail,
      subject: `Payment due for ${event.name}`,
      html: `
            <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto">
              <h2 style="color:#1c1917">${escapeHtml(args.productName)}</h2>
              <p style="color:#57534e;line-height:1.6">
                Hi ${escapeHtml(reg.name)}, your ${args.kind === "SHARE" ? "share" : "registration fee"} for <strong>${escapeHtml(event.name)}</strong> is
                <strong>$${amount.toFixed(2)}</strong>${args.kind === "SHARE" ? ` (${escapeHtml(args.lineNote)})` : ""}.
              </p>
              ${
                code
                  ? `<p style="color:#4d7c0f;line-height:1.6;margin:-8px 0 16px">Discount <strong>${escapeHtml(code)}</strong> applied — $${off.toFixed(2)} off.</p>`
                  : ""
              }
              ${args.breakdownHtml ?? ""}
              <p><a href="${checkout.url}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Pay now</a></p>
            </div>`,
    });
  } catch (e) {
    // The link is live and stored on the row either way — the roster can
    // re-send it. A dead SMTP must not read as "this registrant was not billed".
    console.error("Bill-registrant email failed:", e);
  }

  return { ok: true, url: checkout.url ?? "", sessionId: checkout.id };
}
