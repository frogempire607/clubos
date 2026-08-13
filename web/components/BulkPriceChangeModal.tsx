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

type PlanOption = { label: string; price: number; billingPeriod: string };

type Plan = {
  preview: true;
  membership: { id: string; name: string };
  option: { label: string; billingPeriod: string; oldPrice: number; newPrice: number };
  mode: "proposed" | "current";
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
  emailOn,
  onToggleEmail,
  notifyEnabled,
}: {
  row: Row;
  checked: boolean;
  onToggle: (id: string) => void;
  emailOn: boolean;
  onToggleEmail: (id: string) => void;
  notifyEnabled: boolean;
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
      <td className="px-3 py-2 text-sm">
        {/* Per-member email control. Only meaningful for rows being changed —
            an unselected member is not written to and never emailed. */}
        {checked ? (
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={notifyEnabled && emailOn}
              disabled={!notifyEnabled}
              onChange={() => onToggleEmail(row.memberSubscriptionId)}
              className="h-4 w-4 rounded border-app-border text-brand focus:ring-brand disabled:opacity-40"
              aria-label={`Email ${row.memberName}`}
            />
            <span className="text-[11px] text-text-muted">
              {!notifyEnabled ? "off" : emailOn ? "email" : "no email"}
            </span>
          </label>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>
    </tr>
  );
}

export default function BulkPriceChangeModal({
  membershipId,
  options,
  initialOptionIndex = 0,
  newPrice = null,
  onClose,
}: {
  membershipId: string;
  /** The plan's CURRENT saved options — the modal lets the owner switch between them. */
  options: PlanOption[];
  initialOptionIndex?: number;
  /**
   * An unsaved price to preview. Null (the default) reviews everyone against
   * the plan's current saved price, which is what makes this screen reachable
   * at any time rather than only during an in-flight edit.
   */
  newPrice?: number | null;
  onClose: () => void;
}) {
  const [optionIndex, setOptionIndex] = useState(initialOptionIndex);
  const active = options[optionIndex];
  const optionLabel = active?.label ?? "";
  const billingPeriod = active?.billingPeriod ?? "";
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
  const [reconcileLabel, setReconcileLabel] = useState(false);
  const [memo, setMemo] = useState("");
  // Per-member email opt-out. Holds the ids explicitly UNCHECKED, so newly
  // selected members default to "will be emailed" rather than silently not.
  const [noEmail, setNoEmail] = useState<Set<string>>(new Set());

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

  // Switching option is a different question about different people — drop the
  // previous answer rather than carrying selections or a result across.
  useEffect(() => {
    setApplied(null);
    setEffectiveDate("");
    setError("");
    setMemo("");
    setNoEmail(new Set());
  }, [optionIndex]);

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

  // Explicit bulk for the persistent-entry case: nothing is pre-ticked there,
  // so this is how the owner sweeps everyone who drifted off the plan price.
  function selectAllOffPrice() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of plan?.rows ?? []) {
        if (r.currentPrice !== r.newPrice) next.add(r.memberSubscriptionId);
      }
      return next;
    });
  }

  function selectNone() {
    setSelected(new Set());
  }

  function toggleEmail(id: string) {
    setNoEmail((prev) => {
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
  const driftedSelected = chosen.filter((r) => !r.labelMatchesOption).length;
  const emailCount = chosen.filter((r) => !noEmail.has(r.memberSubscriptionId)).length;

  // An increase needs a future effective date before it can be confirmed —
  // judged on the SELECTED rows, not the plan's list price. Reviewing against
  // the current saved price makes plan.direction "none" while an individual
  // member can still be going up. Mirrors directionForRows on the server.
  const isIncrease = chosen.some((r) => r.newPrice > r.currentPrice);
  const effectiveDateInFuture = (() => {
    if (!effectiveDate) return false;
    const d = new Date(`${effectiveDate}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.getTime() > Date.now();
  })();
  const noticeBlocked = isIncrease && !effectiveDateInFuture;
  const canApply = !!plan && chosen.length > 0 && !noticeBlocked && !applying && !applied;

  async function handleApply() {
    if (!plan || !canApply) return;
    const clientKey = `pc-${membershipId}-${optionIndex}-${Date.now()}`;
    setApplying(true);
    setError("");
    try {
      const res = await fetch(`/api/memberships/${membershipId}/price-change/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionLabel,
          billingPeriod,
          // In "current" mode the target IS the plan's saved price, which the
          // preview already resolved — the prop is null there.
          newPrice: plan.option.newPrice,
          memberSubscriptionIds: chosen.map((r) => r.memberSubscriptionId),
          notifyBeforeDate: effectiveDate ? new Date(`${effectiveDate}T00:00:00Z`).toISOString() : null,
          notify,
          reconcileLabel,
          memo: memo.trim() || null,
          notifySubscriptionIds: chosen
            .filter((r) => !noEmail.has(r.memberSubscriptionId))
            .map((r) => r.memberSubscriptionId),
          // Stable for this confirm press: a double-click dedupes at Stripe,
          // a deliberate retry after a failure is allowed to run.
          clientKey,
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
              <h2 className="text-lg font-semibold text-text-primary">Member prices</h2>
              <p className="text-sm text-text-muted mt-0.5">
                {plan ? (
                  <>
                    {plan.membership.name} · {plan.option.label} ({PERIOD_LABEL[plan.option.billingPeriod] ?? plan.option.billingPeriod})
                    {" · "}
                    {plan.mode === "current" ? (
                      <span className="text-text-primary font-medium">
                        plan price {usd(plan.option.oldPrice)}
                      </span>
                    ) : (
                      <span className="text-text-primary font-medium">
                        {usd(plan.option.oldPrice)} → {usd(plan.option.newPrice)}
                      </span>
                    )}
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
          {/* Option selector — the review is reachable for any option at any
              time, not only for whichever price field was mid-edit. */}
          {options.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {options.map((o, i) => (
                <button
                  key={`${o.label}-${o.billingPeriod}-${i}`}
                  type="button"
                  onClick={() => setOptionIndex(i)}
                  className={`rounded-lg border px-2.5 py-1 text-xs ${
                    i === optionIndex
                      ? "border-brand bg-brand text-white font-medium"
                      : "border-app-border text-text-primary hover:bg-app-bg"
                  }`}
                >
                  {o.label}
                  <span className={i === optionIndex ? "text-white/80" : "text-text-muted"}> · {usd(o.price)}</span>
                </button>
              ))}
            </div>
          )}

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
                  {
                    k: plan.mode === "current" ? `Not at ${usd(plan.option.newPrice)}` : "Custom price",
                    v: String(plan.summary.overrideCount),
                  },
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
                  <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-text-primary">
                      Billed each period ({recurringRows.length})
                    </h3>
                    <div className="flex items-center gap-3">
                      {plan.rows.some((r) => r.currentPrice !== r.newPrice) && (
                        <button type="button" onClick={selectAllOffPrice} className="text-xs text-brand hover:underline">
                          Select all not at {usd(plan.option.newPrice)}
                        </button>
                      )}
                      <button type="button" onClick={selectAllStripeRecurring} className="text-xs text-brand hover:underline">
                        Select all Stripe
                      </button>
                      {selected.size > 0 && (
                        <button type="button" onClick={selectNone} className="text-xs text-text-muted hover:underline">
                          Clear
                        </button>
                      )}
                    </div>
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
                          <th className="px-3 py-2">Notify</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recurringRows.map((r) => (
                          <RowLine
                            key={r.memberSubscriptionId}
                            row={r}
                            checked={selected.has(r.memberSubscriptionId)}
                            onToggle={toggle}
                            emailOn={!noEmail.has(r.memberSubscriptionId)}
                            onToggleEmail={toggleEmail}
                            notifyEnabled={notify}
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
                          <th className="px-3 py-2">Notify</th>
                        </tr>
                      </thead>
                      <tbody>
                        {upfrontRows.map((r) => (
                          <RowLine
                            key={r.memberSubscriptionId}
                            row={r}
                            checked={selected.has(r.memberSubscriptionId)}
                            onToggle={toggle}
                            emailOn={!noEmail.has(r.memberSubscriptionId)}
                            onToggleEmail={toggleEmail}
                            notifyEnabled={notify}
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
                    {isIncrease && <span className="text-red-600"> (required for an increase)</span>}
                  </label>
                  <input
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    className="px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  <p className="text-[11px] text-text-muted mt-1">
                    {isIncrease
                      ? "At least one selected member's price is going up. Families must be told before that happens, and the notification is sent now, so this date has to be in the future."
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
                      Sent as a transactional notice, so a marketing opt-out does not suppress it. Cash and
                      card members are both emailed — untick anyone individually in the Notify column.
                      {notify && <> Currently {emailCount} of {chosen.length} selected.</>}
                    </span>
                  </span>
                </label>

                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1">
                    Note to the family <span className="text-text-muted font-normal">(optional)</span>
                  </label>
                  <textarea
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    disabled={!notify}
                    placeholder="e.g. We've lowered the middle/high school rate for the fall season."
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-50"
                  />
                  <p className="text-[11px] text-text-muted mt-1">
                    Appears in the email above the price lines. Plain text — it is never rendered as HTML.
                    {!notify && " Emails are off for this run, so nothing will be sent."}
                  </p>
                </div>

                {/* Only offered when the CURRENT selection actually contains
                    drifted labels — apply only touches selected rows, so a
                    count over every row would overstate what the box does. */}
                {driftedSelected > 0 && (
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={reconcileLabel}
                      onChange={(e) => setReconcileLabel(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-app-border text-brand focus:ring-brand"
                    />
                    <span className="text-xs text-text-primary">
                      Also fix the stored option label to &ldquo;{plan.option.label}&rdquo;
                      <span className="block text-[11px] text-text-muted">
                        {driftedSelected} selected member{driftedSelected === 1 ? "" : "s"} still show an older name
                        on receipts and emails. This is a label only — it never affects matching or money.
                      </span>
                    </span>
                  </label>
                )}

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
              {" · "}
              {notify ? `${emailCount} to be emailed` : "no emails"}
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
