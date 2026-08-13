// The ONE address for a registration, for its entire lifetime (§5.2.3).
//
// Every surface that needs to point somebody at their registration builds the
// URL here: the Stripe success_url, the payment-link return, the lifecycle
// emails, the roster. They must agree, because the promise the page makes is
// that this link is a LIVE view — the parent who bookmarks it after registering
// sees the coach's approval when they come back, not the snapshot they landed
// on. That only holds if there is one address rather than several.
//
// Events with a public slug get the readable form. Events without one — a
// members-only camp, an internal clinic — get /r/<id>, which renders the same
// page. Never build `/e/${slug ?? ""}/...`: an empty slug resolves to `/e/` and
// 404s the parent who just paid, which is the bug /pay/complete existed to
// patch before this route existed.

export function registrationUrl(
  baseUrl: string,
  event: { publicSlug?: string | null },
  registrationId: string,
): string {
  return event.publicSlug
    ? `${baseUrl}/e/${event.publicSlug}/registered/${registrationId}`
    : `${baseUrl}/r/${registrationId}`;
}

/** Where Stripe returns the payer. Same page either way — it reads the row. */
export function registrationReturnUrl(
  baseUrl: string,
  event: { publicSlug?: string | null },
  registrationId: string,
  outcome: "paid" | "canceled",
): string {
  return `${registrationUrl(baseUrl, event, registrationId)}?src=${outcome}`;
}
