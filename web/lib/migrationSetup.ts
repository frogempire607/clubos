// Retiring "Advanced billing" (2026-09-28) — the pure rules behind the small
// "Migration setup" page that replaced it.
//
// ── Why the old page went ────────────────────────────────────────────────────
// The 1,600-line billing page mixed two different things: a MIGRATION SETUP
// (a draft of what an imported member will be billed once they activate —
// saving it charges nobody and changes nothing live) and the live billing
// controls. Its "Edit billing setup" dialog had a "Payment method" field that
// only edited the draft. A staffer set a live Stripe member to Cash there
// because the parent paid cash; Stripe kept charging, as it should — the field
// never touched live billing.
//
// So: every day-to-day billing action lives in the Membership panel on the
// profile, and this page keeps ONLY the migration pieces, ONLY for members
// whose migration is not finished. Once any membership is live the setup form
// offers no payment-method / plan / price fields at all — just a line pointing
// at the panel. That is what makes the mistake impossible rather than
// discouraged.
//
// PURE — no Prisma, no fetch. Verified by scripts/billing-retire-tests.ts.

/** Subscription statuses that mean "billing for this member is real now". */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "past_due", "pending"] as const;

/** True when ANY membership row is live — Stripe or offline, either way. */
export function billingIsLive(subs: ReadonlyArray<{ status: string }>): boolean {
  return subs.some((s) => (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status));
}

export type MigrationFacts = {
  /** Arrived via import/migration (lib/memberTracks isImported). */
  imported: boolean;
  /** IMPORTED | INVITED | ACTIVATED | COMPLETED | FAILED | NEEDS_REVIEW | null */
  migrationStatus: string | null | undefined;
  migrationCompletedAt?: string | Date | null;
};

/**
 * Is this member still mid-migration? Same definition as the 7-step meter's
 * last step (lib/memberTracks migrationMeterFor): complete means
 * migrationStatus COMPLETED or migrationCompletedAt stamped. A member who
 * never came through an import has no migration to finish.
 */
export function migrationInProgress(f: MigrationFacts): boolean {
  if (!f.imported && !f.migrationStatus) return false;
  if (f.migrationStatus === "COMPLETED") return false;
  if (f.migrationCompletedAt) return false;
  return true;
}

/** Where every billing link now lands: the Membership panel on the profile. */
export function membershipPanelHref(memberId: string, extra?: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams({ tab: "memberships" });
  for (const [k, v] of Object.entries(extra ?? {})) if (v != null && v !== "") qs.set(k, v);
  return `/dashboard/members/${encodeURIComponent(memberId)}?${qs.toString()}`;
}

export function migrationSetupHref(memberId: string): string {
  return `/dashboard/members/${encodeURIComponent(memberId)}/billing`;
}

/**
 * Query keys older code put on /billing links that still mean something on
 * the profile: `changePlan` + `option` (Change plan dialog), `enrol` (record a
 * payment), and the Stripe card-setup return flags.
 */
export const PASS_THROUGH_KEYS = ["changePlan", "option", "enrol", "card_saved", "card_canceled", "intent"] as const;

export type BillingPageDecision =
  | { kind: "SHOW" }
  | { kind: "REDIRECT"; to: string; reason: "NOT_MIGRATING" | "LIVE_ACTION" };

/**
 * What /dashboard/members/<id>/billing does for this member.
 *
 *  · not migrating                → the profile's memberships tab (old links and
 *                                   bookmarks keep working; deep-link params
 *                                   ride along)
 *  · ?changePlan=…                → always the profile: changing a live plan is
 *                                   a Membership-panel action, never a setup edit
 *  · ?enrol=1 once billing is live→ the profile (recording a payment against a
 *                                   live membership is day-to-day billing)
 *  · otherwise                    → show Migration setup
 */
export function billingPageDecision(input: {
  memberId: string;
  migrating: boolean;
  live: boolean;
  query: Record<string, string | null | undefined>;
}): BillingPageDecision {
  const pass: Record<string, string | null | undefined> = {};
  for (const k of PASS_THROUGH_KEYS) pass[k] = input.query[k];
  const to = membershipPanelHref(input.memberId, pass);
  if (!input.migrating) return { kind: "REDIRECT", to, reason: "NOT_MIGRATING" };
  if (input.query.changePlan) return { kind: "REDIRECT", to, reason: "LIVE_ACTION" };
  if (input.query.enrol && input.live) return { kind: "REDIRECT", to, reason: "LIVE_ACTION" };
  return { kind: "SHOW" };
}

export type MigrationSetupState = {
  live: boolean;
  /** The server says the setup can be activated (billing-admin `activation.available`). */
  activationAvailable: boolean;
  /** An activation link is out / awaiting approval. */
  pendingActivation: boolean;
  hasReactivationOffer: boolean;
};

export type MigrationSetupSections = {
  /** The one line that replaces the setup form once billing is live. */
  liveNotice: boolean;
  /** Setup summary + Edit (plan, option, price, payment method, dates, payer). */
  setupEdit: boolean;
  /** "Activate this setup now" (saved card or cash/check). */
  activate: boolean;
  /** "Already paid?" — money in hand, no membership yet (offline activation). */
  alreadyPaid: boolean;
  /** Card collection for the activation charge. */
  paymentMethods: boolean;
  /** Reactivation offer card (view always; create only before billing is live). */
  reactivation: boolean;
  createOffer: boolean;
  /** Migration triage: note always; final billing date only before live. */
  triage: boolean;
  triageFinalDate: boolean;
  /** Cancel a pending activation. */
  cancelPendingActivation: boolean;
  /** Billing & migration history. */
  history: boolean;
};

/** Which parts of Migration setup render for this member's state. */
export function migrationSetupSections(s: MigrationSetupState): MigrationSetupSections {
  const draft = !s.live;
  return {
    liveNotice: s.live,
    setupEdit: draft,
    activate: draft && s.activationAvailable,
    alreadyPaid: draft,
    paymentMethods: draft,
    reactivation: draft || s.hasReactivationOffer,
    createOffer: draft,
    triage: true,
    triageFinalDate: draft,
    cancelPendingActivation: s.pendingActivation,
    history: true,
  };
}

export const LIVE_BILLING_NOTICE =
  "Billing is live. Change how they pay, dates, refunds and waivers in the Membership panel →";
