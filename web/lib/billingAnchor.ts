// What a billing anchor actually grants.
//
// PURE. `now` is injected so every case is testable without waiting for a date.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// Staff choose a billing anchor from a date picker. Stripe honours it, so the
// member is not charged until that date — which means the picker is a free-time
// grant wearing a scheduling name. Nothing said so, nothing capped it, and
// nothing recorded who did it.
//
// Measured on production 2026-08-25: 57 days beyond the club's configured
// 7-day trial across three members, worth $186.67. Levi Schanzenbach alone was
// given 22 days over the trial — $128.33 — by an anchor set four weeks out.
// There is no reason to think that was a decision rather than a date.
//
// Note the subtraction: a member gets the configured trial anyway, so only the
// time BEYOND it is the grant. Reporting the raw gap would overstate every case
// and make the number easy to dismiss.

export type AnchorGrant = {
  /** Whole days from now until the first charge. */
  totalFreeDays: number;
  /** Days the club's trial would have given regardless. */
  trialDays: number;
  /** The part the anchor is responsible for. Never negative. */
  grantedDays: number;
  /** grantedDays priced at the member's own rate. Null when price is unknown. */
  grantedValue: number | null;
  /** Rendered for a confirm dialog. Empty when nothing is granted. */
  sentence: string;
};

const DAY = 86_400_000;

const PERIOD_DAYS: Record<string, number> = {
  WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91, SEMI_ANNUAL: 182, ANNUAL: 365,
};

export function anchorGrant(args: {
  now: Date;
  anchor: Date | null;
  trialDays: number;
  price: number | null;
  billingPeriod: string | null;
}): AnchorGrant {
  const { now, anchor, trialDays } = args;
  const totalFreeDays = anchor
    ? Math.max(0, Math.round((anchor.getTime() - now.getTime()) / DAY))
    : 0;
  const grantedDays = Math.max(0, totalFreeDays - Math.max(0, trialDays));

  const periodDays = PERIOD_DAYS[(args.billingPeriod ?? "MONTHLY").toUpperCase()] ?? 30;
  const grantedValue =
    args.price != null && Number.isFinite(args.price) && args.price > 0
      ? Math.round((args.price / periodDays) * grantedDays * 100) / 100
      : null;

  const sentence =
    grantedDays === 0
      ? ""
      : `This billing date is ${totalFreeDays} day${totalFreeDays === 1 ? "" : "s"} away. ` +
        `${trialDays > 0 ? `${trialDays} of those are the club's free trial, so this grants ` : `That grants `}` +
        `${grantedDays} extra free day${grantedDays === 1 ? "" : "s"}` +
        (grantedValue != null ? ` — about $${grantedValue.toFixed(2)} of membership` : "") +
        `.`;

  return { totalFreeDays, trialDays: Math.max(0, trialDays), grantedDays, grantedValue, sentence };
}
