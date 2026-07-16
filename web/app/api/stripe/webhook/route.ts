import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import {
  sendBookingConfirmationEmail,
  sendMembershipActivatedEmail,
  sendPaymentFailedEmail,
  sendPaymentReceiptEmail,
} from "@/lib/email";
import type Stripe from "stripe";
import { getAppBaseUrl } from "@/lib/baseUrl";
import {
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  moneyFactsForInvoice,
  moneyFactsForPaymentIntent,
  verifiedStripeTxFields,
} from "@/lib/stripeTruth";

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

  // We run TWO Stripe webhook endpoints at this same URL — one for PLATFORM
  // events (the ClubOS-own subscription) and one Connect endpoint for CONNECTED
  // account events (member payments). Each Stripe endpoint signs with its OWN
  // secret, so we must try every configured secret and accept the first that
  // verifies — otherwise events from whichever endpoint doesn't match the single
  // secret get dropped as "invalid signature" (this is exactly why connected-
  // account events were silently failing). Set both in the environment:
  //   STRIPE_WEBHOOK_SECRET          — platform endpoint (may be comma-separated)
  //   STRIPE_CONNECT_WEBHOOK_SECRET  — Connect endpoint
  const secrets = [
    ...(process.env.STRIPE_WEBHOOK_SECRET ?? "").split(","),
    ...(process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? "").split(","),
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  if (!sig || secrets.length === 0) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event | null = null;
  let lastErr: unknown = null;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, secret);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!event) {
    // Verified against NONE of the configured secrets. Almost always a
    // missing/rotated secret for one of the two endpoints — surface it loudly so
    // it can't silently swallow connected-account events again.
    console.error(
      `Webhook signature verification failed against all ${secrets.length} configured secret(s):`,
      lastErr,
    );
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
        // Exact charge id + Stripe fee/net for this checkout's one-time
        // payment (subscription-mode sessions have no payment_intent — that
        // money is owned by invoice.paid). Never throws / never blocks.
        const checkoutMoney = session.payment_intent
          ? await moneyFactsForPaymentIntent(
              session.payment_intent as string,
              event.account ?? null,
            )
          : null;
        // Discount identity passed through checkout metadata by the staff/member
        // purchase routes — stamped onto every Transaction this event creates.
        const discountFields = session.metadata?.discountCode
          ? {
              discountCode: session.metadata.discountCode,
              discountAmount: session.metadata.discountAmount ? Number(session.metadata.discountAmount) : null,
            }
          : {};
        const memberSubscriptionId = session.metadata?.memberSubscriptionId;
        const memberId  = session.metadata?.memberId;
        const clubId    = session.metadata?.clubId || "";
        const eventId   = session.metadata?.eventId;
        const classId   = session.metadata?.classId;
        const classSessionId = session.metadata?.classSessionId;
        const saleId    = session.metadata?.saleId; // product sale
        const eventRegistrationId = session.metadata?.eventRegistrationId; // public/non-member event signup
        const clubOsPlan = session.metadata?.clubOsPlan; // ClubOS-own subscription tier
        const privatePackageId = session.metadata?.privatePackageId; // member-shop private package purchase
        const bundleId  = session.metadata?.bundleId; // #3 event bundle purchase

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
          const memberSub = await prisma.memberSubscription.findFirst({
            where: { id: memberSubscriptionId, member: { clubId } },
            include: { member: { select: { clubId: true } } },
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
              // Plan Auto Renew OFF: Checkout can't schedule a non-renewing
              // subscription (subscription_data has no cancel_at_period_end),
              // so apply it to the created subscription here. Idempotent —
              // setting it twice is a no-op.
              if (memberSub.autoRenew === false && event.account) {
                try {
                  const updated = await stripe.subscriptions.update(
                    session.subscription as string,
                    { cancel_at_period_end: true },
                    { stripeAccount: event.account },
                  );
                  const periodEnd = (updated as unknown as { current_period_end?: number })
                    .current_period_end;
                  if (periodEnd) {
                    await prisma.memberSubscription.update({
                      where: { id: memberSubscriptionId },
                      data: { endDate: new Date(periodEnd * 1000) },
                    });
                  }
                } catch (e) {
                  console.error(
                    "checkout.completed: could not apply Auto Renew OFF (cancel_at_period_end)",
                    session.subscription,
                    e,
                  );
                }
              }
            }

            // Record a transaction for ONE-TIME purchases only. Subscription
            // money (first charge AND renewals) is recorded exclusively by the
            // invoice.paid handler — one source of truth per dollar, deduped
            // by invoice id, so the first payment can't double-count.
            if (memberId && session.mode === "payment" && session.amount_total && session.amount_total > 0) {
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
                  ...verifiedStripeTxFields(checkoutMoney),
              ...discountFields,
                },
              });
            }

            // Capture the Stripe customer this purchase created/used so the
            // member can open the billing portal later (update card, view
            // invoices). Self-serve Checkout historically minted a fresh
            // anonymous customer that was never saved — leaving the member
            // with NO billing account on file. Never clobber an existing id
            // (customers can't be merged; the stored one stays canonical).
            if (session.customer) {
              await prisma.member.updateMany({
                where: { id: memberSub.memberId, stripeCustomerId: null },
                data: { stripeCustomerId: session.customer as string },
              });
            }

            // Now that this member has an active subscription, promote them to ACTIVE.
            await recomputeMemberStatus(memberSub.memberId, memberSub.member.clubId);

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

        // ── Owner/staff billing control center: add/replace a card ──────────
        // SETUP-mode checkout opened from /dashboard/members/[id]/billing.
        // ADD: the captured method becomes the member's on-file card (there is
        // nothing else it could break). REPLACE: collect-first — the method is
        // now attached to the customer, but the member pointer, customer
        // default, and live subscriptions keep the OLD card until staff
        // explicitly confirms via make-default. Never charges anything.
        if (session.metadata?.adminCardSetupMemberId && session.mode === "setup") {
          const adminMemberId = session.metadata.adminCardSetupMemberId;
          const intent = session.metadata.adminCardSetupIntent === "REPLACE" ? "REPLACE" : "ADD";
          try {
            const target = await prisma.member.findUnique({
              where: { id: adminMemberId },
              select: { id: true, clubId: true, club: { select: { stripeAccountId: true } } },
            });
            if (target) {
              let pmId: string | null = null;
              const siId = session.setup_intent as string | null;
              if (siId && target.club.stripeAccountId) {
                try {
                  const si = await stripe.setupIntents.retrieve(siId, {
                    stripeAccount: target.club.stripeAccountId,
                  });
                  pmId = (si.payment_method as string) || null;
                } catch (e) {
                  console.error("Admin card-setup SetupIntent retrieve failed:", e);
                }
              }
              if (intent === "ADD") {
                await prisma.member.update({
                  where: { id: adminMemberId },
                  data: {
                    stripeSetupCustomerId:
                      (session.customer as string) || session.metadata.setupCustomerId || undefined,
                    ...(pmId ? { stripeSetupPaymentMethodId: pmId, paymentSetupStatus: "COMPLETE" } : {}),
                  },
                });
              }
              const { writeBillingAudit } = await import("@/lib/billingAudit");
              await writeBillingAudit({
                clubId: target.clubId,
                memberId: target.id,
                action: intent === "ADD" ? "PM_ADDED" : "PM_COLLECTED_AWAITING_CONFIRM",
                note:
                  intent === "ADD"
                    ? "New payment method saved via Stripe and set as the on-file method."
                    : "Replacement payment method collected via Stripe — awaiting staff confirmation before it becomes the default.",
              });
            }
          } catch (e) {
            console.error("Admin card-setup webhook handling failed:", e);
          }
          break;
        }

        // ── Save-card-for-later (member portal "Add a card") ─────────────────
        // SETUP-mode checkout with NO charge and NO membership/migration side
        // effects: just persist the customer + payment method on the member so
        // future purchases and the billing portal can use it.
        if (session.metadata?.saveCardMemberId && session.mode === "setup") {
          const saveMemberId = session.metadata.saveCardMemberId;
          try {
            const target = await prisma.member.findUnique({
              where: { id: saveMemberId },
              select: { id: true, club: { select: { stripeAccountId: true } } },
            });
            if (target) {
              let pmId: string | null = null;
              const siId = session.setup_intent as string | null;
              if (siId && target.club.stripeAccountId) {
                try {
                  const si = await stripe.setupIntents.retrieve(siId, {
                    stripeAccount: target.club.stripeAccountId,
                  });
                  pmId = (si.payment_method as string) || null;
                } catch (e) {
                  console.error("Save-card SetupIntent retrieve failed:", e);
                }
              }
              await prisma.member.update({
                where: { id: saveMemberId },
                data: {
                  stripeSetupCustomerId:
                    (session.customer as string) || session.metadata.setupCustomerId || undefined,
                  ...(pmId ? { stripeSetupPaymentMethodId: pmId } : {}),
                },
              });
            }
          } catch (e) {
            console.error("Save-card webhook handling failed:", e);
          }
          break;
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

        // ── Event bundle checkout (#3): one payment books every included event ─
        if (memberId && bundleId) {
          await prisma.transaction.create({
            data: {
              clubId,
              memberId,
              amount: (session.amount_total || 0) / 100,
              status: "SUCCEEDED",
              stripePaymentIntentId: session.payment_intent as string,
              description: "Event bundle booking",
              type: "EVENT",
              category: "events",
              paymentMethod: "STRIPE",
              ...verifiedStripeTxFields(checkoutMoney),
              ...discountFields,
            },
          });

          const bundle = await prisma.eventBundle.findFirst({
            where: { id: bundleId, clubId, deletedAt: null },
            include: { items: { select: { eventId: true } } },
          });
          if (bundle) {
            for (const it of bundle.items) {
              // Idempotent — a retried webhook won't double-book.
              const existing = await prisma.booking.findUnique({
                where: { eventId_memberId: { eventId: it.eventId, memberId } },
              });
              if (!existing) {
                await prisma.booking.create({
                  data: { eventId: it.eventId, memberId, status: "CONFIRMED" },
                });
              }
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
              category: "events",
              paymentMethod: "STRIPE",
              ...verifiedStripeTxFields(checkoutMoney),
              ...discountFields,
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
          const sessionRow = await prisma.classSession.findFirst({ where: { id: classSessionId, clubId } });
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
              ...verifiedStripeTxFields(checkoutMoney),
              ...discountFields,
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
          const sale = await prisma.productSale.findFirst({ where: { id: saleId, clubId }, include: { product: true } });
          if (sale?.product.trackInventory && sale.product.inventory !== null) {
            await prisma.product.update({
              where: { id: sale.productId },
              data: { inventory: { decrement: sale.quantity } },
            });
          }
        }

        // ── Member-shop private package purchase ────────────────────────────
        // Granted credits = pkg.credits + pkg.bonusCredits, scoped to the
        // package's lesson type(s) (validated server-side at booking time
        // via packageAllowsLessonType). We deliberately CREATE the ledger
        // row here for the first time — pre-creating a pending row would
        // surface credits to the member before payment landed.
        //
        // Idempotency: scoped by stripeCheckoutSessionId so a duplicate
        // webhook delivery doesn't double-grant. The webhook itself
        // also dedupes by stripeEventId upstream, but this is a cheap
        // belt-and-braces guard against any future replay path.
        if (privatePackageId && memberId && clubId) {
          const existing = await prisma.privateCreditLedger.findFirst({
            where: { stripeCheckoutSessionId: session.id },
            select: { id: true },
          });
          if (!existing) {
            const pkg = await prisma.privatePackage.findFirst({
              where: { id: privatePackageId, clubId, deletedAt: null },
              select: {
                id: true,
                title: true,
                credits: true,
                bonusCredits: true,
                lessonTypeId: true,
                expiresAfterDays: true,
              },
            });
            if (pkg) {
              const grants = pkg.credits + (pkg.bonusCredits ?? 0);
              const expiresAt = pkg.expiresAfterDays
                ? new Date(Date.now() + pkg.expiresAfterDays * 24 * 60 * 60 * 1000)
                : null;
              const amount = (session.amount_total || 0) / 100;
              await prisma.privateCreditLedger.create({
                data: {
                  clubId,
                  memberId,
                  packageId: pkg.id,
                  lessonTypeId: pkg.lessonTypeId,
                  creditsGranted: grants,
                  creditsUsed: 0,
                  purchaseType: "PACKAGE",
                  status: "active",
                  expiresAt,
                  stripeCheckoutSessionId: session.id,
                  stripePaymentIntentId: session.payment_intent as string | undefined,
                  pricePaid: amount,
                },
              });
              // Record the transaction so the package purchase appears in
              // financials/reports alongside membership + event payments.
              if (amount > 0) {
                await prisma.transaction.create({
                  data: {
                    clubId,
                    memberId,
                    amount,
                    status: "SUCCEEDED",
                    stripePaymentIntentId: session.payment_intent as string | undefined,
                    description: `Private package: ${pkg.title}`,
                    type: "PRIVATE",
                    category: "private_lessons",
                    paymentMethod: "STRIPE",
                    ...verifiedStripeTxFields(checkoutMoney),
              ...discountFields,
                  },
                });
              }
            }
          }
        }

        // ── Public / non-member event registration checkout ──────────────────
        if (eventRegistrationId) {
          const reg = await prisma.eventRegistration.findUnique({
            where: { id: eventRegistrationId },
            include: { event: { select: { name: true } } },
          });
          // Already settled, yet Stripe just took money — e.g. they paid cash
          // at the door and later clicked a still-live payment link from their
          // inbox. Silently dropping this would leave a real charge with NO
          // record in AthletixOS and the client out of pocket. Record it and
          // flag it for a human to refund/reconcile.
          if (reg && reg.status === "PAID" && (session.amount_total || 0) > 0) {
            const dupAmount = (session.amount_total || 0) / 100;
            const alreadyLogged = await prisma.transaction.findFirst({
              where: { stripePaymentIntentId: session.payment_intent as string },
              select: { id: true },
            });
            if (!alreadyLogged) {
              await prisma.transaction.create({
                data: {
                  clubId: reg.clubId,
                  memberId: reg.memberId,
                  amount: dupAmount,
                  status: "SUCCEEDED",
                  stripePaymentIntentId: session.payment_intent as string | undefined,
                  description: `DUPLICATE PAYMENT — ${reg.event.name} — ${reg.name} (already paid via ${reg.paidVia ?? "another method"}) — likely refund due`,
                  type: "EVENT",
                  category: "events",
                  paymentMethod: "STRIPE",
                  txDate: new Date(),
                  ...verifiedStripeTxFields(checkoutMoney),
                  // The club really did receive this money, so it counts as
                  // revenue until someone refunds it — pretending otherwise
                  // would understate their actual balance. REVIEW (a
                  // deliberate downgrade from VERIFIED) plus the description
                  // is what tells a human to act. Only a refund should remove
                  // it from the totals.
                  reconciliationStatus: "REVIEW",
                  notes: `Registration ${reg.id} was already PAID when this Checkout completed. Refund or reconcile.`,
                },
              });
              console.error(
                `Duplicate event payment: registration ${reg.id} already PAID, Stripe took $${dupAmount.toFixed(2)} (PI ${session.payment_intent}).`,
              );
            }
          }
          if (reg && reg.status !== "PAID") {
            const amount = (session.amount_total || 0) / 100;
            const tx = await prisma.transaction.create({
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
                txDate: new Date(),
                ...verifiedStripeTxFields(checkoutMoney),
              ...discountFields,
              },
            });
            // Card payment confirmed by Stripe → the registration is complete
            // and the spot is reserved. This also settles a registrant who
            // chose cash/check and then paid online instead; their PENDING
            // offline Transaction is voided below so the money isn't counted
            // twice or left showing as still-owed.
            await prisma.eventRegistration.update({
              where: { id: reg.id },
              data: {
                status: "PAID",
                amountPaid: amount,
                paidAt: new Date(),
                paidVia: "STRIPE",
                transactionId: tx.id,
                lastChargeError: null,
                stripePaymentIntentId: session.payment_intent as string | undefined,
              },
            });
            if (reg.transactionId && reg.transactionId !== tx.id) {
              await prisma.transaction
                .updateMany({
                  where: { id: reg.transactionId, status: "PENDING" },
                  data: {
                    status: "FAILED",
                    reconciliationStatus: "VOID",
                    notes: "Superseded — registrant paid online instead.",
                  },
                })
                .catch((e) => console.error("event reg offline tx void failed", e));
            }
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
            // Receipt — every completed payment gets one, member or not.
            if (reg.email) {
              try {
                const club = await prisma.club.findUnique({
                  where: { id: reg.clubId },
                  select: { name: true },
                });
                await sendPaymentReceiptEmail({
                  to: reg.email,
                  firstName: reg.name?.split(" ")[0] || "there",
                  clubName: club?.name || "your club",
                  description: `${reg.event.name} — event registration`,
                  amountPaid: `$${amount.toFixed(2)}`,
                  paidAt: new Date(),
                  portalUrl: `${getAppBaseUrl()}/member`,
                });
              } catch (e) {
                console.error("event registration receipt failed", e);
              }
            }
          }
        }

        break;
      }

      // ── Invoice paid (first charge OR renewal) ─────────────────────────────
      // NEVER read invoice.subscription / invoice.payment_intent directly —
      // the account's webhook endpoints deliver API 2026-02-25.clover, where
      // those fields moved (invoice.parent.subscription_details.*, payments).
      // Reading the dead top-level fields is how 93% of real card revenue
      // silently vanished from Financials (audit 2026-07-14).
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoiceSubscriptionId(invoice);
        if (!subscriptionId) break;
        // $0 invoices (trial starts) don't belong in the money ledger.
        if (!invoice.amount_paid || invoice.amount_paid <= 0) break;

        // Redelivery / double-processing guard: one Transaction per invoice.
        const already = await prisma.transaction.findFirst({
          where: { stripeInvoiceId: invoice.id },
          select: { id: true },
        });
        if (already) break;

        const memberSub = await prisma.memberSubscription.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
          include: { member: true },
        });

        // The FIRST invoice of a server-created subscription (migration
        // approve, reactivation confirm) fires the instant Stripe creates the
        // subscription — often BEFORE the app finishes writing the local
        // MemberSubscription row. Resolve the member from the subscription
        // metadata instead (we stamp memberId/migrationMemberId on every
        // subscription we create). Clover payloads embed that metadata right
        // on the invoice; fall back to retrieving the subscription.
        let clubId: string | null = memberSub?.member.clubId ?? null;
        let memberId: string | null = memberSub?.memberId ?? null;
        let label = memberSub?.optionLabel ?? null;
        if (!memberId) {
          const meta = invoiceSubscriptionMetadata(invoice);
          let metaMemberId = meta.memberId || meta.migrationMemberId || null;
          if (!metaMemberId && event.account) {
            try {
              const sub = await stripe.subscriptions.retrieve(subscriptionId, {
                stripeAccount: event.account,
              });
              metaMemberId =
                sub.metadata?.memberId || sub.metadata?.migrationMemberId || null;
              label = sub.items?.data?.[0]?.price?.nickname ?? label;
            } catch (e) {
              console.error("invoice.paid: subscription retrieve failed", e);
            }
          }
          if (metaMemberId) {
            const m = await prisma.member.findUnique({
              where: { id: metaMemberId },
              select: { id: true, clubId: true },
            });
            if (m) {
              memberId = m.id;
              clubId = m.clubId;
            }
          }
        }
        if (!memberId || !clubId) {
          // Loud — a paid invoice we cannot attribute must surface, not vanish.
          console.error(
            `invoice.paid UNRESOLVED: invoice ${invoice.id} sub ${subscriptionId} amount ${invoice.amount_paid} has no resolvable member — needs reconciliation`,
          );
          break;
        }

        // Exact charge id + Stripe fee/net (never throws, never blocks).
        const money = await moneyFactsForInvoice(invoice, event.account ?? null);

        const description = `Membership ${invoice.billing_reason === "subscription_create" ? "payment" : "renewal"}: ${label ?? "membership"}`;
        await prisma.transaction.create({
          data: {
            clubId,
            memberId,
            amount:  invoice.amount_paid / 100,
            status:  "SUCCEEDED",
            stripePaymentIntentId: money.paymentIntentId,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: subscriptionId,
            // Discount identity carried by the subscription (first charge AND
            // every renewal keeps reporting which discount priced it).
            ...(memberSub?.discountCode
              ? {
                  discountCode: memberSub.discountCode,
                  discountAmount: memberSub.discountAmount != null ? Number(memberSub.discountAmount) : null,
                }
              : {}),
            description,
            type: "MEMBERSHIP",
            category: "memberships",
            paymentMethod: "STRIPE",
            ...verifiedStripeTxFields(money),
          },
        });

        // Keep status active on renewal
        if (memberSub) {
          await prisma.memberSubscription.update({
            where: { id: memberSub.id },
            data: { status: "active" },
          });
        }

        // Receipt — every real subscription charge emails a receipt.
        {
          const resolvedMemberId = memberId;
          const amountPaid = invoice.amount_paid / 100;
          safeAsync(async () => {
            const contact = await memberContact(resolvedMemberId);
            const to = invoice.customer_email || contact.email;
            if (!to) return;
            await sendPaymentReceiptEmail({
              to,
              firstName: contact.firstName || "there",
              clubName: contact.clubName,
              description,
              amountPaid: `$${amountPaid.toFixed(2)}`,
              paidAt: new Date(),
              portalUrl: `${BASE_URL}/member/profile`,
            });
          });
        }
        break;
      }

      // ── Payment failed ─────────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // Version-safe (clover payloads have no top-level invoice.subscription).
        const subscriptionId = invoiceSubscriptionId(invoice);
        if (subscriptionId) {
          const subs = await prisma.memberSubscription.findMany({
            where: { stripeSubscriptionId: subscriptionId },
            select: { id: true, memberId: true, member: { select: { clubId: true } } },
          });
          await prisma.memberSubscription.updateMany({
            where: { stripeSubscriptionId: subscriptionId },
            data: { status: "past_due" },
          });
          for (const s of subs) {
            await recomputeMemberStatus(s.memberId, s.member.clubId);
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
          select: { id: true, memberId: true, member: { select: { clubId: true } } },
        });
        if (subs.length > 0) {
          await prisma.memberSubscription.updateMany({
            where: { stripeSubscriptionId: subscription.id },
            data: { status: "canceled", canceledAt: new Date() },
          });
          for (const s of subs) await recomputeMemberStatus(s.memberId, s.member.clubId);
        } else {
          // ClubOS platform sub (club paying ClubOS) canceled. There is no
          // free tier to fall back to — keep the tier on record and just mark
          // the subscription canceled so billing/settings can prompt a
          // re-subscribe. Access is governed by subscriptionStatus, not a
          // Starter downgrade.
          await prisma.club.updateMany({
            where: { stripeSubscriptionId: subscription.id },
            // Clear the id so the owner can subscribe again — checkout treats
            // a lingering stripeSubscriptionId as "already subscribed".
            data: { subscriptionStatus: "canceled", stripeSubscriptionId: null },
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
