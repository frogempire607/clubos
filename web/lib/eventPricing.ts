// Shared pricing resolution for PUBLIC event registration (/e/<slug>) and
// owner-side payment-link collection. The owner picks WHICH price the public
// link charges via Event.publicPricingOption — null/missing falls back to the
// non-member price. Used at registration time and again when re-collecting
// from an unpaid registrant, so both always agree.

/** The fixed price a public registrant owes for an event. 0 = free. */
export function publicFixedPrice(event: {
  publicPricingOption?: string | null;
  memberPrice?: unknown;
  nonMemberPrice?: unknown;
  dropInFee?: unknown;
}): number {
  const opt = event.publicPricingOption;
  const chosen =
    opt === "MEMBER" ? event.memberPrice
    : opt === "DROP_IN" ? event.dropInFee
    : event.nonMemberPrice;
  const n = chosen == null ? 0 : Number(chosen);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
