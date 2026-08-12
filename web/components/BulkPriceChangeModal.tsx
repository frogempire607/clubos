"use client";

// Bulk price change — review, then apply.
//
// Reads /api/memberships/[id]/price-change/preview to show who sits on the
// option being repriced, then POSTs the chosen ids to .../apply. The apply
// call re-verifies every row against the DB, so what this component sends is
// a set of ids and a price — never a trusted payload.
//
// Three rules the layout encodes:
//   1. Members who already pay something other than the plan's sticker price
//      are shown but never pre-ticked — an override is a decision someone made
//      on purpose, and a bulk tool must not quietly undo it.
//   2. Upfront-paid rows are in their own section, below, each with its own
//      credit line. They are the rows where money has already changed hands,
//      so they get read one at a time rather than swept with a "select all".
//   3. An increase cannot be confirmed without a future effective date. The
//      button stays disabled and says why, because families must be told
//      before their price goes up.

import { useEffect, useMemo, useState } from "react";

type CreditKind = "CREDIT_OWED" | "ADDITIONAL_DUE" | "NOT_APPLICABLE" | "NO_CHANGE" | "UNKNOWN";

type Credit = {
  kind: CreditKind;
  amount: number | null;
  basis: string;
  periodEnd: string | null;
  daysRemaining: number | null;
  daysInPeriod: number | null;
  note: string;
};

type Row = {
  memberSubscriptionId: string;
  memberId: string;
  memberName: string;
  optionLabel: string;
  labelMatchesOption: boolean;
  billingPeriod: string | null;
  billingType: string;
  status: string;
  channel: "stripe" | "offline";
  currentPrice: number;
  newPrice: number;
  delta: number;
  onListPrice: boolean;
  upfront: boolean;
  defaultSelected: boolean;
  credit: Credit;
  stripe: { subscriptionId: string; priceId: string | null; stripeStatus: string | null; currentPeriodEnd: string | null } | null;
  discountCode: string | null;
  warnings: string[];
};

type Plan = {
  preview: true;
  membership: { id: string; name: string };
  option: { label: string; billingPeriod: string; oldPrice: number; newPrice: number };
  direction: "increase" | "decrease" | "none";
  rows: Row[];
  summary: {
    total: number;
    stripeCount: number;
    offlineCount: number;
    onListPriceCount: number;
    overrideCount: number;
    upfrontCount: number;
    defaultSelectedCount: number;
    totalCreditOwed: number;
    totalAdditionalDue: number;
    unknownCreditCount: number;
    defaultSelectedDelta: number;
  };
  notes: string[];
};

type ApplyRowResult = {
  memberSubscriptionId: string;
  memberName: string | null;
  outcome: string;
  channel: "stripe" | "offline" | null;
  fromPrice: number | null;
  toPrice: number | null;
  emailed: boolean;
  emailStatus: string | null;
  message: string | null;
};

type ApplyResponse = {
  ok: boolean;
  summary: {
    requested: number;
    updated: number;
    failed: number;
    skipped: number;
    emailed: number;
    creditOwed: number;
    additionalDue: number;
    unresolvedCredit: number;
  };
  results: ApplyRowResult[];
  notes: string[];
};

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const PERIOD_LABEL: Record<string, string> = {
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  QUADRIMESTRAL: "every 4 months",
  QUARTERLY: "quarterly",
  SEMI_ANNUAL: "every 6 months",
  ANNUAL: "annually",
  ONE_TIME: "one-time",
};

// Dates on these rows are date-only 00:00 UTC values. Render them in UTC or
// they drift a day backwards for anyone west of Greenwich (the same bug the
// 2026-07-13 billing batch fixed across every other billing surface).
const fmtDateUTC = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—";

function ChannelBadge({ channel }: { channel: "stripe" | "offline" }) {
  return channel === "stripe" ? (
    <span className="inline-flex items-center rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 text-[11px] font-medium">
      Stripe
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-[11px] font-medium">
      Offline
    </span>
  );
}

