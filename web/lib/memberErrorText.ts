// What a member is told when a request fails. PURE.
//
// Many API routes answer `{ error: "ROSTER_REQUIRED", message: "…" }`: a
// machine code for the page to act on, and words for the person. Pages that
// printed `d.error` straight onto the screen showed members the code
// ("ROSTER_REQUIRED" on the Schedule page, 2026-11-17). Every member-portal
// error message goes through `memberErrorText` instead; scripts/
// member-error-text-tests.ts fails the build if a page prints `.error` raw.

/** "SOME_CODE", "CLASS_FULL", "PAYMENT_METHOD_REQUIRED": a code, not a sentence. */
export function looksLikeErrorCode(s: string): boolean {
  return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s.trim()) || /^[A-Z]{3,}$/.test(s.trim());
}

// Codes a route sometimes returns with no `message`. Plain words for each;
// anything not listed falls back to the page's own wording.
const KNOWN: Record<string, string> = {
  ROSTER_REQUIRED: "This event needs a few more details before you can register.",
  FORM_REQUIRED: "This event has questions to answer before you can register.",
  FORM_INVALID: "Some answers need another look before you can register.",
  ENTRIES_INVALID: "Some entries need another look before you can register.",
  PAYMENT_METHOD_REQUIRED: "Choose how you'd like to pay to finish registering.",
  DOCUMENTS_ACKNOWLEDGE_REQUIRED: "This event has documents to review before you can register.",
  SPOT_FULL: "That spot isn't available any more. Pick another.",
  UNKNOWN_SPOT: "That spot isn't available any more. Pick another.",
  CLASS_FULL: "This class is full.",
  PAYMENT_REQUIRED: "Payment is needed before you can check in. Ask the front desk.",
  PAYMENT_SETUP_REQUIRED: "Add a card under Profile → Payment & billing, then try again.",
  UPGRADE_REQUIRED: "This isn't available for your club yet.",
  RATE_LIMITED: "Too many tries. Wait a moment and try again.",
};

type ErrorBody = { error?: unknown; message?: unknown } | null | undefined;

/**
 * The sentence to show. Order: the route's `message`; then `error` if it is a
 * sentence (older routes put the words there); then a known code's wording;
 * then the page's fallback. Never a code, never an object.
 */
export function memberErrorText(body: ErrorBody, fallback: string): string {
  const msg = typeof body?.message === "string" ? body.message.trim() : "";
  if (msg && !looksLikeErrorCode(msg)) return msg;
  const err = typeof body?.error === "string" ? body.error.trim() : "";
  if (err && !looksLikeErrorCode(err)) return err;
  if (err && KNOWN[err]) return KNOWN[err];
  return fallback;
}

/** The codes that mean "this registration needs the full register flow" (questions, roster spot, payment choice, documents). */
export const EVENT_REGISTER_FLOW_CODES = new Set([
  "ROSTER_REQUIRED",
  "FORM_REQUIRED",
  "FORM_INVALID",
  "ENTRIES_INVALID",
  "PAYMENT_METHOD_REQUIRED",
  "DOCUMENTS_ACKNOWLEDGE_REQUIRED",
  "SPOT_FULL",
  "UNKNOWN_SPOT",
]);

/**
 * The event details screen: everything about one event, and the only place
 * registering starts (2026-11-18). Every event link in the portal (Events,
 * Schedule, Home, bundles, emails, the public page, the app) uses this.
 * `register` opens the register flow on arrival; it still ends on the
 * confirm step before anything is saved.
 */
export function eventDetailsPath(eventId: string, memberId?: string | null, register = false): string {
  const q = new URLSearchParams();
  if (memberId) q.set("memberId", memberId);
  if (register) q.set("register", "1");
  const qs = q.toString();
  return `/member/events/${encodeURIComponent(eventId)}${qs ? `?${qs}` : ""}`;
}

/** The Schedule page's hand-off: the same details screen, with the register flow opened. */
export function eventRegisterFlowPath(eventId: string, memberId: string | null | undefined): string {
  return eventDetailsPath(eventId, memberId, true);
}
