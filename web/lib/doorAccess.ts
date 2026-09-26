// The door rule — what happens when somebody checks in to a CLASS without a
// coach deciding for them (the attendance QR / My Bookings check-in) and what
// the front-desk walk-in flow offers. PURE.
//
// Julian's rule (2026-09-25): no membership that covers this class → the free
// trial if they can still have one, otherwise they pay the drop-in.
//
//   covered by a membership ............ PRESENT
//   free-trial window already running .. TRIAL (no charge — the club granted it)
//   no plan, trial still available ..... START_TRIAL (grant the window, TRIAL)
//   otherwise .......................... PAY the class's drop-in
//
// Two escape hatches, both deliberate:
//   · the class has NO drop-in price set → there is nothing to charge, so let
//     them in (PRESENT) and the unbilled-training queue picks it up. Turning a
//     child away at the door over a missing price is the wrong failure.
//   · "I'll pay cash at the desk" → checked in, flagged for the coach.

export type DoorInput = {
  /** A membership covers this session (lib/entitlements verdict, fail-open reasons count). */
  covered: boolean;
  /** Any active subscription at all — decides trial eligibility (trials are for people with NO plan). */
  hasActiveSubscription: boolean;
  /** Member.trialEndsAt is in the future. */
  trialWindowActive: boolean;
  /** The club's trial offer reaches this class (lib/freeTrial.trialCoversClass). */
  trialCoversClass: boolean;
  /** Days a NEW trial would grant, or null (offer off / already used and not renewable). */
  newTrialDays: number | null;
  /** The class's drop-in price, or null when not set. */
  dropInPrice: number | null;
  /** The athlete chose to pay cash at the desk. */
  payAtDesk?: boolean;
};

export type DoorDecision =
  | { kind: "PRESENT"; reason: "COVERED" | "NO_PRICE_SET" }
  | { kind: "TRIAL"; reason: "TRIAL_RUNNING" }
  | { kind: "START_TRIAL"; days: number }
  | { kind: "PAY"; amount: number }
  | { kind: "PAY_AT_DESK"; amount: number };

export function decideDoor(i: DoorInput): DoorDecision {
  if (i.covered) return { kind: "PRESENT", reason: "COVERED" };
  if (!i.hasActiveSubscription && i.trialCoversClass) {
    if (i.trialWindowActive) return { kind: "TRIAL", reason: "TRIAL_RUNNING" };
    if (i.newTrialDays != null) return { kind: "START_TRIAL", days: i.newTrialDays };
  }
  if (i.dropInPrice == null || i.dropInPrice <= 0) return { kind: "PRESENT", reason: "NO_PRICE_SET" };
  if (i.payAtDesk) return { kind: "PAY_AT_DESK", amount: i.dropInPrice };
  return { kind: "PAY", amount: i.dropInPrice };
}

/** Coverage verdict reasons that count as "let them in free". */
export function verdictCovers(v: { covered: boolean; reason: string } | null, hasActiveSubscription: boolean): boolean {
  if (!v) return hasActiveSubscription;
  // A class that accepts no plan: any plan holder gets in (the pre-rule
  // behaviour); everyone else pays the class price.
  if (v.reason === "NO_ACCEPTED_PLANS") return hasActiveSubscription;
  return v.covered;
}