function CreditCell({ credit }: { credit: Credit }) {
  if (credit.kind === "NOT_APPLICABLE" || credit.kind === "NO_CHANGE") {
    return <span className="text-text-muted">—</span>;
  }
  if (credit.kind === "UNKNOWN") {
    return (
      <span className="text-amber-700" title={credit.note}>
        Can&apos;t compute
      </span>
    );
  }
  const isCredit = credit.kind === "CREDIT_OWED";
  return (
    <span className={isCredit ? "text-red-700 font-medium" : "text-emerald-700 font-medium"} title={credit.note}>
      {isCredit ? "Credit owed " : "Additional due "}
      {usd(credit.amount ?? 0)}
      <span className="block text-[11px] font-normal text-text-muted">
        {credit.daysRemaining} of {credit.daysInPeriod} days left · to {fmtDateUTC(credit.periodEnd)}
      </span>
    </span>
  );
}

function RowLine({
  row,
  checked,
  onToggle,
}: {
  row: Row;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <tr className="border-t border-app-border align-top">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(row.memberSubscriptionId)}
          className="mt-1 h-4 w-4 rounded border-app-border text-brand focus:ring-brand"
          aria-label={`Select ${row.memberName}`}
        />
      </td>
      <td className="px-3 py-2">
        <div className="text-sm text-text-primary font-medium">{row.memberName}</div>
        <div className="text-[11px] text-text-muted">
          {row.optionLabel}
          {!row.labelMatchesOption && <span className="text-amber-700"> · label differs</span>}
          {" · "}
          {row.status}
        </div>
        {row.warnings.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {row.warnings.map((w, i) => (
              <li key={i} className="text-[11px] text-amber-700">
                {w}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2">
        <ChannelBadge channel={row.channel} />
      </td>
      <td className="px-3 py-2 text-sm text-text-primary whitespace-nowrap">{usd(row.currentPrice)}</td>
      <td className="px-3 py-2 text-sm whitespace-nowrap">
        <span className={row.delta === 0 ? "text-text-muted" : row.delta < 0 ? "text-emerald-700" : "text-text-primary"}>
          {usd(row.newPrice)}
        </span>
        {row.delta !== 0 && (
          <span className="block text-[11px] text-text-muted">
            {row.delta > 0 ? "+" : ""}
            {usd(row.delta)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-sm whitespace-nowrap">
        <CreditCell credit={row.credit} />
      </td>
    </tr>
  );
}

export default function BulkPriceChangeModal({
  membershipId,
  optionLabel,
  billingPeriod,
  newPrice,
  onClose,
}: {
  membershipId: string;
  optionLabel: string;
  billingPeriod: string;
  newPrice: number;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Date the new price takes effect. Required for increases — the notification
  // goes out during the apply call, which is necessarily before this date.
  const [effectiveDate, setEffectiveDate] = useState("");
  const [notify, setNotify] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ApplyResponse | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/memberships/${membershipId}/price-change/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ optionLabel, billingPeriod, newPrice }),
        });
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(json?.error || "Could not build the preview.");
          setLoading(false);
          return;
        }
        setPlan(json as Plan);
        setSelected(
          new Set((json.rows as Row[]).filter((r) => r.defaultSelected).map((r) => r.memberSubscriptionId)),
        );
      } catch {
        if (alive) setError("Could not reach the server.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [membershipId, optionLabel, billingPeriod, newPrice]);

  const recurringRows = useMemo(() => plan?.rows.filter((r) => !r.upfront) ?? [], [plan]);
  const upfrontRows = useMemo(() => plan?.rows.filter((r) => r.upfront) ?? [], [plan]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllStripeRecurring() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of recurringRows) {
        if (r.channel === "stripe" && r.currentPrice !== r.newPrice) next.add(r.memberSubscriptionId);
      }
      return next;
    });
  }

  // Selected-row totals — recomputed from the rows the owner has actually
  // ticked, not from the server's defaults, so the footer always describes the
  // screen in front of them.
  const chosen = useMemo(
    () => (plan?.rows ?? []).filter((r) => selected.has(r.memberSubscriptionId)),
    [plan, selected],
  );
  const chosenCredit = chosen
    .filter((r) => r.credit.kind === "CREDIT_OWED")
    .reduce((s, r) => s + (r.credit.amount ?? 0), 0);
  const chosenDue = chosen
    .filter((r) => r.credit.kind === "ADDITIONAL_DUE")
    .reduce((s, r) => s + (r.credit.amount ?? 0), 0);
  const chosenUnknown = chosen.filter((r) => r.credit.kind === "UNKNOWN").length;

  // An increase needs a future effective date before it can be confirmed.
  const isIncrease = plan?.direction === "increase";
  const effectiveDateInFuture = (() => {
    if (!effectiveDate) return false;
    const d = new Date(`${effectiveDate}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.getTime() > Date.now();
  })();
  const noticeBlocked = isIncrease && !effectiveDateInFuture;
  const canApply = !!plan && chosen.length > 0 && !noticeBlocked && !applying && !applied;

  async function handleApply() {
    if (!plan || !canApply) return;
    setApplying(true);
    setError("");
    try {
      const res = await fetch(`/api/memberships/${membershipId}/price-change/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionLabel,
          billingPeriod,
          newPrice,
          memberSubscriptionIds: chosen.map((r) => r.memberSubscriptionId),
          notifyBeforeDate: effectiveDate ? new Date(`${effectiveDate}T00:00:00Z`).toISOString() : null,
          notify,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "The change could not be applied.");
        return;
      }
      setApplied(json as ApplyResponse);
    } catch {
      setError("Could not reach the server. Nothing was changed.");
    } finally {
      setApplying(false);
    }
  }

  return (
    // z-[60], not z-50: this opens ON TOP of the membership edit modal, which
    // is itself z-50. At equal z-index the two stack by DOM order and the edit
    // form's fields render through this one's table — verified in the browser.
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
      {/* bg-surface, NOT bg-app-surface: the theme defines --color-surface, so
          `bg-app-surface` resolves to nothing and the card renders fully
          transparent — the edit form behind it shows straight through. */}
      <div className="bg-surface rounded-xl w-full max-w-5xl my-4 shadow-xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-app-border">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Members on this price</h2>
              <p className="text-sm text-text-muted mt-0.5">
                {plan ? (
                  <>
                    {plan.membership.name} · {plan.option.label} ({PERIOD_LABEL[plan.option.billingPeriod] ?? plan.option.billingPeriod})
                    {" · "}
                    <span className="text-text-primary font-medium">
                      {usd(plan.option.oldPrice)} → {usd(plan.option.newPrice)}
                    </span>
                  </>
                ) : (
                  "Loading…"
                )}
              </p>
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none" aria-label="Close">
              ×
            </button>
          </div>
          {!applied ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">Preview</span>
              <span className="text-xs text-emerald-900">
                Nothing has been saved, charged, refunded, or emailed yet.
              </span>
            </div>
          ) : (
            <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-800">Applied</span>
              <span className="text-xs text-indigo-900">
                {applied.summary.updated} updated · {applied.summary.emailed} notified
                {applied.summary.failed > 0 && ` · ${applied.summary.failed} failed`}
              </span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5 max-h-[65vh] overflow-y-auto">
          {/* Result view replaces the table entirely once applied — the
              selection that produced it is no longer the live state. */}
          {applied ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { k: "Updated", v: String(applied.summary.updated) },
                  { k: "Notified", v: String(applied.summary.emailed) },
                  { k: "Skipped", v: String(applied.summary.skipped) },
                  { k: "Failed", v: String(applied.summary.failed) },
                ].map((c) => (
                  <div key={c.k} className="rounded-lg border border-app-border px-3 py-2">
                    <div className="text-[11px] text-text-muted">{c.k}</div>
                    <div className="text-lg font-semibold text-text-primary">{c.v}</div>
                  </div>
                ))}
              </div>

              {(applied.summary.creditOwed > 0 ||
                applied.summary.additionalDue > 0 ||
                applied.summary.unresolvedCredit > 0) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1">
                  <div className="text-xs font-semibold text-amber-900">Money to settle by hand</div>
                  {applied.summary.creditOwed > 0 && (
                    <div className="text-xs text-amber-900">
                      Credits owed: {usd(applied.summary.creditOwed)} — recorded on each member&apos;s billing
                      history. Nothing was refunded.
                    </div>
                  )}
                  {applied.summary.additionalDue > 0 && (
                    <div className="text-xs text-amber-900">
                      Additional due: {usd(applied.summary.additionalDue)} — recorded, not charged.
                    </div>
                  )}
                  {applied.summary.unresolvedCredit > 0 && (
                    <div className="text-xs text-amber-900">
                      {applied.summary.unresolvedCredit} member
                      {applied.summary.unresolvedCredit === 1 ? "" : "s"} had no computable credit — no period
                      end is stored. Settle those by hand.
                    </div>
                  )}
                </div>
              )}

              <div className="overflow-x-auto border border-app-border rounded-lg">
                <table className="w-full text-left">
                  <thead className="bg-app-bg">
                    <tr className="text-[11px] uppercase tracking-wide text-text-muted">
                      <th className="px-3 py-2">Member</th>
                      <th className="px-3 py-2">Result</th>
                      <th className="px-3 py-2">Change</th>
                      <th className="px-3 py-2">Notified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applied.results.map((r) => {
                      const failed = r.outcome.startsWith("FAILED");
                      const skipped = r.outcome.startsWith("SKIPPED");
                      return (
                        <tr key={r.memberSubscriptionId} className="border-t border-app-border align-top">
                          <td className="px-3 py-2 text-sm text-text-primary">{r.memberName ?? "(unknown)"}</td>
                          <td className="px-3 py-2 text-sm">
                            <span
                              className={
                                failed ? "text-red-700 font-medium" : skipped ? "text-amber-700" : "text-emerald-700 font-medium"
                              }
                            >
                              {r.outcome.replace(/_/g, " ").toLowerCase()}
                            </span>
                            {r.message && <div className="text-[11px] text-text-muted mt-0.5">{r.message}</div>}
                          </td>
                          <td className="px-3 py-2 text-sm whitespace-nowrap text-text-primary">
                            {r.fromPrice != null && r.toPrice != null && r.outcome === "UPDATED"
                              ? `${usd(r.fromPrice)} → ${usd(r.toPrice)}`
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-sm text-text-muted">
                            {r.emailed ? "Yes" : r.emailStatus ? r.emailStatus.toLowerCase() : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-1">
                {applied.notes.map((n, i) => (
                  <li key={i} className="text-xs text-text-muted flex gap-1.5">
                    <span aria-hidden>·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
          <>
          {loading && <div className="text-sm text-text-muted py-8 text-center">Building the preview…</div>}

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          {plan && plan.summary.total === 0 && (
            <div className="text-sm text-text-muted py-8 text-center">
              No active subscriptions are billed on {plan.membership.name} · {PERIOD_LABEL[plan.option.billingPeriod] ?? plan.option.billingPeriod}.
              Changing this option&apos;s price affects new purchases only.
            </div>
          )}

          {plan && plan.summary.total > 0 && (
            <>
              {/* Counts */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { k: "On this option", v: String(plan.summary.total) },
                  { k: "Stripe", v: String(plan.summary.stripeCount) },
                  { k: "Offline", v: String(plan.summary.offlineCount) },
                  { k: "Custom price", v: String(plan.summary.overrideCount) },
                ].map((c) => (
                  <div key={c.k} className="rounded-lg border border-app-border px-3 py-2">
                    <div className="text-[11px] text-text-muted">{c.k}</div>
                    <div className="text-lg font-semibold text-text-primary">{c.v}</div>
                  </div>
                ))}
              </div>

              {/* Recurring section */}
              {recurringRows.length > 0 && (
                <section>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <h3 className="text-sm font-semibold text-text-primary">
                      Billed each period ({recurringRows.length})
                    </h3>
                    <button
                      type="button"
                      onClick={selectAllStripeRecurring}
                      className="text-xs text-brand hover:underline"
                    >
                      Select all Stripe
                    </button>
                  </div>
                  <p className="text-xs text-text-muted mb-2">
                    No money has been paid ahead for these — the next bill simply uses the new price.
                  </p>
                  <div className="overflow-x-auto border border-app-border rounded-lg">
                    <table className="w-full text-left">
                      <thead className="bg-app-bg">
                        <tr className="text-[11px] uppercase tracking-wide text-text-muted">
                          <th className="px-3 py-2 w-10"></th>
                          <th className="px-3 py-2">Member</th>
                          <th className="px-3 py-2">Channel</th>
                          <th className="px-3 py-2">Pays today</th>
                          <th className="px-3 py-2">New price</th>
                          <th className="px-3 py-2">Credit / due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recurringRows.map((r) => (
                          <RowLine
                            key={r.memberSubscriptionId}
                            row={r}
                            checked={selected.has(r.memberSubscriptionId)}
                            onToggle={toggle}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* Upfront section — deliberately separated */}
              {upfrontRows.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-text-primary mb-1">
                    Paid upfront ({upfrontRows.length}) — read each one
                  </h3>
                  <p className="text-xs text-text-muted mb-2">
                    These members have already paid for a stretch of time. Changing the price does not change
                    what they paid and never touches their paid status — the credit column is what they would
                    be owed for unused time, for you to settle by hand.
                  </p>
                  <div className="overflow-x-auto border border-amber-200 rounded-lg">
                    <table className="w-full text-left">
                      <thead className="bg-amber-50">
                        <tr className="text-[11px] uppercase tracking-wide text-amber-900">
                          <th className="px-3 py-2 w-10"></th>
                          <th className="px-3 py-2">Member</th>
                          <th className="px-3 py-2">Channel</th>
                          <th className="px-3 py-2">Pays today</th>
                          <th className="px-3 py-2">New price</th>
                          <th className="px-3 py-2">Credit / due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {upfrontRows.map((r) => (
                          <RowLine
                            key={r.memberSubscriptionId}
                            row={r}
                            checked={selected.has(r.memberSubscriptionId)}
                            onToggle={toggle}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* Effective date + notification */}
              <section className="rounded-lg border border-app-border p-3 space-y-3">
                <h3 className="text-sm font-semibold text-text-primary">Before you apply</h3>

                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1">
                    Date the new price takes effect
                    {plan.direction === "increase" && <span className="text-red-600"> (required for an increase)</span>}
                  </label>
                  <input
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    className="px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  <p className="text-[11px] text-text-muted mt-1">
                    {plan.direction === "increase"
                      ? "Families must be told before their price goes up. The notification is sent now, so this date has to be in the future."
                      : "Optional. Leave blank and members are told the change applies from their next billing cycle."}
                  </p>
                  {noticeBlocked && effectiveDate && (
                    <p className="text-[11px] text-red-700 mt-1">
                      That date is not in the future — an increase that has already taken effect cannot be
                      announced in advance.
                    </p>
                  )}
                </div>

                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={notify}
                    onChange={(e) => setNotify(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-app-border text-brand focus:ring-brand"
                  />
                  <span className="text-xs text-text-primary">
                    Email these families about the change
                    <span className="block text-[11px] text-text-muted">
                      Sent as a transactional notice, so a marketing opt-out does not suppress it.
                    </span>
                  </span>
                </label>

                <p className="text-[11px] text-text-muted">
                  Skipped members keep this price until they cancel and re-sign. Applying does not change the
                  plan&apos;s own price list — save the membership separately to update it for new purchases.
                </p>
              </section>

              {/* Notes */}
              <ul className="space-y-1">
                {plan.notes.map((n, i) => (
                  <li key={i} className="text-xs text-text-muted flex gap-1.5">
                    <span aria-hidden>·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-app-border">
          {error && !loading && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              {error}
            </div>
          )}

          {!applied && plan && plan.summary.total > 0 && (
            <div className="text-sm text-text-primary mb-3">
              <span className="font-medium">{chosen.length} selected</span>
              {chosenCredit > 0 && <> · credits owed {usd(chosenCredit)}</>}
              {chosenDue > 0 && <> · additional due {usd(chosenDue)}</>}
              {chosenUnknown > 0 && <> · {chosenUnknown} with no computable credit</>}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg"
            >
              {applied ? "Done" : "Cancel"}
            </button>
            {!applied && (
              <button
                type="button"
                onClick={handleApply}
                disabled={!canApply}
                title={
                  noticeBlocked
                    ? "Set a future effective date — an increase must be announced before it takes effect."
                    : chosen.length === 0
                      ? "Select at least one member."
                      : undefined
                }
                className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {applying
                  ? "Applying…"
                  : noticeBlocked
                    ? "Set an effective date first"
                    : `Apply to ${chosen.length} member${chosen.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>

          {!applied && (
            <p className="text-[11px] text-text-muted mt-2 text-center">
              Stripe members move to the new amount with no proration — no credit note, no extra charge.
              Offline members are recorded only; nothing is charged or refunded.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
