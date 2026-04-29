import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import type Stripe from "stripe";

export async function POST(req: Request) {
  const body = await req.text();
  const sig = headers().get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {

      // ── Stripe Connect account status sync ─────────────────────────────────
      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        await prisma.club.updateMany({
          where: { stripeAccountId: account.id },
          data: {
            stripeOnboardingComplete: account.details_submitted ?? false,
            stripeChargesEnabled:     account.charges_enabled  ?? false,
            stripePayoutsEnabled:     account.payouts_enabled  ?? false,
          },
        });
        break;
      }

      // ── Checkout completed — membership purchase or event charge ───────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const memberSubscriptionId = session.metadata?.memberSubscriptionId;
        const memberId  = session.metadata?.memberId;
        const clubId    = session.metadata?.clubId || "";
        const eventId   = session.metadata?.eventId;
        const saleId    = session.metadata?.saleId; // product sale

        // ── Membership checkout ──────────────────────────────────────────────
        if (memberSubscriptionId) {
          const memberSub = await prisma.memberSubscription.findUnique({
            where: { id: memberSubscriptionId },
          });

          if (memberSub) {
            const now = new Date();
            const startDate = memberSub.startDate ?? now;

            // For one-time purchases there is no session.subscription
            if (session.mode === "payment") {
              // Compute endDate from the billing period snapshot
              let endDate = memberSub.endDate; // may already be set from subscribe route
              if (!endDate && memberSub.billingPeriod) {
                endDate = computeEndDateFromPeriod(startDate, memberSub.billingPeriod);
              }

              await prisma.memberSubscription.update({
                where: { id: memberSubscriptionId },
                data: {
                  status:    "active",
                  startedAt: now,
                  startDate,
                  endDate,
                },
              });
            }

            // For recurring subscriptions Stripe gives us a subscription ID
            if (session.mode === "subscription" && session.subscription) {
              await prisma.memberSubscription.update({
                where: { id: memberSubscriptionId },
                data: {
                  stripeSubscriptionId: session.subscription as string,
                  status:    "active",
                  startedAt: now,
                  startDate,
                  // endDate remains null for open-ended recurring subs
                },
              });
            }

            // Record a transaction for the initial purchase in both cases
            if (memberId && session.amount_total && session.amount_total > 0) {
              await prisma.transaction.create({
                data: {
                  clubId,
                  memberId,
                  amount:  session.amount_total / 100,
                  status:  "SUCCEEDED",
                  stripePaymentIntentId: session.payment_intent as string | undefined,
                  description: `Membership purchase: ${memberSub.optionLabel}`,
                  type: "MEMBERSHIP",
                },
              });
            }
          }
        }

        // ── Event charge checkout ────────────────────────────────────────────
        if (memberId && eventId) {
          await prisma.transaction.create({
            data: {
              clubId,
              memberId,
              amount:  (session.amount_total || 0) / 100,
              status:  "SUCCEEDED",
              stripePaymentIntentId: session.payment_intent as string,
              description: `Event booking: ${session.metadata?.eventName || ""}`,
              type: "EVENT",
            },
          });
        }

        // ── Product sale checkout ────────────────────────────────────────────
        if (saleId) {
          await prisma.productSale.update({
            where: { id: saleId },
            data: {
              status: "COMPLETED",
              stripePaymentIntentId: session.payment_intent as string | undefined,
            },
          });

          // Decrement inventory
          const sale = await prisma.productSale.findUnique({ where: { id: saleId }, include: { product: true } });
          if (sale?.product.trackInventory && sale.product.inventory !== null) {
            await prisma.product.update({
              where: { id: sale.productId },
              data: { inventory: { decrement: sale.quantity } },
            });
          }
        }

        break;
      }

      // ── Recurring invoice paid (renewal) ───────────────────────────────────
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string | null;
        if (!subscriptionId) break;

        const memberSub = await prisma.memberSubscription.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
          include: { member: true },
        });
        if (!memberSub) break;

        await prisma.transaction.create({
          data: {
            clubId:  memberSub.member.clubId,
            memberId: memberSub.memberId,
            amount:  (invoice.amount_paid || 0) / 100,
            status:  "SUCCEEDED",
            stripePaymentIntentId: invoice.payment_intent as string,
            stripeInvoiceId: invoice.id,
            description: `Membership renewal: ${memberSub.optionLabel}`,
            type: "MEMBERSHIP",
          },
        });

        // Keep status active on renewal
        await prisma.memberSubscription.update({
          where: { id: memberSub.id },
          data: { status: "active" },
        });
        break;
      }

      // ── Payment failed ─────────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string | null;
        if (subscriptionId) {
          await prisma.memberSubscription.updateMany({
            where: { stripeSubscriptionId: subscriptionId },
            data: { status: "past_due" },
          });
        }
        break;
      }

      // ── Subscription canceled (auto-renew off or explicit cancel) ──────────
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await prisma.memberSubscription.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { status: "canceled", canceledAt: new Date() },
        });
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** Compute endDate from a startDate + billingPeriod string */
function computeEndDateFromPeriod(start: Date, period: string): Date {
  const d = new Date(start);
  switch (period) {
    case "WEEKLY":      d.setDate(d.getDate() + 7);          break;
    case "MONTHLY":     d.setMonth(d.getMonth() + 1);        break;
    case "QUARTERLY":   d.setMonth(d.getMonth() + 3);        break;
    case "SEMI_ANNUAL": d.setMonth(d.getMonth() + 6);        break;
    case "ANNUAL":      d.setFullYear(d.getFullYear() + 1);  break;
    default:            d.setFullYear(d.getFullYear() + 1);  break;
  }
  return d;
}
