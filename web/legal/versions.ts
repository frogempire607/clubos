// Single source of truth for the document versions a user accepts at
// signup. Update these strings whenever the attorney-reviewed text of
// the corresponding .md / page changes — together with the visible
// "Last updated" date — and the next signups will record the new
// version in their LegalAcceptance rows. Old rows are never rewritten.
export const TERMS_VERSION = "2026-07-02";
export const PRIVACY_VERSION = "2026-06-11";

// Version of the parental (COPPA) consent statement a guardian accepts on
// behalf of a minor. Bump this whenever the wording of that statement changes
// (see lib/parentalConsent.ts `buildParentalConsentText`). A bump makes prior
// parental consents stale, so guardians are re-prompted on next access — the
// same version-gated re-consent behavior used for Terms/Privacy.
export const PARENTAL_CONSENT_VERSION = "2026-07-05";
