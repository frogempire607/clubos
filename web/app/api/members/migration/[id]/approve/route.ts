import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe, billingPeriodToStripeInterval } from "@/lib/stripe";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";
import { recurringUnitWithFee } from "@/lib/fees";
import { MIGRATION_STATUS, resolveBillingAnchor } from "@/lib/migration";
import { sendMembershipActivatedEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { writeBillingAudit } from "@/lib/billingAudit";
import { addBillingPeriod } from "@/lib/billingAdmin";
import { resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import { resolveStaffDiscount, quotePayment } from "@/lib/staffPayments";
import { recordDiscountUse } from "@/lib/discounts";

// Athlete (or guardian for minors) contact email for activation/approval notices.
function memberContactEmail(m: { isMinor: boolean; email: string | null; guardianEmail: string | null }) {
  return m.isMinor ? m.guardianEmail || m.email : m.email || m.guardianEmail;
}

// POST /api/members/migration/[id]/approve
// Owner reviews a PENDING_APPROVAL migration and approves billing. ONLY here
// is the recurring subscription created (off the card the client saved during
// activation), with the first charge anchored to the agreed billing date.
// Owner/staff with members:edit. Never charges on approval day — trial_end
// holds the first charge until the billing anchor.
const schema = z.object({
  // Owner's final billing date (matches old software cycle or manual edit).
  // If omitted we use requestedBillingDate (if accepting it) → billingAnchor.
  billingAnchorDate: z.string().optional().nullable(),
  acceptRequestedDate: z.boolean().optional().default(false),
  // Explicit owner opt-in to bill this member OFFLINE (cash/check/manual) even
  // though card billing looked intended. Without this, a card-intended member
  // whose Stripe card setup is incomplete is BLOCKED with an actionable error
  // instead of being silently dropped onto manual billing.
  forceManual: z.boolean().optional().default(false),
  // The resolved billing date being today/past means approval charges NOW.
  // That must never happen silently — the caller has to acknowledge it
  // explicitly (the UI shows a second, unmissable confirmation).
  confirmImmediateCharge: z.boolean().optional().default(false),
  // Approve the PROFILE only: staff reviewed/accepted the account setup.
  // Creates NO membership, NO subscription, NO charge; the member stays
  // PROSPECT until a real membership is purchased or assigned. This is the
  // correct action for a completed profile with no membership configured.
  profileOnly: z.boolean().optional().default(false),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Approval STARTS BILLING — that's financial control, so it requires the
  // explicit billing permission (owners bypass; a coach with members:edit
  // can run the roster but can no longer start charges).
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: { club: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (member.migrationStatus === MIGRATION_STATUS.COMPLETED) {
    return NextResponse.json({ error: "This migration is already complete." }, { status: 409 });
  }
  const club = member.club;

  // ── Profile-only approval ────────────────────────────────────────────────
  // "Approved" must not mean "Active member": this branch closes the review
  // without touching membership, billing, or status. Status stays whatever
  // the subscription truth says (PROSPECT when they've never had one).
  if (body.profileOnly) {
    await prisma.member.update({
      where: { id: member.id },
      data: {
        approvalStatus: "APPROVED",
        migrationStatus: MIGRATION_STATUS.COMPLETED,
        migrationCompletedAt: new Date(),
      },
    });
    await writeBillingAudit({
      clubId: club.id,
      memberId: member.id,
      actorUserId: session.user.id ?? null,
      action: "PROFILE_APPROVED_NO_MEMBERSHIP",
      before: { approvalStatus: member.approvalStatus, migrationStatus: member.migrationStatus },
      after: { approvalStatus: "APPROVED", migrationStatus: MIGRATION_STATUS.COMPLETED },
      note: "Profile setup approved — no membership, subscription, or charge was created; member remains a prospect until a real membership is purchased or assigned.",
    });
    return NextResponse.json({ ok: true, profileOnly: true, noMembership: true });
  }

  // ── Nothing-configured guard ─────────────────────────────────────────────
  // Approving a member with NO plan, NO purchase option, NO price override,
  // and NO imported membership used to fall through every pricing fallback to
  // a $0 plan literally named "Continued membership" — manufacturing a fake
  // free membership and flipping the member ACTIVE. Refuse instead: the owner
  // must configure something (or explicitly mark them free via a $0 price
  // override) before approval means anything.
  const nothingConfigured =
    !member.migrationMembershipId &&
    !member.migrationSelectedOption &&
    member.migrationPriceOverride == null &&
    !member.legacyMembershipName &&
    member.legacyMembershipPrice == null;
  if (nothingConfigured) {
    return NextResponse.json(
      {
        error: "Nothing is configured to approve",
        code: "NOTHING_CONFIGURED",
        message:
          "This member has no membership plan, no purchase option, no imported plan, and no price set. Open their setup (or the billing control center) and assign a plan — or explicitly mark them free with a $0 price override — before approving. Nothing was changed.",
      },
      { status: 409 },
    );
  }

  // Resolve the agreed billing anchor.
  let anchor: Date | null = null;
  if (body.billingAnchorDate) {
    const d = new Date(body.billingAnchorDate);
    if (!isNaN(d.getTime())) anchor = d;
  } else if (body.acceptRequestedDate && member.requestedBillingDate) {
    anchor = member.requestedBillingDate;
  } else {
    anchor = member.billingAnchorDate;
  }
  // No explicit date anywhere → derive one from the imported start date.
  if (!anchor) {
    anchor = resolveBillingAnchor({
      nextBillingDate: null,
      membershipStartDate: member.membershipStartDate,
      frequency: member.legacyBillingFrequency,
      now: new Date(),
    });
  }
  // If the agreed billing date already passed (member activated late), the
  // missed charge is collected NOW and the cycle recurs every frequency from
  // this charge — we do not skip ahead to the next cycle.
  const billsImmediately = !anchor || anchor.getTime() <= Date.now() + 60_000;
  if (billsImmediately) anchor = new Date();

  // Resolve the plan: owner-assigned Membership first, else legacy snapshot.
  // NO "Continued membership" fallback — the NOTHING_CONFIGURED guard above
  // already refused unconfigured members, and the mint-a-plan branch below
  // additionally requires a real (legacy) plan NAME.
  let planName = member.legacyMembershipName || "No membership";
  let price = member.legacyMembershipPrice ? Number(member.legacyMembershipPrice) : 0;
  let period = member.legacyBillingFrequency || "MONTHLY";
  let membershipId = member.migrationMembershipId;
  // Owner's plan-level Auto Renew setting; true when no plan is assigned
  // (legacy snapshot members keep today's renewing behavior).
  let planAutoRenew = true;
  if (membershipId) {
    const plan = await prisma.membership.findFirst({
      where: { id: membershipId, clubId: club.id, deletedAt: null },
      select: { id: true, name: true, options: true, autoRenewDefault: true },
    });
    if (plan) {
      planName = plan.name;
      planAutoRenew = plan.autoRenewDefault;
      try {
        const opts = JSON.parse((plan.options as unknown as string) || "[]");
        if (Array.isArray(opts) && opts[0]) {
          if (typeof opts[0].price === "number") price = opts[0].price;
          if (opts[0].billingPeriod) period = opts[0].billingPeriod;
        }
      } catch {
        /* keep legacy snapshot values */
      }
    } else {
      membershipId = null;
    }
  }

  // #5: honor the option the member chose at registration over the plan
  // default (the owner's explicit price override below still wins).
  if (member.migrationSelectedOption && typeof member.migrationSelectedOption === "object") {
    const sel = member.migrationSelectedOption as { price?: unknown; billingPeriod?: unknown };
    if (typeof sel.price === "number") price = sel.price;
    if (typeof sel.billingPeriod === "string" && sel.billingPeriod) period = sel.billingPeriod;
  }

  // Owner price override set before activation wins over every other source.
  if (member.migrationPriceOverride != null) {
    price = Number(member.migrationPriceOverride);
  }

  // Staff-selected discount applies on DIRECT activation exactly like it does
  // on the offer path — same engine, validated here, invalid = hard block.
  let appliedDiscount: { id: string; code: string; amountOff: number } | null = null;
  if (member.migrationDiscountCode && price > 0) {
    const resolved = await resolveStaffDiscount(club.id, member.migrationDiscountCode, {
      type: "MEMBERSHIP",
      membershipId: member.migrationMembershipId,
    });
    if (!resolved.ok) {
      return NextResponse.json(
        { error: `The selected discount can't be applied: ${resolved.error} Fix or clear it in the billing center. Nothing was changed.`, code: "DISCOUNT_INVALID" },
        { status: 400 },
      );
    }
    if (resolved.discount) {
      const q = quotePayment({ originalPrice: price, discount: resolved.discount, method: "CASH", passProcessingFees: false });
      if (!q.ok) return NextResponse.json({ error: q.error, code: "DISCOUNT_INVALID" }, { status: 400 });
      appliedDiscount = { id: resolved.discount.id, code: resolved.discount.code, amountOff: q.quote.discountAmount };
      price = q.quote.finalPrice;
    }
  }

  if (!membershipId) {
    // Minting a plan here is ONLY for members with a real imported plan name
    // (their WellnessLiving membership carried over). Never fabricate a
    // placeholder plan for a member who has nothing — assign a real
    // Membership in the billing center instead.
    if (!member.legacyMembershipName) {
      return NextResponse.json(
        {
          error:
            "This member has no membership plan assigned and no imported plan name. Assign a real membership in the billing center before approving billing — or approve the profile only (profileOnly).",
          code: "PLAN_REQUIRED",
        },
        { status: 409 },
      );
    }
    const created = await prisma.membership.create({
      data: {
        clubId: club.id,
        name: planName,
        options: JSON.stringify([{ label: "Imported", price, billingPeriod: period }]),
      },
    });
    membershipId = created.id;
  }

  // Manual / no-online-payment path: complete without Stripe.
  // Was OFFLINE billing genuinely intended? Only these cases legitimately end up
  // on a MANUAL (offline) subscription: a free/$0 plan, the club has no online
  // payments, or the member explicitly chose cash/check.
  const offlineIntended =
    price <= 0 ||
    !club.stripeAccountId ||
    !club.stripeChargesEnabled ||
    member.requestedPaymentMethod === "CASH" ||
    member.requestedPaymentMethod === "CHECK";

  // A CASH/CHECK member NEVER gets a Stripe subscription — even with a saved
  // card on file. Without the !offlineIntended term, approving a cash member
  // whose family happened to have a card/Link saved would card-charge them
  // (Adelynn Bergen near-miss, 2026-07-15).
  const canCharge =
    !offlineIntended &&
    !!club.stripeAccountId &&
    !!club.stripeChargesEnabled &&
    price > 0 &&
    !!member.stripeSetupCustomerId &&
    !!member.stripeSetupPaymentMethodId;

  // Card billing was intended but Stripe setup is incomplete (no captured
  // payment method — almost always the missing Connect webhook). Previously this
  // SILENTLY created a manual/offline subscription, so a member who should have
  // been charged was quietly never billed. Now: block with an actionable error
  // and do NOT start any subscription, unless the owner explicitly forces manual.
  // ── Existing-subscription preflight (same protection as reactivation
  // confirm). Approving a member who ALREADY has a live Stripe subscription
  // would mint a second one and double-bill them — block with an actionable
  // error instead. Checked locally AND live against Stripe on every customer
  // id we know for this member; the live check fails CLOSED (billing must be
  // verifiable before it starts).
  const localLive = await prisma.memberSubscription.findFirst({
    where: {
      memberId: member.id,
      stripeSubscriptionId: { not: null },
      status: { in: ["active", "past_due"] },
    },
    select: { id: true, optionLabel: true },
  });
  if (localLive) {
    return NextResponse.json(
      {
        error: "This member already has a live Stripe subscription — approving again would double-bill them",
        code: "ALREADY_SUBSCRIBED",
        message: `A live subscription ("${localLive.optionLabel}") already exists. Review it in the billing control center; nothing was created or charged.`,
      },
      { status: 409 },
    );
  }
  if (canCharge) {
    const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid"];
    for (const custId of [member.stripeSetupCustomerId, member.stripeCustomerId]) {
      if (!custId) continue;
      try {
        const subs = await stripe.subscriptions.list(
          { customer: custId, status: "all", limit: 20 },
          { stripeAccount: club.stripeAccountId! },
        );
        if (subs.data.some((s) => LIVE_STATUSES.includes(s.status))) {
          return NextResponse.json(
            {
              error: "This member already has a live subscription in the club's Stripe — approving again would double-bill them",
              code: "ALREADY_SUBSCRIBED",
              message:
                "Stripe shows a live subscription on this member's customer. Run a billing sync or review them in the billing control center; nothing was created or charged.",
            },
            { status: 409 },
          );
        }
      } catch (e) {
        console.error("Approve: live-subscription preflight failed:", e);
        return NextResponse.json(
          { error: "Stripe couldn't be reached to verify existing billing. Nothing was charged — try again in a minute." },
          { status: 502 },
        );
      }
    }
  }

  // A past/today billing date means the charge runs NOW. Never silently: the
  // caller must acknowledge the immediate charge explicitly (the migration
  // drawer and billing control center both surface a second confirmation).
  if (canCharge && billsImmediately && !body.confirmImmediateCharge) {
    return NextResponse.json(
      {
        error: "This approval would charge the saved card immediately",
        code: "IMMEDIATE_CHARGE_CONFIRM_REQUIRED",
        message:
          "The billing date is today or already passed, so approving will charge the saved card right now. Pick a new future billing date, or resubmit with the immediate charge explicitly confirmed.",
        price,
      },
      { status: 409 },
    );
  }

  if (!canCharge && !offlineIntended && !body.forceManual) {
    return NextResponse.json(
      {
        error: "Card setup incomplete — billing not started",
        code: "CARD_SETUP_INCOMPLETE",
        message: member.stripeSetupCustomerId
          ? "This member started card setup, but Stripe never returned a saved payment method (usually a missing/failed Connect webhook). Billing was NOT started and they were NOT set to manual. Fix the Connect webhook or run the payment-method backfill, then approve again — or resend the card-setup link. To bill this member offline instead, approve again with forceManual."
          : "This member has no saved card on file yet. Send them the card-setup link (or import a payment method), then approve again. To bill this member offline instead, approve again with forceManual.",
      },
      { status: 409 },
    );
  }

  if (!canCharge) {
    // Free ($0) or manually-billed membership: there's no Stripe charge, but the
    // member is still APPROVED and ACTIVE with their plan attached. Previously
    // this path only flipped the migration flags and left the member as PROSPECT
    // with no membership — so a $0/grandfathered or cash member never went live.
    // Record a MANUAL subscription so the membership shows in their portal and
    // can be canceled like any other.
    await prisma.memberSubscription.create({
      data: {
        memberId: member.id,
        membershipId: membershipId!,
        optionLabel: planName,
        price,
        billingPeriod: period,
        billingType: "MANUAL",
        autoRenew: false,
        status: "active",
        ...(appliedDiscount ? { discountCode: appliedDiscount.code, discountAmount: appliedDiscount.amountOff } : {}),
        startDate: member.membershipStartDate ?? new Date(),
        billingAnchorDate: anchor,
        // Explicit requested end wins; otherwise a non-renewing plan ends
        // after its first billing period (expireEndedManualSubscriptions).
        ...(member.requestedCancellationDate
          ? { endDate: member.requestedCancellationDate }
          : !planAutoRenew && price > 0
            ? { endDate: addBillingPeriod(anchor ?? member.membershipStartDate ?? new Date(), period) }
            : {}),
        notes:
          price <= 0
            ? "Free / grandfathered membership — no recurring charge"
            : `Manual billing — ${club.name} collects payment offline`,
      },
    });
    await prisma.member.update({
      where: { id: member.id },
      data: {
        migrationStatus: MIGRATION_STATUS.COMPLETED,
        approvalStatus: "APPROVED",
        status: "ACTIVE",
        membershipId,
        ...(anchor ? { billingAnchorDate: anchor } : {}),
        ...(member.requestedCancellationDate ? { commitmentEndDate: member.requestedCancellationDate } : {}),
        migrationCompletedAt: new Date(),
      },
    });
    // Paid cash/check activation: record the amount DUE as a PENDING
    // transaction (never revenue, no receipt) so staff can mark it received
    // in the billing center / Approvals — same lifecycle as offer acceptance.
    if (price > 0 && (member.requestedPaymentMethod === "CASH" || member.requestedPaymentMethod === "CHECK")) {
      const dueMethod = member.requestedPaymentMethod;
      const existingDue = await prisma.transaction.findFirst({
        where: { clubId: club.id, memberId: member.id, status: "PENDING", paymentSource: dueMethod },
        select: { id: true },
      });
      if (!existingDue) {
        await prisma.transaction.create({
          data: {
            clubId: club.id,
            memberId: member.id,
            amount: price,
            status: "PENDING",
            type: "MEMBERSHIP",
            category: "memberships",
            paymentMethod: dueMethod,
            paymentSource: dueMethod,
            reconciliationStatus: "OFFLINE",
            manual: true,
            ...(appliedDiscount ? { discountCode: appliedDiscount.code, discountAmount: appliedDiscount.amountOff } : {}),
            description: `Membership payment due: ${planName} — awaiting ${dueMethod.toLowerCase()}`,
            notes: "Created at owner activation (cash/check). Record receipt via the billing center — only then does this become paid revenue and send a receipt.",
          },
        });
      }
    }
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: club.id,
        memberId: member.id,
        type: "COMPLETED",
        message:
          price <= 0
            ? "Approved — free/grandfathered membership; active with no recurring charge."
            : "Approved — active; club handles billing manually (no card on file / online payments off).",
        actorUserId: session.user.id,
      },
    });
    await writeBillingAudit({
      clubId: club.id,
      memberId: member.id,
      actorUserId: session.user.id,
      action: "MIGRATION_APPROVED",
      before: { migrationStatus: member.migrationStatus, approvalStatus: member.approvalStatus },
      after: { billingType: "MANUAL", plan: planName, price, period, anchor: anchor?.toISOString() ?? null },
      note: price <= 0 ? "Approved as free/grandfathered (no charge)." : "Approved on manual/offline billing.",
    });
    const toNoPay = memberContactEmail(member);
    if (toNoPay) {
      sendMembershipActivatedEmail({
        to: toNoPay,
        firstName: member.firstName,
        clubName: club.name,
        membershipName: planName,
        nextBillingDate: anchor,
        portalUrl: `${getAppBaseUrl()}/member`,
      }).catch((e) => console.error("Approval email failed:", e));
    }
    if (appliedDiscount) await recordDiscountUse(appliedDiscount.id);
    return NextResponse.json({ ok: true, noPayment: true });
  }

  // Create the recurring subscription off the saved card. trial_end anchors
  // the FIRST charge to the agreed date so nobody is billed on approval day.
  const trialEnd =
    anchor && anchor.getTime() > Date.now() + 60_000 ? Math.floor(anchor.getTime() / 1000) : undefined;
  // #5: if the member requested a cancellation/end date, schedule the Stripe
  // subscription to auto-cancel then. Must be in the future and after any
  // trial_end, or Stripe rejects it.
  let cancelSource = member.requestedCancellationDate ?? member.commitmentEndDate ?? null;
  // Plan-level Auto Renew OFF with no explicit end date: the subscription
  // ends after its FIRST billing period, measured from the first charge.
  if (!cancelSource && !planAutoRenew) {
    cancelSource = addBillingPeriod(anchor ?? new Date(), period);
  }
  let cancelAtUnix: number | undefined;
  if (cancelSource && cancelSource.getTime() > Date.now() + 60_000) {
    const ts = Math.floor(cancelSource.getTime() / 1000);
    if (!trialEnd || ts > trialEnd) cancelAtUnix = ts;
  }
  const amountCents = recurringUnitWithFee(Math.round(price * 100), club.passProcessingFees);
  const interval = billingPeriodToStripeInterval(period) || { interval: "month" as const, interval_count: 1 };

  // VERIFY the saved payment method is still attached before charging — a
  // family that replaced their card leaves a stale pointer, and Stripe then
  // errors "payment method must be attached to the customer" (Mack Munroe,
  // 2026-07-15). Falls back to the customer's default / only method (card OR
  // Link wallet) and persists the correction.
  const chargePmId = await resolveChargeablePaymentMethodId(
    member.stripeSetupCustomerId,
    club.stripeAccountId,
    member.stripeSetupPaymentMethodId,
  );
  if (!chargePmId) {
    return NextResponse.json(
      {
        error:
          "The saved payment method is no longer attached to this member's billing account (it was likely replaced or removed). Send the card-setup link again, or approve with forceManual to bill offline. Nothing was charged.",
        code: "CARD_SETUP_INCOMPLETE",
      },
      { status: 409 },
    );
  }
  if (chargePmId !== member.stripeSetupPaymentMethodId) {
    await prisma.member.update({
      where: { id: member.id },
      data: { stripeSetupPaymentMethodId: chargePmId },
    });
  }

  let memberSub;
  try {
    // Subscription price_data needs an existing Product (no inline product_data
    // like Checkout). Reuse the plan's reusable catalog Product so every
    // migrated member on a plan shares ONE Stripe product, instead of minting a
    // throwaway "continued from…" product per member (which littered the
    // catalog). Fall back to a plan-scoped product only if catalog sync hiccups
    // — never block activation.
    const catalogMembership = await prisma.membership.findFirst({
      where: { id: membershipId!, clubId: club.id },
      select: { id: true, clubId: true, name: true, description: true, stripeProductId: true, stripePriceIds: true },
    });
    let productId = catalogMembership ? await ensureMembershipProduct(catalogMembership, club) : null;
    if (!productId) {
      const product = await stripe.products.create(
        {
          name: planName,
          metadata: { athletixMembershipId: membershipId!, clubId: club.id, kind: "membership" },
        },
        { stripeAccount: club.stripeAccountId! },
      );
      productId = product.id;
    }
    const sub = await stripe.subscriptions.create(
      {
        customer: member.stripeSetupCustomerId!,
        default_payment_method: chargePmId,
        items: [
          {
            price_data: {
              currency: "usd",
              product: productId,
              unit_amount: amountCents,
              recurring: interval,
            },
          },
        ],
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        ...(cancelAtUnix ? { cancel_at: cancelAtUnix } : {}),
        application_fee_percent: 0,
        metadata: { migrationMemberId: member.id, clubId: club.id },
      },
      {
        stripeAccount: club.stripeAccountId!,
        // A double-submit (double click, retry after a network blip) must not
        // fork a second subscription — Stripe returns the first one instead.
        // Param-sensitive: double-clicks with IDENTICAL params dedupe to one
        // subscription, but a corrected retry (fixed payment method, new
        // discount/price/date) gets a fresh key. A static per-member key gets
        // permanently "burned" by any failed attempt — Stripe then rejects
        // every retry with "keys can only be used with the same parameters"
        // (Mack Munroe, 2026-07-15).
        idempotencyKey: `aox-migration-approve-${member.id}-${crypto
          .createHash("sha256")
          .update(JSON.stringify({ amountCents, trialEnd: trialEnd ?? null, cancelAtUnix: cancelAtUnix ?? null, pm: chargePmId, product: productId }))
          .digest("hex")
          .slice(0, 12)}`,
      },
    );

    memberSub = await prisma.memberSubscription.create({
      data: {
        memberId: member.id,
        membershipId: membershipId!,
        optionLabel: planName,
        price,
        billingPeriod: period,
        billingType: "RECURRING",
        autoRenew: planAutoRenew,
        status: sub.status === "active" || sub.status === "trialing" ? "active" : "pending",
        startDate: member.membershipStartDate ?? new Date(),
        billingAnchorDate: anchor,
        ...(cancelAtUnix ? { endDate: new Date(cancelAtUnix * 1000) } : {}),
        stripeSubscriptionId: sub.id,
        stripePriceId: sub.items?.data?.[0]?.price?.id ?? null,
        ...(appliedDiscount ? { discountCode: appliedDiscount.code, discountAmount: appliedDiscount.amountOff } : {}),
        notes: `Migrated from ${member.legacySource || "previous software"} — approved by club`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Could not start the subscription: ${String(e)}` }, { status: 502 });
  }

  await prisma.member.update({
    where: { id: member.id },
    data: {
      migrationStatus: MIGRATION_STATUS.COMPLETED,
      approvalStatus: "APPROVED",
      membershipId,
      ...(anchor ? { billingAnchorDate: anchor } : {}),
      ...(member.requestedCancellationDate ? { commitmentEndDate: member.requestedCancellationDate } : {}),
      migrationCompletedAt: new Date(),
      status: "ACTIVE",
    },
  });
  await prisma.memberMigrationEvent.create({
    data: {
      clubId: club.id,
      memberId: member.id,
      type: "COMPLETED",
      message: billsImmediately
        ? `Approved — billing date had passed, so the cycle charge ran at approval and recurs ${period.toLowerCase()} from today (${planName})`
        : `Approved — billing continues ${anchor ? `from ${anchor.toLocaleDateString()}` : "on file"} (${planName})`,
      actorUserId: session.user.id,
    },
  });

  await writeBillingAudit({
    clubId: club.id,
    memberId: member.id,
    actorUserId: session.user.id,
    action: "MIGRATION_APPROVED",
    before: { migrationStatus: member.migrationStatus, approvalStatus: member.approvalStatus },
    after: {
      billingType: "RECURRING",
      plan: planName,
      price,
      period,
      anchor: anchor?.toISOString() ?? null,
      chargedImmediately: billsImmediately,
    },
    note: billsImmediately
      ? "Approved with an explicitly confirmed immediate charge."
      : `Approved — first charge anchored to ${anchor?.toLocaleDateString() ?? "the saved date"}.`,
  });

  const toPaid = memberContactEmail(member);
  if (toPaid) {
    sendMembershipActivatedEmail({
      to: toPaid,
      firstName: member.firstName,
      clubName: club.name,
      membershipName: planName,
      amountPaid: billsImmediately ? `$${price.toFixed(2)}` : undefined,
      nextBillingDate: billsImmediately ? null : anchor,
      portalUrl: `${getAppBaseUrl()}/member`,
    }).catch((e) => console.error("Approval email failed:", e));
  }

  if (appliedDiscount) await recordDiscountUse(appliedDiscount.id);
  return NextResponse.json({ ok: true, subscriptionId: memberSub.stripeSubscriptionId });
}
