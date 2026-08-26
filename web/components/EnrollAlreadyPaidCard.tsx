"use client";
// "This family already paid me — put them on a membership from here."
//
// The one obvious path for enrolling a cash-paying family. Before this existed
// there were three doors and none did the whole job, so Drew Telesky's month of
// cash had nowhere to go: no subscription meant no amount-due row, no
// amount-due row meant the receipt card rendered nothing, and the money was
// never recorded at all.
//
// Deliberately ONE form, because the four facts only make sense together: what
// they bought, what they handed over, what period it covers, and whether the
// card takes over afterwards. Splitting them is what produced three doors.

import { useCallback, useEffect, useState } from "react";
import { Banknote } from "lucide-react";
import { parseOptions } from "@/lib/membershipOptions";

type Option = { id: string | null; label: string; price: number; billingPeriod: string };
type Plan = { id: string; name: string; options: Option[] };
/** What /api/memberships actually returns: the raw row, options unparsed. */
type RawPlan = { id: string; name: string; active: boolean; options: unknown };

const PERIOD_MONTHS: Record<string, number> = {
  WEEKLY: 0, MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12,
};

/** Default the covered-until date to one period from today. */
function defaultCoversUntil(period: string): string {
  const d = new Date();
  const months = PERIOD_MONTHS[period?.toUpperCase()] ?? 1;
  if (months === 0) d.setUTCDate(d.getUTCDate() + 7);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

export default function EnrollAlreadyPaidCard({
  memberId, memberName, onChanged, className,
}: {
  memberId: string;
  memberName: string;
  onChanged?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [planId, setPlanId] = useState("");
  const [optionId, setOptionId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "CHECK">("CASH");
  const [reference, setReference] = useState("");
  const [coversUntil, setCoversUntil] = useState("");
  const [startCard, setStartCard] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/memberships")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const raw = Array.isArray(d) ? d : d?.memberships;
        if (!Array.isArray(raw)) { setPlans([]); return; }
        // parseOptions, not JSON.parse and not a local reader: options are a
        // JSON string inside a json column, and lib/membershipOptions is the
        // ONE parser. A second one here would drift from it exactly the way
        // the editor's did when it silently dropped option ids.
        setPlans(
          (raw as RawPlan[])
            .filter((p) => p.active)
            .map((p) => ({ id: p.id, name: p.name, options: parseOptions(p.options) }))
            .filter((p) => p.options.length > 0),
        );
      })
      .catch(() => setPlans([]));
  }, []);
  useEffect(() => { if (open && !plans) load(); }, [open, plans, load]);

  const plan = plans?.find((p) => p.id === planId) ?? null;
  const option = plan?.options.find((o) => o.id === optionId) ?? null;

  // Picking an option fills in the two fields staff would otherwise type
  // wrong: the price, and a period-length default for the covered-until date.
  function pickOption(o: Option) {
    setOptionId(o.id ?? "");
    setAmount(String(o.price));
    setCoversUntil(defaultCoversUntil(o.billingPeriod));
    setError("");
  }

  const coversInPast = !!coversUntil && new Date(`${coversUntil}T00:00:00.000Z`).getTime() < Date.now();
  const amountMismatch =
    !!option && !!amount && Math.abs(Number(amount) - option.price) > 0.005;

  async function submit(allowAmountMismatch: boolean) {
    if (!plan || !option?.id || !coversUntil) return;
    setBusy(true); setError("");
    const res = await fetch(`/api/members/${memberId}/enroll-paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        membershipId: plan.id,
        optionId: option.id,
        amountReceived: Number(amount),
        method,
        reference: reference.trim() || null,
        coversUntil,
        startCardBilling: startCard,
        note: note.trim() || null,
        allowAmountMismatch,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Could not enrol this member.");
      return;
    }
    setDone(typeof d.message === "string" ? d.message : "Enrolled.");
    setOpen(false);
    onChanged?.();
  }

  return (
    <div className={`rounded-xl border border-app-border bg-surface p-4 ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
            <Banknote size={14} /> Already paid?
          </h3>
          <p className="text-xs text-text-muted mt-1">
            {memberName} handed over cash or a check and needs putting on a membership from
            that point. This records the payment and starts the membership together.
          </p>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="shrink-0 text-sm px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover"
          >
            Enrol
          </button>
        )}
      </div>

      {done && !open && (
        <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2.5 py-1.5 mt-2.5">{done}</p>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          {error && (
            <p className="text-xs text-white bg-red-600 rounded-lg px-2.5 py-2">{error}</p>
          )}

          <div>
            <label className="block text-xs text-text-muted mb-1">Membership</label>
            <select
              value={planId}
              onChange={(e) => { setPlanId(e.target.value); setOptionId(""); setAmount(""); }}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary"
            >
              <option value="">{plans === null ? "Loading…" : "Choose a plan"}</option>
              {(plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          {plan && (
            <div>
              <label className="block text-xs text-text-muted mb-1">Which option they bought</label>
              <div className="space-y-1.5">
                {plan.options.map((o) => (
                  <button
                    key={o.id ?? o.label}
                    onClick={() => pickOption(o)}
                    disabled={!o.id}
                    title={!o.id ? "This option has no id yet and cannot be sold from here" : undefined}
                    className={`w-full text-left px-3 py-2 rounded-lg border text-sm disabled:opacity-40 ${
                      optionId === o.id
                        ? "border-brand bg-brand/10 text-text-primary"
                        : "border-app-border text-text-primary hover:bg-app-bg"
                    }`}
                  >
                    {o.label} — ${o.price} {o.billingPeriod.toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          )}

          {option && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">Amount received</label>
                  <input
                    type="number" step="0.01" min="0" value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary"
                  />
                  {amountMismatch && (
                    <p className="text-[11px] text-orange-accent mt-1">
                      {option.label} is ${option.price.toFixed(2)}. Recording a different figure needs a
                      second confirmation below.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">How they paid</label>
                  <div className="flex gap-2">
                    {(["CASH", "CHECK"] as const).map((m) => (
                      <button
                        key={m} onClick={() => setMethod(m)}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm ${
                          method === m ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"
                        } text-text-primary`}
                      >
                        {m === "CASH" ? "Cash" : "Check"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {method === "CHECK" && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">Check number / reference</label>
                  <input
                    value={reference} onChange={(e) => setReference(e.target.value)}
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs text-text-muted mb-1">This payment covers them until</label>
                <input
                  type="date" value={coversUntil}
                  onChange={(e) => setCoversUntil(e.target.value)}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary"
                />
                <p className="text-[11px] text-text-muted mt-1">
                  The last day the money buys. Billing resumes after it — this is the single most
                  important field on this form.
                </p>
              </div>

              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input
                  type="checkbox" checked={startCard}
                  onChange={(e) => setStartCard(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Start card billing when that runs out
                  <span className="block text-[11px] text-text-muted">
                    Needs a usable saved card. Nothing is charged today unless the date above has
                    already passed.
                  </span>
                </span>
              </label>

              <div>
                <label className="block text-xs text-text-muted mb-1">Note (optional)</label>
                <input
                  value={note} onChange={(e) => setNote(e.target.value)}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary"
                />
              </div>

              {/* Say what will happen, in the same words the audit log will use. */}
              {coversUntil && (
                <div className="text-xs text-text-primary bg-app-bg rounded-lg px-2.5 py-2 space-y-1">
                  <p>
                    <strong>{memberName}</strong> goes on <strong>{option.label}</strong>, paid through{" "}
                    <strong>{fmtDay(coversUntil)}</strong> by {method.toLowerCase()}.
                  </p>
                  {startCard && (
                    <p>
                      {coversInPast
                        ? "That date has already passed, so the card is charged immediately and every period after."
                        : `The card is first charged on ${fmtDay(coversUntil)}.`}
                    </p>
                  )}
                  {!startCard && <p className="text-text-muted">No card billing — you collect the next one too.</p>}
                </div>
              )}
            </>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => submit(false)}
              disabled={busy || !option?.id || !coversUntil || !amount}
              className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? "Working…" : "Record payment & enrol"}
            </button>
            {amountMismatch && (
              <button
                onClick={() => submit(true)}
                disabled={busy}
                className="text-sm px-3 py-2 border border-orange-accent text-orange-accent rounded-lg hover:bg-orange-accent/10 disabled:opacity-50"
              >
                Record ${Number(amount || 0).toFixed(2)} anyway
              </button>
            )}
            <button
              onClick={() => { setOpen(false); setError(""); }}
              disabled={busy}
              className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
