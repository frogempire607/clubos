// When does recording attendance need a billing decision first?
//
// PURE. No prisma, no Date.now(), no network — callers load the rows and pass
// them in, which is what lets every branch be constructed by hand in
// scripts/attendance-billing-tests.ts.
//
// ── What this is for ────────────────────────────────────────────────────────
//
// Staff add somebody to a roster and mark them present. If that person holds
// no membership, the session is recorded and nothing is ever billed — no
// prompt, no chip, no error. Roughly 17 people accumulated unbilled training
// that way before anybody noticed, and the only reason it surfaced at all was
// the "Attending, no active membership" queue being read by hand.
//
// lib/entitlements.shouldWarn() deliberately does NOT warn on
// NO_ACTIVE_MEMBERSHIP, on the grounds that the member/non-member/drop-in
// pricing tiers already cover it. That reasoning is what the 17 disprove: the
// tiers exist, but nothing makes staff pass through them. So this check sits
// BESIDE coverage rather than inside it, and asks a narrower question that does
// not depend on the class at all.
//
// ── The membership question, and the only form it may take ──────────────────
//
// "Does an active MemberSubscription ROW exist for this member." Nothing else.
//
// NOT Member.status — measured 2026-09-13, three PROSPECT members held active
// subscriptions, i.e. the status column lags the subscriptions it describes.
// NOT countsAsMembership() — that predicate is deliberately NARROWER (it wants
// proof money arrived for a priced row), and using it here would prompt on
// members who are genuinely on a plan, which trains staff to click through the
// prompt. Events, private lessons and class booking all ask the row question;
// this asks the same one, so a person who gets member pricing never gets
// prompted. See scripts/member-tracks-tests.ts.

/**
 * Statuses that mean "they were in the room and trained".
 *
 * LATE is included: it records attendance exactly as PRESENT does and bills
 * exactly as little. ABSENT records a non-attendance and is never billable.
 * TRIAL and DROP_IN are each already a billing decision — they ARE the two
 * answers the prompt offers, so prompting on them would be a loop.
 */
export const BILLABLE_ATTENDANCE_STATUSES = ["PRESENT", "LATE"] as const;

export type BillableAttendanceStatus = (typeof BILLABLE_ATTENDANCE_STATUSES)[number];

export function isBillableAttendanceStatus(status: string): status is BillableAttendanceStatus {
  return (BILLABLE_ATTENDANCE_STATUSES as readonly string[]).includes(status);
}

export type NoMembershipCheckInput = {
  status: string;
  /**
   * Rows in MemberSubscription with status 'active'. A COUNT, not a verdict —
   * the caller must not pre-judge which rows "really" count.
   */
  activeSubscriptionCount: number;
  /** Member.trialEndsAt is in the future — the club already made this decision. */
  trialWindowActive: boolean;
  /** The record for this session already carries money (AttendanceRecord.amountCharged). */
  alreadyCharged: boolean;
  /** The caller saw the prompt and chose to record it anyway. */
  confirmed: boolean;
};

/**
 * Should this write stop and ask first?
 *
 * Three deliberate ways to skip the prompt, each because the billing decision
 * has ALREADY been made:
 *
 *   · an active subscription row exists — they are on a plan;
 *   · a free-trial window is running — the club granted it, with an end date.
 *     Prompting on day 2 through 7 of a 7-day trial is the fastest way to teach
 *     somebody that the prompt is noise;
 *   · this session's record already carries money — they paid at the door, and
 *     a coach correcting DROP_IN to PRESENT afterwards is not a new decision.
 */
export function needsNoMembershipConfirmation(input: NoMembershipCheckInput): boolean {
  if (input.confirmed) return false;
  if (!isBillableAttendanceStatus(input.status)) return false;
  if (input.activeSubscriptionCount > 0) return false;
  if (input.trialWindowActive) return false;
  if (input.alreadyCharged) return false;
  return true;
}

/** The one front-desk sentence, for the 409 body. */
export function noMembershipMessage(firstName: string): string {
  return `${firstName} has no active membership — choose how to record this session.`;
}

/**
 * THIS class's drop-in price, or null.
 *
 * Reads the `dropin` tier and NOTHING else. No `?? nonmember`, no `?? member`,
 * no club-wide default — there is no club-level drop-in price in the schema to
 * fall back to, and the two tiers next door answer different questions.
 *
 * The fallback chain this replaces was `dropin ?? nonmember ?? member ?? 0`,
 * which reaches the MEMBER price to prefill an amount for somebody who has no
 * membership — the exact person the prompt exists for. It could not misfire on
 * 2026-09-13 (all six live classes set `dropin`; none sets `member` or
 * `nonmember`), which is what a latent wrong number looks like before it fires.
 *
 * Null means "not set", and every caller must render it as an EMPTY amount box,
 * never as 0. A blank box is a coach typing the right number; a wrong prefill is
 * a coach accepting the wrong one.
 */
export function classDropInPrice(pricingOptions: unknown): number | null {
  if (!Array.isArray(pricingOptions)) return null;
  const dropin = (pricingOptions as Array<{ type?: string; price?: unknown }>).find(
    (o) => o?.type === "dropin",
  );
  return typeof dropin?.price === "number" && Number.isFinite(dropin.price) ? dropin.price : null;
}
