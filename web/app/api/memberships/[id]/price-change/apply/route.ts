import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { requireOwner } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { renderEmail } from "@/lib/emailRender";
import { resolvePostalAddressLines } from "@/lib/emailPostalAddress";
import { publicClubLogoUrl } from "@/lib/clubLogo";
import {
  recordSubscriptionEvent,
  SUBSCRIPTION_EVENT_KIND,
  SUBSCRIPTION_EVENT_SOURCE,
} from "@/lib/subscriptionEvents";
import {
  parseMembershipOptions,
  planPriceChange,
  validateNotice,
  stripeUnitAmountCents,
  buildPriceChangeEmail,
  isFailureOutcome,
  REPRICEABLE_STATUSES,
  type ApplyOutcome,
  type ApplyRowResult,
} from "@/lib/bulkPriceChange";

// POST /api/memberships/[id]/price-change/apply
//
// Moves `member_subscriptions.price` for an explicitly-chosen set of
// subscriptions, and — for Stripe-billed rows — moves the live Stripe
// subscription item to match.
//
// ── What this route deliberately does NOT do ────────────────────────────────
//
//   - It never touches `memberships.options`. The plan's price list is a
//     separate, explicit save (spec §4). Repricing people and repricing the
//     price list in one silent step is how you discover afterwards that you
//     can't tell which one you meant.
//   - It never changes anyone's paid status, and never issues money. The
//     credit figure is recorded, not paid.
//   - It never prorates. Every Stripe call passes
//     `proration_behavior: "none"` — the default, `create_prorations`, would
//     fire a credit note or an extra charge on every touched subscription,
//     which is the opposite of "no refund math".
//
// ── Ordering, and why ───────────────────────────────────────────────────────
//
// Per row: Stripe first → read back and verify → then the DB. Stripe is the
// billing source of truth and the harder of the two to roll back, so it is the
// one whose success is established before anything local is written. If the DB
// write then fails, the Stripe item is restored to its old amount before the
// row is reported. A row is only ever reported UPDATED when both sides agree.
//
// Rows are independent: one member's Stripe failure never rolls back another
// member's completed update. Each row's outcome is reported separately.

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  optionLabel: z.string().min(1),
  billingPeriod: z.string().min(1).optional(),
  newPrice: z.number().min(0).max(1_000_000),
  memberSubscriptionIds: z.array(z.string().min(1)).min(1).max(500),
  /**
   * The date the new price takes effect. REQUIRED for increases — families
   * must be told before their price goes up, and the notification is sent
   * during this request, which is necessarily before a future date.
   */
  notifyBeforeDate: z.string().optional().nullable(),
  /** Set false only to suppress the member notification (owner's explicit call). */
  notify: z.boolean().optional().default(true),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  // Explicit null check before the guard — requireOwner does not narrow
  // `session` for TypeScript, and session.user is read throughout below.
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  const clubId = session.user.clubId;
  const actorUserId = session.user.id ?? null;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const club = await prisma.club.findFirst({
    where: { id: clubId },
    select: {
      id: true, name: true, logoUrl: true, primaryColor: true,
      passProcessingFees: true, stripeAccountId: true, stripeChargesEnabled: true,
      publicEmail: true, contactEmail: true, publicPhone: true, contactPhone: true,
      websiteUrl: true, mailingAddress: true, mailingAddress2: true, mailingCity: true,
      mailingState: true, mailingZip: true, mailingCountry: true,
    },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  const membership = await prisma.membership.findFirst({
    where: { id: params.id, clubId, deletedAt: null },
    select: { id: true, name: true, options: true },
  });
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const options = parseMembershipOptions(membership.options);
  const option = options.find(
    (o) => o.label === body.optionLabel && (body.billingPeriod ? o.billingPeriod === body.billingPeriod : true),
  );
  if (!option) {
    return NextResponse.json({ error: `This plan has no option "${body.optionLabel}".` }, { status: 400 });
  }

  // ── Re-verify against the DB. The preview payload is NEVER trusted. ───────
  //
  // The client sends ids and a price; everything else — who is on the plan,
  // what they currently pay, which channel they bill through — is re-read here
  // under the same where-clause the preview used. A row that has moved plan,
  // been canceled, or been repriced by someone else since the preview was
  // built simply will not come back, and is reported as such.
  const requestedIds = Array.from(new Set(body.memberSubscriptionIds));
  const subs = await prisma.memberSubscription.findMany({
    where: {
      id: { in: requestedIds },
      membershipId: membership.id,
      billingPeriod: option.billingPeriod,
      status: { in: [...REPRICEABLE_STATUSES] },
      member: { clubId, deletedAt: null },
    },
    select: {
      id: true, memberId: true, optionLabel: true, price: true, billingPeriod: true,
      billingType: true, status: true, stripeSubscriptionId: true, stripePriceId: true,
      stripeStatus: true, currentPeriodEnd: true, endDate: true, billingAnchorDate: true,
      startDate: true, effectiveStartDate: true, autoRenew: true,
      discountCode: true, discountAmount: true,
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const now = new Date();
  const plan = planPriceChange({
    membership: { id: membership.id, name: membership.name },
    option,
    newPrice: body.newPrice,
    subs,
    now,
  });

  // ── Advance-notice gate for increases ────────────────────────────────────
  const notifyBeforeDate = body.notifyBeforeDate ? new Date(body.notifyBeforeDate) : null;
  const notice = validateNotice({ direction: plan.direction, notifyBeforeDate, now });
  if (!notice.ok) {
    return NextResponse.json({ error: notice.error, code: notice.code }, { status: 400 });
  }

  const results: ApplyRowResult[] = [];
  const byId = new Map(plan.rows.map((r) => [r.memberSubscriptionId, r]));

  // Ids that survived neither the plan filter nor the club scope.
  for (const id of requestedIds) {
    if (!byId.has(id)) {
      results.push({
        memberSubscriptionId: id, memberId: null, memberName: null,
        outcome: "SKIPPED_NOT_FOUND", channel: null, fromPrice: null, toPrice: null,
        credit: null, emailed: false, emailStatus: null,
        message:
          "No longer matches this plan and billing period, or is no longer active. It was not changed.",
      });
    }
  }

  const stripeAccount = club.stripeAccountId ?? undefined;
  const targetCents = stripeUnitAmountCents(body.newPrice, club.passProcessingFees);

  for (const row of plan.rows) {
    const fromPrice = row.currentPrice;
    const toPrice = row.newPrice;

    // Re-running the same apply is a no-op rather than a second write.
    if (fromPrice === toPrice) {
      results.push({
        memberSubscriptionId: row.memberSubscriptionId, memberId: row.memberId,
        memberName: row.memberName, outcome: "SKIPPED_ALREADY_AT_PRICE", channel: row.channel,
        fromPrice, toPrice, credit: row.credit, emailed: false, emailStatus: null,
        message: "Already at this price — left alone.",
      });
      continue;
    }

    let outcome: ApplyOutcome = "UPDATED";
    let message: string | null = null;
    // Set when Stripe has been moved and may need restoring.
    let stripeItemId: string | null = null;
    let stripeOldCents: number | null = null;

    // ── 1. Stripe side, verified by read-back ──────────────────────────────
    if (row.channel === "stripe" && row.stripe) {
      if (!stripeAccount || !club.stripeChargesEnabled) {
        results.push({
          memberSubscriptionId: row.memberSubscriptionId, memberId: row.memberId,
          memberName: row.memberName, outcome: "FAILED_STRIPE", channel: "stripe",
          fromPrice, toPrice, credit: row.credit, emailed: false, emailStatus: null,
          message: "The club's Stripe account is not connected, so this subscription was not changed.",
        });
        continue;
      }
      try {
        const live = await stripe.subscriptions.retrieve(row.stripe.subscriptionId, { stripeAccount });
        if (live.status === "canceled" || live.status === "incomplete_expired") {
          results.push({
            memberSubscriptionId: row.memberSubscriptionId, memberId: row.memberId,
            memberName: row.memberName, outcome: "SKIPPED_CHANGED_UNDERNEATH", channel: "stripe",
            fromPrice, toPrice, credit: row.credit, emailed: false, emailStatus: null,
            message: `Stripe reports this subscription as "${live.status}" — not changed.`,
          });
          continue;
        }
        const item = live.items?.data?.[0];
        if (!item) throw new Error("subscription has no billable item");
        stripeItemId = item.id;
        stripeOldCents = item.price?.unit_amount ?? null;
        const productId =
          typeof item.price?.product === "string" ? item.price.product : item.price?.product?.id;
        if (!productId) throw new Error("could not resolve the Stripe product for this item");

        await stripe.subscriptions.update(
          row.stripe.subscriptionId,
          {
            items: [
              {
                id: item.id,
                price_data: {
                  currency: item.price?.currency ?? "usd",
                  product: productId,
                  unit_amount: targetCents,
                  recurring: {
                    interval: item.price?.recurring?.interval ?? "month",
                    interval_count: item.price?.recurring?.interval_count ?? 1,
                  },
                },
              },
            ],
            // Explicit. The default (`create_prorations`) would issue a credit
            // note or an immediate charge on every touched subscription.
            proration_behavior: "none",
          },
          {
            stripeAccount,
            // Param-sensitive so a corrected retry gets a fresh key rather
            // than being rejected for reusing one with different params.
            idempotencyKey: `aox-pricechange-${row.memberSubscriptionId}-${targetCents}`,
          },
        );

        // Verify rather than trust: read the subscription back and confirm the
        // amount is actually live before anything local is written.
        const after = await stripe.subscriptions.retrieve(row.stripe.subscriptionId, { stripeAccount });
        const liveCents = after.items?.data?.[0]?.price?.unit_amount ?? null;
        if (liveCents !== targetCents) {
          // Stripe accepted the call but is not reporting the new amount.
          // Put it back and report — never write a DB row we can't stand behind.
          let restored = false;
          try {
            if (stripeItemId && stripeOldCents != null && productId) {
              await stripe.subscriptions.update(
                row.stripe.subscriptionId,
                {
                  items: [{
                    id: stripeItemId,
                    price_data: {
                      currency: item.price?.currency ?? "usd",
                      product: productId,
                      unit_amount: stripeOldCents,
                      recurring: {
                        interval: item.price?.recurring?.interval ?? "month",
                        interval_count: item.price?.recurring?.interval_count ?? 1,
                      },
                    },
                  }],
                  proration_behavior: "none",
                },
                { stripeAccount },
              );
              restored = true;
            }
          } catch { /* reported below */ }
          results.push({
            memberSubscriptionId: row.memberSubscriptionId, memberId: row.memberId,
            memberName: row.memberName, outcome: "FAILED_STRIPE_UNVERIFIED", channel: "stripe",
            fromPrice, toPrice, credit: row.credit, emailed: false, emailStatus: null,
            message: `Stripe did not report the new amount after the update (saw ${liveCents ?? "nothing"}, expected ${targetCents}). ${restored ? "The old amount was restored." : "The old amount could NOT be restored — check this subscription in Stripe."} Nothing was saved locally.`,
          });
          continue;
        }
      } catch (e) {
        results.push({
          memberSubscriptionId: row.memberSubscriptionId, memberId: row.memberId,
          memberName: row.memberName, outcome: "FAILED_STRIPE", channel: "stripe",
          fromPrice, toPrice, credit: row.credit, emailed: false, emailStatus: null,
          message: `Stripe refused the update: ${String(e)}. Nothing was saved locally.`,
        });
        continue;
      }
    }

    // ── 2. DB side, compare-and-swap ───────────────────────────────────────
    //
    // Guarded on the price we just re-read. If anything moved between the
    // re-read and this write, the update matches zero rows and we say so
    // rather than clobbering someone else's change.
    let dbUpdated = 0;
    let dbError: unknown = null;
    try {
      const res = await prisma.memberSubscription.updateMany({
        where: {
          id: row.memberSubscriptionId,
          membershipId: membership.id,
          billingPeriod: option.billingPeriod,
          status: { in: [...REPRICEABLE_STATUSES] },
          price: fromPrice,
        },
        data: { price: toPrice },
      });
      dbUpdated = res.count;
    } catch (e) {
      dbError = e;
    }

    if (dbUpdated !== 1) {
      // Restore Stripe so the two sides cannot disagree.
      let restored = false;
      if (stripeItemId && stripeOldCents != null && stripeAccount) {
        try {
          const live = await stripe.subscriptions.retrieve(row.stripe!.subscriptionId, { stripeAccount });
          const item = live.items?.data?.[0];
          const productId =
            typeof item?.price?.product === "string" ? item.price.product : item?.price?.product?.id;
          if (item && productId) {
            await stripe.subscriptions.update(
              row.stripe!.subscriptionId,
              {
                items: [{
                  id: item.id,
                  price_data: {
                    currency: item.price?.currency ?? "usd",
                    product: productId,
                    unit_amount: stripeOldCents,
                    recurring: {
                      interval: item.price?.recurring?.interval ?? "month",
                      interval_count: item.price?.recurring?.interval_count ?? 1,
                    },
                  },
                }],
                proration_behavior: "none",
              },
              { stripeAccount },
            );
            restored = true;
          }
        } catch { /* reported below */ }
      }
      const wasStripe = row.channel === "stripe";
      outcome = dbError
        ? wasStripe && !restored
          ? "FAILED_DB_ROLLBACK_FAILED"
          : "FAILED_DB_ROLLED_BACK"
        : "SKIPPED_CHANGED_UNDERNEATH";
      message = dbError
        ? `The local save failed: ${String(dbError)}.${wasStripe ? (restored ? " Stripe was rolled back to the old amount." : " Stripe could NOT be rolled back — check this subscription in Stripe now.") : ""}`
        : `This subscription changed while the update was running, so it was left alone.${wasStripe && restored ? " Stripe was rolled back." : ""}`;
      results.push({
        memberSubscriptionId: row.memberSubscriptionId, memberId: row.memberId,
        memberName: row.memberName, outcome, channel: row.channel,
        fromPrice, toPrice, credit: row.credit, emailed: false, emailStatus: null, message,
      });
      continue;
    }

    // ── 3. Both sides agree. Record it. ────────────────────────────────────
    //
    // PRICE_CHANGE is NOT a lifecycle kind — it is excluded from the Reports
    // reliability coverage test (lib/subscriptionEvents LIFECYCLE_EVENT_KINDS)
    // so a repricing can never make an un-backfilled club look COMPLETE.
    await recordSubscriptionEvent({
      clubId,
      memberSubscriptionId: row.memberSubscriptionId,
      memberId: row.memberId,
      kind: SUBSCRIPTION_EVENT_KIND.PRICE_CHANGE,
      at: now,
      fromPlan: membership.name,
      toPlan: membership.name,
      fromAmount: fromPrice,
      toAmount: toPrice,
      actorUserId,
      source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
      detail: {
        route: "POST /api/memberships/[id]/price-change/apply",
        optionLabel: option.label,
        billingPeriod: option.billingPeriod,
        channel: row.channel,
        stripeSubscriptionId: row.stripe?.subscriptionId ?? null,
        stripeUnitAmountCents: row.channel === "stripe" ? targetCents : null,
        prorationBehavior: row.channel === "stripe" ? "none" : null,
        effectiveDate: notifyBeforeDate ? notifyBeforeDate.toISOString() : null,
      },
    });

    // The credit lands HERE — BillingAuditLog is rendered on the member's
    // billing centre (merged history in /api/members/[id]/billing-admin), which
    // is the page an owner is on when they act on it. An event `detail` blob
    // renders nowhere. "Can't compute" is recorded as exactly that.
    await writeBillingAudit({
      clubId,
      memberId: row.memberId,
      actorUserId,
      action: "MEMBERSHIP_PRICE_CHANGED",
      before: { price: fromPrice, plan: membership.name, optionLabel: option.label, billingPeriod: option.billingPeriod },
      after: {
        price: toPrice,
        plan: membership.name,
        optionLabel: option.label,
        billingPeriod: option.billingPeriod,
        channel: row.channel,
        stripeSubscriptionId: row.stripe?.subscriptionId ?? null,
        stripeUnitAmountCents: row.channel === "stripe" ? targetCents : null,
        effectiveDate: notifyBeforeDate ? notifyBeforeDate.toISOString() : null,
        credit: {
          kind: row.credit.kind,
          amount: row.credit.amount,
          basis: row.credit.basis,
          periodEnd: row.credit.periodEnd,
          note: row.credit.note,
        },
      },
      note:
        row.credit.kind === "CREDIT_OWED"
          ? `Credit owed to this member for unused time: $${(row.credit.amount ?? 0).toFixed(2)}. NOT issued — settle manually.`
          : row.credit.kind === "ADDITIONAL_DUE"
            ? `Additional amount due from this member for remaining time: $${(row.credit.amount ?? 0).toFixed(2)}. NOT charged — collect manually.`
            : row.credit.kind === "UNKNOWN"
              ? "Unused-time credit could NOT be computed — no usable period end is stored on this subscription. Settle by hand."
              : null,
    });

    results.push({
      memberSubscriptionId: row.memberSubscriptionId, memberId: row.memberId,
      memberName: row.memberName, outcome: "UPDATED", channel: row.channel,
      fromPrice, toPrice, credit: row.credit, emailed: false, emailStatus: null, message: null,
    });
  }

  // ── 4. Notify the families whose price actually moved ────────────────────
  //
  // TRANSACTIONAL: a price change is not marketing and must not be suppressed
  // by a marketing opt-out. Sent only for rows that really changed, after the
  // writes, so nobody is told about a change that failed.
  const updatedIds = results.filter((r) => r.outcome === "UPDATED").map((r) => r.memberSubscriptionId);
  if (body.notify && updatedIds.length > 0) {
    const sendBatchId = `pricechange-${membership.id}-${option.billingPeriod}-${now.getTime()}`;
    const { resolveRecipients } = await import("@/lib/emailRecipients");
    const memberIds = results
      .filter((r) => r.outcome === "UPDATED" && r.memberId)
      .map((r) => r.memberId as string);

    let recipients: Awaited<ReturnType<typeof resolveRecipients>> | null = null;
    try {
      recipients = await resolveRecipients({
        clubId,
        memberIds,
        // One email per member: a guardian with two athletes on this plan is
        // told about BOTH price changes, not just whichever deduped first.
        mode: "PER_MEMBER",
        respectMarketingOptOut: false,
      });
    } catch (e) {
      console.error("[price-change] recipient resolution failed", e);
    }

    for (const rec of recipients?.send ?? []) {
      const rowResult = results.find((r) => r.memberId === rec.recipientMemberId && r.outcome === "UPDATED");
      if (!rowResult) continue;
      try {
        const email = buildPriceChangeEmail({
          clubName: club.name,
          memberName: rowResult.memberName ?? "",
          planName: membership.name,
          optionLabel: option.label,
          billingPeriod: option.billingPeriod,
          fromPrice: rowResult.fromPrice ?? 0,
          toPrice: rowResult.toPrice ?? 0,
          passProcessingFees: club.passProcessingFees,
          effectiveDate: notifyBeforeDate,
          channel: (rowResult.channel ?? "offline") as "stripe" | "offline",
          credit: rowResult.credit!,
        });
        const rendered = await renderEmail(email.blocks, {
          clubName: club.name,
          clubLogoUrl: publicClubLogoUrl(club.id, club.logoUrl),
          clubContact: {
            email: club.publicEmail ?? club.contactEmail,
            phone: club.publicPhone ?? club.contactPhone,
            website: club.websiteUrl,
            address: null,
          },
          club,
          unsubscribeUrl: null,
          postalAddress: resolvePostalAddressLines(club),
          accentColor: club.primaryColor,
        });
        const sent = await sendClubEmail({
          clubId,
          kind: "TRANSACTIONAL",
          recipientEmail: rec.recipientEmail,
          recipientUserId: rec.recipientUserId,
          recipientMemberId: rec.recipientMemberId,
          subject: email.subject,
          bodyHtml: rendered.html,
          bodyText: rendered.text,
          bodyJson: email.blocks,
          sendBatchId,
          // Deterministic per (batch, member, address): a double-submit or a
          // retry hits the partial unique index rather than mailing twice.
          dedupeKey: rec.dedupeKey,
          sentByUserId: actorUserId,
          relatedMembershipId: membership.id,
        });
        rowResult.emailed = sent.status === "SENT";
        rowResult.emailStatus = sent.status;
      } catch (e) {
        console.error("[price-change] notification failed", rec.recipientEmail, e);
        rowResult.emailStatus = "FAILED";
      }
    }
  }

  const updated = results.filter((r) => r.outcome === "UPDATED");
  const failed = results.filter((r) => isFailureOutcome(r.outcome));
  const skipped = results.filter((r) => r.outcome.startsWith("SKIPPED"));
  const creditOwed = updated
    .filter((r) => r.credit?.kind === "CREDIT_OWED")
    .reduce((s, r) => s + (r.credit?.amount ?? 0), 0);
  const additionalDue = updated
    .filter((r) => r.credit?.kind === "ADDITIONAL_DUE")
    .reduce((s, r) => s + (r.credit?.amount ?? 0), 0);
  const unresolvedCredit = updated.filter((r) => r.credit?.kind === "UNKNOWN").length;

  // One run-level audit row so the whole action is reconstructible even
  // though each member also has their own.
  await writeBillingAudit({
    clubId,
    memberId: null,
    actorUserId,
    action: "MEMBERSHIP_BULK_PRICE_CHANGE",
    before: { membershipId: membership.id, optionLabel: option.label, billingPeriod: option.billingPeriod, optionPrice: option.price },
    after: {
      newPrice: body.newPrice,
      direction: plan.direction,
      effectiveDate: notifyBeforeDate ? notifyBeforeDate.toISOString() : null,
      requested: requestedIds.length,
      updated: updated.length,
      failed: failed.length,
      skipped: skipped.length,
      creditOwed: Math.round(creditOwed * 100) / 100,
      additionalDue: Math.round(additionalDue * 100) / 100,
      unresolvedCredit,
      rows: results.map((r) => ({ id: r.memberSubscriptionId, outcome: r.outcome, from: r.fromPrice, to: r.toPrice })),
    },
    note: "The plan's own option price was NOT changed by this action — that is a separate save.",
  });

  return NextResponse.json({
    ok: failed.length === 0,
    summary: {
      requested: requestedIds.length,
      updated: updated.length,
      failed: failed.length,
      skipped: skipped.length,
      emailed: results.filter((r) => r.emailed).length,
      creditOwed: Math.round(creditOwed * 100) / 100,
      additionalDue: Math.round(additionalDue * 100) / 100,
      unresolvedCredit,
    },
    results,
    notes: [
      "The plan's own price list was not changed — save the membership to update it for new purchases.",
      "Skipped members keep their current price until they cancel and re-sign.",
      ...(unresolvedCredit > 0
        ? [`${unresolvedCredit} updated member${unresolvedCredit === 1 ? "" : "s"} had no computable unused-time credit — settle those by hand.`]
        : []),
    ],
  });
}
