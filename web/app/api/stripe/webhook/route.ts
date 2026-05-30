import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import {
  sendBookingConfirmationEmail,
  sendMembershipActivatedEmail,
  sendPaymentFailedEmail,
} from "@/lib/email";
import type Stripe from "stripe";
import { getAppBaseUrl } from "@/lib/baseUrl";

// Resolve the best email + first name for a member. Falls back to guardian email
// for minors, then to the linked User account.
async function memberContact(memberId: string): Promise<{ email: string | null; firstName: string; clubName: string }> {
  const m = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      firstName: true,
      email: true,
      isMinor: true,
      guardianEmail: true,
      guardian: { select: { email: true } },
      user: { select: { email: true } },
      club: { select: { name: true } },
    },
  });
  if (!m) return { email: null, firstName: "", clubName: "" };
  const email = m.isMinor
    ? (m.guardian?.email || m.guardianEmail || m.email || m.user?.email || null)
    : (m.email || m.user?.email || m.guardianEmail || null);
  return { email, firstName: m.firstName, clubName: m.club?.name ?? "your club" };
}

function safeAsync(fn: () => Promise<unknown>) {
  fn().catch((err) => console.error("Email send failed:", err));
}

export async function POST(req: Request) {
  // Resolved per-request rather than at module load so a `.env` fix
  // doesn't require a server restart for the webhook to pick it up,
  // matching the pattern every other route in this codebase uses.
  const BASE_URL = getAppBaseUrl();

  const body = await req.text();
  const sig = (await headers()).get("stripe-signature");
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

  // event.account is the connected-account id for Connect events; absent for
  // PLATFORM-level events (ClubOS-own subscription, account.updated for connect
  // onboarding still comes through on platform).
  const source = event.account ? "CONNECT" : "PLATFORM";

  // Idempotency: bail early if we've already processed this event id.
  const existing = await prisma.stripeWebhookEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { id: true, processed: true },
  });
  if (existing?.processed) {
    return NextResponse.json({ received: true, deduped: true });
  }

  const logRow = existing
    ? null
    : await prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          livemode: event.livemode,
          source,
          payload: event as unknown as object,
        },
      });
  const logId = existing?.id ?? logRow!.id;

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
        const classId   = session.metadata?.classId;
        const classSessionId = session.metadata?.classSessionId;
        const saleId    = session.metadata?.saleId; // product sale
        const eventRegistrationId = session.metadata?.eventRegistrationId; // public/non-member event signup
        const clubOsPlan = session.metadata?.clubOsPlan; // ClubOS-own subscription tier

        // ── ClubOS platform subscription checkout ────────────────────────────
        // Club owner upgraded their AthletixOS plan. Persist tier + Stripe ids
        // so future invoices/cancellations sync correctly.
        if (clubOsPlan && session.metadata?.platformClubId && session.mode === "subscription") {
          const platformClubId = session.metadata.platformClubId;
          await prisma.club.update({
            where: { id: platformClubId },
            data: {
              tier: clubOsPlan,
              stripeCustomerId: (session.customer as string) || undefined,
              stripeSubscriptionId: (session.subscription as string) || undefined,
              subscriptionStatus: "active",
            },
          });
          await prisma.stripeWebhookEvent.update({
            where: { id: logId },
            data: { clubId: platformClubId },
          });
          break;
        }

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
                  category: "memberships",
                  paymentMethod: "STRIPE",
                },
              });
            }

            // Now that this member has an active subscription, promote them to ACTIVE.
            await recomputeMemberStatus(memberSub.memberId);

            // Email: membership activated
            const contact = await memberContact(memberSub.memberId);
            if (contact.email) {
              const updated = await prisma.memberSubscription.findUnique({
                where: { id: memberSubscriptionId },
                include: { membership: { select: { name: true } } },
              });
              const amountStr = session.amount_total
                ? `$${(session.amount_total / 100).toFixed(2)}`
                : undefined;
              safeAsync(() =>
                sendMembershipActivatedEmail({
                  to: contact.email!,
                  firstName: contact.firstName,
                  clubName: contact.clubName,
                  membershipName: updated?.membership.name ?? memberSub.optionLabel,
                  amountPaid: amountStr,
                  endDate: updated?.endDate ?? null,
                  portalUrl: `${BASE_URL}/member`,
                })
              );
            }
          }
        }

        // ── Member migration: finalize the switch once payment is set up ─────
        // The subscription was activated above (memberSubscriptionId branch).
        // Migration SETUP-mode checkout completed: the client added a card but
        // billing has NOT started. Save the payment method and mark payment
        // setup complete — the member stays PENDING_APPROVAL until the owner
        // reviews and approves (that's when the subscription is created).
        if (session.metadata?.migrationMemberId && session.mode === "setup") {
          const migMemberId = session.metadata.migrationMemberId;
          try {
            const mig = await prisma.member.findUnique({
              where: { id: migMemberId },
              select: { id: true, clubId: true, migrationStatus: true, club: { select: { stripeAccountId: true } } },
            });
            if (mig && mig.migrationStatus !== "COMPLETED") {
              let pmId: string | null = null;
              const siId = session.setup_intent as string | null;
              if (siId && mig.club.stripeAccountId) {
                try {
                  const si = await stripe.setupIntents.retrieve(siId, {
                    stripeAccount: mig.club.stripeAccountId,
                  });
                  pmId = (si.payment_method as string) || null;
                } catch (e) {
                  console.error("SetupIntent retrieve failed:", e);
                }
              }
              await prisma.member.update({
                where: { id: migMemberId },
                data: {
                  paymentSetupStatus: "COMPLETE",
                  ...(pmId ? { stripeSetupPaymentMethodId: pmId } : {}),
                  ...(mig.migrationStatus ? {} : { migrationStatus: "ACTIVATED" }),
                  approvalStatus: "PENDING_APPROVAL",
                },
              });
              await prisma.memberMigrationEvent.create({
                data: {
                  clubId: mig.clubId,
                  memberId: migMemberId,
                  type: "NOTE",
                  message: "Payment method on file — awaiting club review & approval before billing starts",
                },
              });
            }
          } catch (e) {
            console.error("Migration setup completion update failed:", e);
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
              category: "events",
              paymentMethod: "STRIPE",
            },
          });

          // Create the Booking that the charge route deferred to webhook on success.
          // Idempotent — if the booking already exists (e.g. retried webhook), do nothing.
          const existingBooking = await prisma.booking.findUnique({
            where: { eventId_memberId: { eventId, memberId } },
          });
          if (!existingBooking) {
            const event = await prisma.event.findFirst({
              where: { id: eventId, clubId, deletedAt: null },
              include: { _count: { select: { bookings: true } } },
            });
            if (event) {
              const status =
                event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
              await prisma.booking.create({
                data: { eventId, memberId, status },
              });

              // Email: booking confirmation (skip waitlisted; that's a different message)
              if (status === "CONFIRMED") {
                const contact = await memberContact(memberId);
                if (contact.email) {
                  const amountStr = session.amount_total
                    ? `$${(session.amount_total / 100).toFixed(2)}`
                    : undefined;
                  safeAsync(() =>
                    sendBookingConfirmationEmail({
                      to: contact.email!,
                      firstName: contact.firstName,
                      clubName: contact.clubName,
                      eventName: event.name,
                      startsAt: event.startsAt,
                      endsAt: event.endsAt,
                      amountPaid: amountStr,
                      portalUrl: `${BASE_URL}/member/bookings`,
                    })
                  );
                }
              }
            }
          }
        }

        // ── Class session checkout ───────────────────────────────────────────
        if (memberId && classId && classSessionId) {
          // Send class booking confirmation
          const classRow = await prisma.recurringClass.findFirst({
            where: { id: classId, clubId, deletedAt: null },
          });
          const sessionRow = await prisma.classSession.findUnique({ where: { id: classSessionId } });
          if (classRow && sessionRow) {
            const contact = await memberContact(memberId);
            if (contact.email) {
              const amountStr = session.amount_total
                ? `$${(session.amount_total / 100).toFixed(2)}`
                : undefined;
              safeAsync(() =>
                sendBookingConfirmationEmail({
                  to: contact.email!,
                  firstName: contact.firstName,
                  clubName: contact.clubName,
                  eventName: classRow.name,
                  startsAt: sessionRow.startsAt,
                  endsAt: sessionRow.endsAt,
                  amountPaid: amountStr,
                  portalUrl: `${BASE_URL}/member/bookings`,
                })
              );
            }
          }
          await prisma.transaction.create({
            data: {
              clubId,
              memberId,
              amount:  (session.amount_total || 0) / 100,
              status:  "SUCCEEDED",
              stripePaymentIntentId: session.payment_intent as string,
              description: `Class registration: ${session.metadata?.className || ""}`,
              type: "CLASS",
              category: "classes",
              paymentMethod: "STRIPE",
            },
          });
          // Mark the member as a paid drop-in on this session
          const existing = await prisma.attendanceRecord.findFirst({
            where: { classSessionId, memberId },
          });
          if (existing) {
            await prisma.attendanceRecord.update({
              where: { id: existing.id },
              data: { status: "DROP_IN", checkedInAt: existing.checkedInAt ?? new Date() },
            });
          } else {
            await prisma.attendanceRecord.create({
              data: {
                clubId,
                classSessionId,
                memberId,
                status: "DROP_IN",
                checkedInAt: new Date(),
              },
            });
          }
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

        // ── Public / non-member event registration checkout ──────────────────
        if (eventRegistrationId) {
          const reg = await prisma.eventRegistration.findUnique({
            where: { id: eventRegistrationId },
            include: { event: { select: { name: true } } },
          });
          if (reg && reg.status !== "PAID") {
            const amount = (session.amount_total || 0) / 100;
            await prisma.eventRegistration.update({
              where: { id: reg.id },
              data: {
                status: "PAID",
                amountPaid: amount,
                stripePaymentIntentId: session.payment_intent as string | undefined,
              },
            });
            await prisma.transaction.create({
              data: {
                clubId: reg.clubId,
                memberId: reg.memberId,
                amount,
                status: "SUCCEEDED",
                stripePaymentIntentId: session.payment_intent as string | undefined,
                description: `Event registration: ${reg.event.name}`,
                type: "EVENT",
                category: "events",
                paymentMethod: "STRIPE",
              },
            });
            // If they matched an existing member, also create a Booking so it
            // shows on their portal alongside member bookings.
            if (reg.memberId) {
              const existing = await prisma.booking.findUnique({
                where: { eventId_memberId: { eventId: reg.eventId, memberId: reg.memberId } },
              });
              if (!existing) {
                await prisma.booking.create({
                  data: { eventId: reg.eventId, memberId: reg.memberId, status: "CONFIRMED" },
                });
              }
            }
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
            category: "memberships",
            paymentMethod: "STRIPE",
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
          const subs = await prisma.memberSubscription.findMany({
            where: { stripeSubscriptionId: subscriptionId },
            select: { id: true, memberId: true },
          });
          await prisma.memberSubscription.updateMany({
            where: { stripeSubscriptionId: subscriptionId },
            data: { status: "past_due" },
          });
          for (const s of subs) {
            await recomputeMemberStatus(s.memberId);
            const contact = await memberContact(s.memberId);
            if (contact.email) {
              const amountStr = invoice.amount_due
                ? `$${(invoice.amount_due / 100).toFixed(2)}`
                : "your membership fee";
              safeAsync(() =>
                sendPaymentFailedEmail({
                  to: contact.email!,
                  firstName: contact.firstName,
                  clubName: contact.clubName,
                  amount: amountStr,
                  loginUrl: `${BASE_URL}/member/profile`,
                })
              );
            }
          }
        }
        break;
      }

      // ── Subscription canceled (auto-renew off or explicit cancel) ──────────
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;

        // Member-sub side (member paying their club)
        const subs = await prisma.memberSubscription.findMany({
          where: { stripeSubscriptionId: subscription.id },
          select: { id: true, memberId: true },
        });
        if (subs.length > 0) {
          await prisma.memberSubscription.updateMany({
            where: { stripeSubscriptionId: subscription.id },
            data: { status: "canceled", canceledAt: new Date() },
          });
          for (const s of subs) await recomputeMemberStatus(s.memberId);
        } else {
          // ClubOS platform sub (club paying ClubOS) canceled. There is no
          // free tier to fall back to — keep the tier on record and just mark
          // the subscription canceled so billing/settings can prompt a
          // re-subscribe. Access is governed by subscriptionStatus, not a
          // Starter downgrade.
          await prisma.club.updateMany({
            where: { stripeSubscriptionId: subscription.id },
            data: { subscriptionStatus: "canceled" },
          });
        }
        break;
      }

      // ── ClubOS platform subscription status changes ────────────────────────
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        // Skip when this is a member-sub on a connected account
        if (source === "CONNECT") break;
        await prisma.club.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { subscriptionStatus: subscription.status },
        });
        // If a tier change happened via price swap, sync via Price ID
        const newPriceId = subscription.items.data[0]?.price.id;
        if (newPriceId) {
          const tierForPrice = tierFromPriceId(newPriceId);
          if (tierForPrice) {
            await prisma.club.updateMany({
              where: { stripeSubscriptionId: subscription.id },
              data: { tier: tierForPrice },
            });
          }
        }
        break;
      }

      default:
        break;
    }

    if (logId) {
      await prisma.stripeWebhookEvent.update({
        where: { id: logId },
        data: { processed: true, processedAt: new Date() },
      });
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    if (logId) {
      await prisma.stripeWebhookEvent.update({
        where: { id: logId },
        data: { errorMessage: String(err), processedAt: new Date() },
      }).catch(() => {});
    }
    // Return 200 anyway so Stripe doesn't retry-storm us on a persistent bug.
    // The event is saved with the error message for replay/debugging.
    return NextResponse.json({ received: true, error: String(err) }, { status: 200 });
  }
}

// Map a Stripe Price ID back to our internal tier name. Env vars are set per
// environment (test vs live) and define which Price corresponds to which tier.
function tierFromPriceId(priceId: string): string | null {
  const map: Record<string, string> = {
    [process.env.STRIPE_PRICE_GROWTH || "__growth__"]: "growth",
    [process.env.STRIPE_PRICE_PRO || "__pro__"]: "pro",
    [process.env.STRIPE_PRICE_ENTERPRISE || "__enterprise__"]: "enterprise",
  };
  return map[priceId] ?? null;
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
