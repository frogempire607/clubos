// CAN-SPAM footer address resolver — the single source of truth for the
// postal address that goes into every marketing email's footer.
//
// Rule (owner-approved 2026-08-01, M21):
//   Prefer the CLUB's own mailing address when it is complete enough to
//   satisfy CAN-SPAM. Fall back to the AthletixOS entity address (the
//   platform's registered PO Box) when the club hasn't set one yet.
//
// A club address is "complete enough" when we have at least a street
// line, a city, and a state or postal code. Half-filled rows (just a
// street with no city) fall back — a partial address is worse than the
// entity fallback, because CAN-SPAM requires a real deliverable address
// and a street-line-only footer looks like a bug to the recipient.
//
// The entity address is authoritative for AthletixOS itself. Do NOT
// hardcode it anywhere else — every marketing send should call
// resolvePostalAddress() so a future entity-address change (P.O. Box
// move, LLC rename) is a one-file edit.

// Owner-visible identity of the AthletixOS entity that operates the
// platform. Every marketing send that isn't club-branded falls back to
// this. Keeping the constant here (not in .env) is deliberate: this is
// a legal identity string, not a per-deploy secret.
export const ATHLETIXOS_ENTITY_POSTAL_ADDRESS =
  "AthletixOS · MC Technologies Group LLC · PO Box 11, Newfield, NY 14867";

// Minimal club shape the resolver needs. Written as a structural type
// (no Prisma import) so consumers can pass a `select`-narrowed row or
// the full Club — either works.
export interface PostalAddressClub {
  mailingAddress?: string | null;
  mailingAddress2?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingZip?: string | null;
  mailingCountry?: string | null;
}

// Returns the mailing address as two USPS-style lines when the club has
// a complete-enough address, else null. Line 1 is "street" (with unit
// appended when present); line 2 is "city, state ZIP" (with country
// appended for international). Two lines are the layout for the Contact
// block AND the CAN-SPAM footer — the split defeats Gmail's smart-link
// heuristic that auto-linked the whole comma-joined single line as a
// Google Maps redirect.
export function formatClubMailingAddressLines(club: PostalAddressClub | null | undefined): {
  line1: string;
  line2: string;
} | null {
  if (!club) return null;
  const streetLine = trim(club.mailingAddress);
  const unit = trim(club.mailingAddress2);
  const city = trim(club.mailingCity);
  const state = trim(club.mailingState);
  const zip = trim(club.mailingZip);
  const country = trim(club.mailingCountry);

  // Deliverable-address gate: need a street line + city + (state OR zip).
  // Anything less is treated as unset.
  if (!streetLine || !city || (!state && !zip)) return null;

  const line1 = unit ? `${streetLine}, ${unit}` : streetLine;
  const region = state && zip ? `${state} ${zip}` : (state || zip);
  const cityRegion = region ? `${city}, ${region}` : city;
  const isDomestic = !country || /^(us|usa|united states|united states of america)$/i.test(country);
  const line2 = isDomestic ? cityRegion : `${cityRegion}, ${country}`;
  return { line1, line2 };
}

// One-line variant kept for legacy callers and for the plain-text /
// text-only email fallback where line breaks would look worse than a
// single comma-joined string. Returns null on the same completeness
// gate as formatClubMailingAddressLines.
export function formatClubMailingAddress(club: PostalAddressClub | null | undefined): string | null {
  const lines = formatClubMailingAddressLines(club);
  if (!lines) return null;
  return `${lines.line1}, ${lines.line2}`;
}

// Returns the postal address for the CAN-SPAM footer as an array of one
// or two lines (rendered joined by <br>). Prefers the club's own address
// when complete; falls back to the AthletixOS entity address (one line —
// the entity string is a single legal identity line by design).
export function resolvePostalAddressLines(club: PostalAddressClub | null | undefined): string[] {
  const lines = formatClubMailingAddressLines(club);
  if (lines) return [lines.line1, lines.line2];
  return [ATHLETIXOS_ENTITY_POSTAL_ADDRESS];
}

// Single-string variant of the above. Used in plain-text / SMS-fallback
// paths and by any legacy consumer that isn't rendering HTML.
export function resolvePostalAddress(club: PostalAddressClub | null | undefined): string {
  return resolvePostalAddressLines(club).join(", ");
}

function trim(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  return s.length ? s : null;
}
