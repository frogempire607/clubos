// What will actually happen when a membership's period runs out.
//
// PURE and client-safe. DISPLAY ONLY: nothing here decides a charge, and no
// write path reads it (lib/autopay, lib/nonRenewal and lib/membershipMoney
// keep their own rules). It exists because `MemberSubscription.autoRenew` is a
// stored flag that can disagree with what will happen. Found in production on
// 2026-11-25:
//
//   · 12 card memberships stored "renews" that Stripe is set to stop (a
//     commitment end was passed to Stripe at activation, the flag was left on)
//   · one stored "renews" with an end date Stripe never received. It renews.
//   · one stored "doesn't renew" with no stop anywhere. It renews.
//
// So the flag is never the answer on its own:
//   card row     Stripe's stop date decides, when we know what Stripe holds
//                (lib/stripeStops). Not known → the row's end date.
//   cash / check the end date decides. With none, it renews when they pay.
//
// scripts/renewal-truth-tests.ts covers every case.

export type RenewalFacts = {
  hasStripe: boolean;
  status: string;
  autoRenew: boolean;
  endDate: Date | string | null;
  /** What Stripe holds: a date, `null` = known to have no stop, `undefined` = not known. */
  stripeStop: Date | string | null | undefined;
  /** The next money date: card period end, or how far cash reaches. */
  currentPeriodEnd: Date | string | null;
  paidThroughDate?: Date | string | null;
  canceledAt?: Date | string | null;
  expiredAt?: Date | string | null;
  /** What a renewal costs them, fee included. 0 or null = say no amount. */
  amount?: number | null;
};

export type RenewalTruth = {
  kind: "RENEWS" | "ENDS" | "WHEN_PAID" | "ENDED";
  /** The stop (or past end) date, when there is one. */
  endsAt: Date | null;
  /** The next renewal date, when it renews. */
  renewsAt: Date | null;
  amount: number | null;
  /** The stored flag says otherwise. The switch shows the truth; nothing is changed. */
  mismatch: "FLAG_ON_BUT_ENDS" | "FLAG_OFF_BUT_RENEWS" | null;
};

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function renewalTruth(f: RenewalFacts): RenewalTruth {
  const end = asDate(f.endDate);
  const period = asDate(f.currentPeriodEnd);
  const amount = f.amount != null && f.amount > 0 ? f.amount : null;
  if (f.status === "canceled" || f.status === "expired") {
    return { kind: "ENDED", endsAt: asDate(f.canceledAt) ?? asDate(f.expiredAt) ?? end, renewsAt: null, amount: null, mismatch: null };
  }
  const ends = (at: Date | null): RenewalTruth => ({ kind: "ENDS", endsAt: at, renewsAt: null, amount: null, mismatch: f.autoRenew ? "FLAG_ON_BUT_ENDS" : null });
  if (f.hasStripe) {
    const stop = f.stripeStop === undefined ? end : asDate(f.stripeStop);
    if (stop) return ends(stop);
    // Stripe's side isn't known and the flag is off: believe the flag, it
    // stops at the end of the period.
    if (f.stripeStop === undefined && !f.autoRenew) return ends(period);
    return { kind: "RENEWS", endsAt: null, renewsAt: period, amount, mismatch: f.autoRenew ? null : "FLAG_OFF_BUT_RENEWS" };
  }
  if (end) return ends(end);
  // Cash or check with no end date: nothing renews by itself, whatever the
  // flag says, and nothing ends by itself either.
  return { kind: "WHEN_PAID", endsAt: null, renewsAt: asDate(f.paidThroughDate) ?? period, amount, mismatch: null };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Dec 3", with the year when it isn't this one. Billing dates are calendar days stored at 00:00 UTC. */
export function renewalDay(d: Date, now: Date): string {
  const s = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? s : `${s}, ${d.getUTCFullYear()}`;
}

const usd = (n: number) => `$${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)}`;

/** The one line: "Renews Dec 3 · $110" / "Ends Dec 3 · doesn't renew". */
export function renewalLine(t: RenewalTruth, now: Date, opts: { showAmount?: boolean } = {}): string {
  const money = opts.showAmount === false || t.amount == null ? "" : ` · ${usd(t.amount)}`;
  switch (t.kind) {
    case "ENDED":
      return t.endsAt ? `Ended ${renewalDay(t.endsAt, now)}` : "Ended";
    case "ENDS":
      return t.endsAt ? `Ends ${renewalDay(t.endsAt, now)} · doesn't renew` : "Ends at the end of this period · doesn't renew";
    case "RENEWS":
      return t.renewsAt ? `Renews ${renewalDay(t.renewsAt, now)}${money}` : `Renews automatically${money}`;
    case "WHEN_PAID":
      return t.renewsAt ? `Paid through ${renewalDay(t.renewsAt, now)} · renews when paid` : "Renews when paid";
  }
}

/** What the auto-renew switch says next to it: "Off · ends Dec 3". */
export function switchLine(t: RenewalTruth, now: Date): string {
  switch (t.kind) {
    case "RENEWS":
      return t.renewsAt ? `On · renews ${renewalDay(t.renewsAt, now)}${t.amount != null ? ` · ${usd(t.amount)}` : ""}` : "On · renews automatically";
    case "ENDS":
      return t.endsAt ? `Off · ends ${renewalDay(t.endsAt, now)}` : "Off · ends at the end of this period";
    case "WHEN_PAID":
      return t.renewsAt ? `Off · paid through ${renewalDay(t.renewsAt, now)}, renews when paid` : "Off · renews when paid";
    case "ENDED":
      return t.endsAt ? `Off · ended ${renewalDay(t.endsAt, now)}` : "Off · ended";
  }
}

/** Does it stop before (or exactly when) the next charge would have run? */
export function endsBeforeNextCharge(t: RenewalTruth, nextCharge: Date | string | null): boolean {
  if (t.kind === "ENDED") return true;
  const n = asDate(nextCharge);
  return t.kind === "ENDS" && (!t.endsAt || !n || t.endsAt.getTime() <= n.getTime() + 60_000);
}
