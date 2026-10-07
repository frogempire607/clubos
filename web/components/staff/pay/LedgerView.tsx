"use client";

// Payroll → Pay lines: the pay ledger. Every payable thing since the club's
// ledger start date, per coach, with the rate that priced it — class days
// worked, salary per pay period, plan bonuses, and bonuses / adjustments added
// by hand. From here an authorized person sets the pay for one line, adds a
// bonus or adjustment, and records a payout for chosen lines. A paid line is
// locked. Read-only without Financials & payroll: full, and on your own pay.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import Sheet from "@/components/Sheet";
import {
  SOURCE_LABELS,
  fmtCents,
  fmtYmd,
  fmtYmdYear,
  lineBucket,
  lineMath,
  type LedgerLineView,
  type LedgerTotals,
} from "@/lib/payLedger";
import { centsFromText } from "@/components/staff/pay/planDraft";

type Coach = { userId: string; name: string; removed: boolean; hasSchedule: boolean; lines: LedgerLineView[]; totals: LedgerTotals };
type Resp = {
  ledgerStart: string | null;
  today: string;
  from: string | null;
  to: string | null;
  coaches: Coach[];
  notes: { userId: string; name: string; warnings: string[] }[];
  viewer: { canEdit: boolean; userId: string; isOwner: boolean };
};

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHECK", label: "Check" },
  { value: "TRANSFER", label: "Transfer" },
  { value: "OTHER", label: "Other" },
] as const;

const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px]";
const link = "inline-flex min-h-[44px] items-center text-[13px] font-medium text-brand hover:underline md:min-h-[30px]";
const input =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand md:min-h-[38px]";

const warn: React.CSSProperties = { background: "var(--color-warn-surface)", color: "var(--color-warn-text)", borderColor: "var(--color-warn-border)" };
const good: React.CSSProperties = { background: "var(--color-success-surface)", color: "var(--color-success-text)", borderColor: "var(--color-success-border)" };

function statusPill(l: LedgerLineView): { text: string; style?: React.CSSProperties } {
  const b = lineBucket(l);
  if (b === "PAID") return { text: "Paid", style: good };
  if (b === "ON_PAYOUT") return { text: "On a pending payout" };
  if (b === "REVIEW") return { text: "Needs review", style: warn };
  if (b === "VOID") return { text: "Not payable" };
  return { text: "Unpaid" };
}

type Act =
  | { kind: "override"; coach: Coach; line: LedgerLineView }
  | { kind: "manual"; coach: Coach; line: LedgerLineView | null }
  | { kind: "void"; coach: Coach; line: LedgerLineView }
  | { kind: "payout"; coach: Coach };

export default function LedgerView({ refreshKey = 0, focusUserId = null }: { refreshKey?: number; focusUserId?: string | null }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showVoid, setShowVoid] = useState(false);
  const [act, setAct] = useState<Act | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // form fields shared by the sheets
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState("");
  const [manualKind, setManualKind] = useState<"BONUS" | "ADJUSTMENT">("BONUS");
  const [picked, setPicked] = useState<string[]>([]);
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("TRANSFER");
  const [payNow, setPayNow] = useState(true);
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    const q = range ? `?from=${range.from}&to=${range.to}` : "";
    const r = await fetch(`/api/payroll/ledger${q}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setLoadError(typeof d.error === "string" ? d.error : "Couldn't load pay lines.");
      return;
    }
    setLoadError(null);
    setData(d);
  }, [range]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (focusUserId) setOpen((m) => ({ ...m, [focusUserId]: true }));
  }, [focusUserId]);

  const totals = useMemo(() => {
    const t = { unpaid: 0, review: 0, onPayout: 0, paid: 0 };
    for (const c of data?.coaches ?? []) {
      t.unpaid += c.totals.unpaidCents;
      t.review += c.totals.reviewCount;
      t.onPayout += c.totals.onPayoutCents;
      t.paid += c.totals.paidCents;
    }
    return t;
  }, [data]);

  if (loadError) {
    return <div className="rounded-xl border border-app-border bg-surface p-5 text-[13px]" style={{ color: "var(--color-danger-text)" }}>{loadError}</div>;
  }
  if (!data) return <div className="h-40 animate-pulse rounded-xl border border-app-border bg-surface" aria-label="Loading pay lines" />;
  if (!data.ledgerStart) return null;

  const { viewer, today, ledgerStart } = data;
  const from = data.from ?? ledgerStart;
  const to = data.to ?? today;
  const canEditFor = (c: Coach) => viewer.canEdit && (viewer.isOwner || c.userId !== viewer.userId);
  const voidCount = data.coaches.reduce((a, c) => a + c.lines.filter((l) => l.status === "VOID").length, 0);

  function start(a: Act) {
    setError(null);
    setAct(a);
    if (a.kind === "override") {
      setAmount(a.line.rateSource === "OVERRIDE" && a.line.amountCents !== null ? (a.line.amountCents / 100).toFixed(2) : "");
      setReason(a.line.rateSource === "OVERRIDE" ? a.line.overrideReason ?? "" : "");
    } else if (a.kind === "manual") {
      setManualKind(a.line ? (a.line.sourceType === "BONUS" ? "BONUS" : "ADJUSTMENT") : "BONUS");
      setAmount(a.line?.amountCents != null ? (a.line.amountCents / 100).toFixed(2) : "");
      setDesc(a.line?.description ?? "");
      setDate(a.line?.workDate ?? today);
    } else if (a.kind === "void") {
      setReason("");
    } else {
      // Everything that can be paid and is not dated in the future is ticked.
      setPicked(a.coach.lines.filter((l) => lineBucket(l) === "UNPAID" && l.workDate <= today).map((l) => l.id));
      setMethod("TRANSFER");
      setPayNow(true);
      setNotes("");
    }
  }

  async function send(url: string, method_: string, body: unknown, ok: string) {
    setBusy(true);
    setError(null);
    const r = await fetch(url, { method: method_, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "That didn't save. Try again.");
      return;
    }
    setAct(null);
    setFlash(ok);
    await load();
  }

  async function submit() {
    if (!act) return;
    if (act.kind === "override") {
      const cents = centsFromText(amount);
      if (cents === null || cents < 0) return setError("Enter the amount to pay.");
      if (!reason.trim()) return setError("Say why this is paid differently.");
      await send(`/api/payroll/lines/${act.line.id}`, "PATCH", { action: "override", amount: cents / 100, reason: reason.trim() }, `Set the pay for ${act.line.description} to ${fmtCents(cents)}.`);
    } else if (act.kind === "manual") {
      const cents = centsFromText(amount);
      if (cents === null || cents === 0) return setError("Enter an amount.");
      if (manualKind === "BONUS" && cents < 0) return setError("A bonus can't be negative — choose Adjustment to take pay off.");
      if (!desc.trim()) return setError("Say what this is for.");
      if (act.line) {
        await send(`/api/payroll/lines/${act.line.id}`, "PATCH", { action: "edit", amount: cents / 100, description: desc.trim(), workDate: date }, "Saved.");
      } else {
        await send("/api/payroll/lines", "POST", { userId: act.coach.userId, kind: manualKind, amount: cents / 100, description: desc.trim(), workDate: date },
          `Added ${fmtCents(cents)} for ${act.coach.name}.`);
      }
    } else if (act.kind === "void") {
      if (!reason.trim()) return setError("Say why this is being removed.");
      await send(`/api/payroll/lines/${act.line.id}`, "PATCH", { action: "void", reason: reason.trim() }, "Removed.");
    } else {
      if (picked.length === 0) return setError("Tick at least one line to pay.");
      const total = act.coach.lines.filter((l) => picked.includes(l.id)).reduce((a, l) => a + (l.amountCents ?? 0), 0);
      await send("/api/payroll/ledger/payouts", "POST",
        { userId: act.coach.userId, lineIds: picked, status: payNow ? "PAID" : "PENDING", method: payNow ? method : null, notes: notes.trim() || null },
        payNow ? `Recorded ${fmtCents(total)} paid to ${act.coach.name}. Those lines are now locked.` : `Queued a ${fmtCents(total)} payout for ${act.coach.name} in Payouts.`);
    }
  }

  async function clearOverride(line: LedgerLineView) {
    setFlash(null);
    const r = await fetch(`/api/payroll/lines/${line.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clearOverride" }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setFlash(null);
      setActionError(typeof d.error === "string" ? d.error : "That didn't save.");
      return;
    }
    setActionError(null);
    setFlash(`Put ${line.description} back to the pay plan's amount.`);
    await load();
  }

  const presets: { label: string; from: string; to: string }[] = [
    { label: "Everything so far", from: ledgerStart, to: today },
    { label: "Last 14 days", from: maxYmd(ledgerStart, shift(today, -13)), to: today },
    { label: "This month", from: maxYmd(ledgerStart, `${today.slice(0, 7)}-01`), to: today },
  ];
  const payoutTotal = act?.kind === "payout" ? act.coach.lines.filter((l) => picked.includes(l.id)).reduce((a, l) => a + (l.amountCents ?? 0), 0) : 0;

  return (
    <div>
      {flash && <p role="status" className="mb-3 rounded-lg border px-3 py-2 text-[13px]" style={good}>{flash}</p>}
      {actionError && (
        <p role="alert" className="mb-3 rounded-lg border px-3 py-2 text-[13px]"
          style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)", borderColor: "var(--color-danger-border)" }}>
          {actionError}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-app-border bg-surface p-4">
        <div className="flex flex-wrap gap-1 rounded-lg bg-app-bg p-1">
          <button type="button" onClick={() => setRange(null)}
            className={`min-h-[44px] rounded-md px-3 text-[12.5px] md:min-h-[32px] ${range === null ? "bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"}`}>
            All unpaid and upcoming
          </button>
          {presets.map((p) => {
            const on = range !== null && range.from === p.from && range.to === p.to;
            return (
              <button key={p.label} type="button" onClick={() => setRange({ from: p.from, to: p.to })}
                className={`min-h-[44px] rounded-md px-3 text-[12.5px] md:min-h-[32px] ${on ? "bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"}`}>
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <label className="block">
            <span className="mb-0.5 block text-[12px] uppercase tracking-wider text-text-muted">From</span>
            <input type="date" value={from} min={ledgerStart} onChange={(e) => e.target.value && setRange({ from: maxYmd(ledgerStart, e.target.value), to })} className="min-h-[44px] rounded border border-app-border bg-surface px-2 text-sm md:min-h-[34px]" />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[12px] uppercase tracking-wider text-text-muted">To</span>
            <input type="date" value={to} min={ledgerStart} onChange={(e) => e.target.value && setRange({ from, to: e.target.value })} className="min-h-[44px] rounded border border-app-border bg-surface px-2 text-sm md:min-h-[34px]" />
          </label>
        </div>
        <p className="basis-full text-[12.5px] text-text-muted">
          Pay lines start on {fmtYmdYear(ledgerStart)}. Nothing before that date is here — use “Before {fmtYmd(ledgerStart)}” for the old calculation.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Unpaid" value={fmtCents(totals.unpaid)} accent />
        <Tile label="Needs review" value={String(totals.review)} hint={totals.review > 0 ? "no amount yet" : undefined} />
        <Tile label="On pending payouts" value={fmtCents(totals.onPayout)} />
        <Tile label="Paid" value={fmtCents(totals.paid)} />
      </div>

      {data.notes.length > 0 && (
        <div className="mb-4 rounded-xl border px-4 py-3 text-[13px]" style={warn}>
          <p className="font-medium">Pay setup to check</p>
          <ul className="mt-1 space-y-1">
            {data.notes.flatMap((n) => n.warnings.map((w) => (
              <li key={`${n.userId}-${w}`}>
                <Link href={`/dashboard/staff/${n.userId}?tab=pay`} className="font-medium underline">{n.name}</Link>: {w}
              </li>
            )))}
          </ul>
        </div>
      )}

      {data.coaches.length === 0 ? (
        <div className="rounded-xl border border-app-border bg-surface p-10 text-center">
          <p className="text-base font-medium text-text-primary">{today < ledgerStart ? `Pay lines start on ${fmtYmdYear(ledgerStart)}` : "No pay lines in these dates"}</p>
          <p className="mt-1 text-sm text-text-muted">
            A class day gets a pay line once it has ended, for every coach who was scheduled on it. Salary gets one line per pay period.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.coaches.map((c) => {
            const isOpen = !!open[c.userId];
            const editable = canEditFor(c);
            const visible = c.lines.filter((l) => showVoid || l.status !== "VOID");
            return (
              <section key={c.userId} className="rounded-xl border border-app-border bg-surface" aria-label={`${c.name} pay lines`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                  <button type="button" onClick={() => setOpen((m) => ({ ...m, [c.userId]: !isOpen }))} aria-expanded={isOpen}
                    className="flex min-h-[44px] min-w-0 flex-1 basis-[220px] items-center gap-2 text-left">
                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />}
                    <span className="min-w-0">
                      <span className="block break-words text-[15px] font-semibold text-text-primary">
                        {c.name}{c.removed && <span className="ml-2 text-[12.5px] font-normal text-text-muted">no longer on staff</span>}
                      </span>
                      <span className="block text-[12.5px] text-text-muted">
                        {c.lines.filter((l) => l.status !== "VOID").length} line{c.lines.filter((l) => l.status !== "VOID").length === 1 ? "" : "s"}
                        {c.totals.paidCents > 0 ? ` · ${fmtCents(c.totals.paidCents)} paid` : ""}
                        {c.totals.onPayoutCents > 0 ? ` · ${fmtCents(c.totals.onPayoutCents)} on a pending payout` : ""}
                      </span>
                    </span>
                  </button>
                  {c.totals.reviewCount > 0 && (
                    <span className="rounded-full border px-2 py-0.5 text-[12px] font-medium" style={warn}>
                      {c.totals.reviewCount} to review
                    </span>
                  )}
                  <div className="text-right">
                    <p className="text-[12px] uppercase tracking-wider text-text-muted">Unpaid</p>
                    <p className="text-[16px] font-semibold text-text-primary">{fmtCents(c.totals.unpaidCents)}</p>
                  </div>
                  {editable && (
                    <button type="button" disabled={c.totals.payableLineIds.length === 0} onClick={() => start({ kind: "payout", coach: c })}
                      className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-40`}>
                      Record payout
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="border-t border-app-border">
                    {visible.length === 0 ? (
                      <p className="px-4 py-3 text-[13px] text-text-muted sm:px-5">Nothing to show.</p>
                    ) : (
                      <ul className="divide-y divide-app-border">
                        {visible.map((l) => {
                          const pill = statusPill(l);
                          const bucket = lineBucket(l);
                          const open_ = bucket === "UNPAID" || bucket === "REVIEW";
                          const manual = l.rateSource === "MANUAL";
                          const math = lineMath(l);
                          return (
                            <li key={l.id} className={`flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5 ${l.status === "VOID" ? "opacity-60" : ""}`}>
                              <div className="w-[64px] shrink-0 pt-0.5 text-[13px] text-text-muted">{fmtYmd(l.workDate)}</div>
                              <div className="min-w-0 flex-1 basis-[220px]">
                                <p className="break-words text-[14px] text-text-primary">{l.description}</p>
                                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-text-muted">
                                  <span>{SOURCE_LABELS[l.sourceType] ?? l.sourceType}</span>
                                  {manual ? <span>· added by hand</span>
                                    : l.rateSource === "OVERRIDE" ? (
                                      <span>
                                        · pay set for this line{l.overrideByName ? ` by ${l.overrideByName}` : ""}
                                        {l.planAmountCents !== null ? ` (the plan would pay ${fmtCents(l.planAmountCents)})` : ""}
                                      </span>
                                    ) : l.planName ? <span>· {l.planName}{math ? ` · ${math}` : ""}</span> : null}
                                </p>
                                {l.rateSource === "OVERRIDE" && l.overrideReason && <p className="mt-0.5 text-[12.5px] text-text-muted">Why: {l.overrideReason}</p>}
                                {bucket === "REVIEW" && l.reviewReason && <p className="mt-1 rounded-md border px-2 py-1 text-[12.5px]" style={warn}>{l.reviewReason}</p>}
                                {l.status === "VOID" && l.voidReason && <p className="mt-0.5 text-[12.5px] text-text-muted">{l.voidReason}</p>}
                                {editable && open_ && (
                                  <div className="mt-0.5 flex flex-wrap gap-x-4">
                                    {manual ? (
                                      <>
                                        <button type="button" className={link} onClick={() => start({ kind: "manual", coach: c, line: l })}>Edit</button>
                                        <button type="button" className={link} onClick={() => start({ kind: "void", coach: c, line: l })}>Remove</button>
                                      </>
                                    ) : (
                                      <>
                                        <button type="button" className={link} onClick={() => start({ kind: "override", coach: c, line: l })}>
                                          {l.rateSource === "OVERRIDE" ? "Change the pay for this line" : "Set the pay for this line"}
                                        </button>
                                        {l.rateSource === "OVERRIDE" && <button type="button" className={link} onClick={() => clearOverride(l)}>Back to the plan</button>}
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                              <div className="ml-auto text-right">
                                <p className="text-[14px] font-semibold text-text-primary">{fmtCents(l.amountCents)}</p>
                                <span className="mt-0.5 inline-block rounded-full border border-app-border bg-app-bg px-2 py-0.5 text-[12px] text-text-muted" style={pill.style}>{pill.text}</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {editable && (
                      <div className="border-t border-app-border px-4 py-1.5 sm:px-5">
                        <button type="button" className={link} onClick={() => start({ kind: "manual", coach: c, line: null })}>+ Add a bonus or adjustment</button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {voidCount > 0 && (
        <button type="button" className={`${link} mt-2`} onClick={() => setShowVoid((v) => !v)}>
          {showVoid ? "Hide" : "Show"} lines that are no longer payable ({voidCount})
        </button>
      )}

      {/* Set the pay for one line */}
      <Sheet
        open={act?.kind === "override"}
        onClose={() => (busy ? undefined : setAct(null))}
        title="Set the pay for this line"
        description={act?.kind === "override" ? <>{act.coach.name} · {act.line.description} · {fmtYmd(act.line.workDate)}. This changes this one line only — no pay plan is changed.</> : undefined}
        footer={<SheetButtons busy={busy} onCancel={() => setAct(null)} onOk={submit} ok="Set pay" />}
      >
        {act?.kind === "override" && (
          <div className="space-y-4 pt-1">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Pay for this line</span>
              <Money value={amount} onChange={setAmount} />
              <span className="mt-1 block text-[12px] text-text-muted">
                {act.line.planAmountCents !== null ? `Their plan would pay ${fmtCents(act.line.planAmountCents)}.` : "No pay plan covers this line."}
              </span>
            </label>
            {act.line.matchRegular && (
              <button type="button" className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}
                onClick={() => { setAmount((act.line.matchRegular!.cents / 100).toFixed(2)); if (!reason.trim()) setReason(`Paid ${act.line.matchRegular!.name}'s rate for covering`); }}>
                Match {act.line.matchRegular.name}&apos;s rate ({fmtCents(act.line.matchRegular.cents)})
              </button>
            )}
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Why</span>
              <input className={input} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Covered as lead coach" />
              <span className="mt-1 block text-[12px] text-text-muted">Saved with your name and the time.</span>
            </label>
            {error && <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>{error}</p>}
          </div>
        )}
      </Sheet>

      {/* Bonus / adjustment */}
      <Sheet
        open={act?.kind === "manual"}
        onClose={() => (busy ? undefined : setAct(null))}
        title={act?.kind === "manual" && act.line ? "Edit this line" : "Add a bonus or adjustment"}
        description={act?.kind === "manual" ? `For ${act.coach.name}. It is added to what they are owed and paid with their next payout.` : undefined}
        footer={<SheetButtons busy={busy} onCancel={() => setAct(null)} onOk={submit} ok={act?.kind === "manual" && act.line ? "Save" : "Add"} />}
      >
        {act?.kind === "manual" && (
          <div className="space-y-4 pt-1">
            {!act.line && (
              <div role="radiogroup" aria-label="Kind" className="grid grid-cols-2 gap-2">
                {([["BONUS", "Bonus", "extra pay"], ["ADJUSTMENT", "Adjustment", "add or take off (use a minus)"]] as const).map(([v, label, d]) => {
                  const on = manualKind === v;
                  return (
                    <button key={v} type="button" role="radio" aria-checked={on} onClick={() => setManualKind(v)}
                      className={`min-h-[44px] rounded-lg border px-3 py-2 text-left ${on ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"}`}>
                      <span className={`block text-[13.5px] font-medium ${on ? "text-brand" : "text-text-primary"}`}>{label}</span>
                      <span className="block text-[12px] text-text-muted">{d}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Amount</span>
              <Money value={amount} onChange={setAmount} allowNegative={manualKind === "ADJUSTMENT"} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">What it&apos;s for</span>
              <input className={input} value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Tournament weekend bonus" />
            </label>
            <label className="block max-w-[220px]">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Date</span>
              <input type="date" className={input} value={date} min={ledgerStart} max={today} onChange={(e) => setDate(e.target.value)} />
            </label>
            {error && <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>{error}</p>}
          </div>
        )}
      </Sheet>

      {/* Remove a hand-made line */}
      <Sheet
        open={act?.kind === "void"}
        onClose={() => (busy ? undefined : setAct(null))}
        title="Remove this line?"
        description={act?.kind === "void" ? <>{act.line.description} · {fmtCents(act.line.amountCents)} for {act.coach.name}. It stays on record as removed.</> : undefined}
        footer={<SheetButtons busy={busy} onCancel={() => setAct(null)} onOk={submit} ok="Remove" />}
      >
        <div className="space-y-2 pt-1">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Why</span>
            <input className={input} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>{error}</p>}
        </div>
      </Sheet>

      {/* Record a payout */}
      <Sheet
        open={act?.kind === "payout"}
        onClose={() => (busy ? undefined : setAct(null))}
        title={act?.kind === "payout" ? `Pay ${act.coach.name}` : "Record payout"}
        description="One payout for the ticked lines. This records the payment — it doesn't send money. Paid lines are locked."
        width={560}
        footer={<SheetButtons busy={busy} onCancel={() => setAct(null)} onOk={submit} ok={payNow ? `Record ${fmtCents(payoutTotal)} paid` : `Queue ${fmtCents(payoutTotal)}`} />}
      >
        {act?.kind === "payout" && (
          <div className="space-y-4 pt-1">
            <ul className="max-h-64 divide-y divide-app-border overflow-y-auto rounded-lg border border-app-border">
              {act.coach.lines.filter((l) => lineBucket(l) === "UNPAID").map((l) => {
                const on = picked.includes(l.id);
                return (
                  <li key={l.id}>
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-app-bg">
                      <input type="checkbox" className="h-4 w-4 shrink-0" checked={on} onChange={() => setPicked(on ? picked.filter((x) => x !== l.id) : [...picked, l.id])} />
                      <span className="min-w-0 flex-1 text-[13px] text-text-primary">
                        <span className="text-text-muted">{fmtYmd(l.workDate)} · </span>{l.description}
                        {l.workDate > today && <span className="text-text-muted"> (dated ahead)</span>}
                      </span>
                      <span className="shrink-0 text-[13px] font-medium text-text-primary">{fmtCents(l.amountCents)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {act.coach.totals.reviewCount > 0 && (
              <p className="rounded-lg border px-3 py-2 text-[13px]" style={warn}>
                {act.coach.totals.reviewCount} line{act.coach.totals.reviewCount === 1 ? "" : "s"} need review and can&apos;t be paid until they have an amount.
              </p>
            )}
            <p className="text-[15px] font-semibold text-text-primary">Total {fmtCents(payoutTotal)}</p>
            <div role="radiogroup" aria-label="When" className="grid grid-cols-2 gap-2">
              {([[true, "Paid now", "locks these lines"], [false, "Pay later", "queues it in Payouts"]] as const).map(([v, label, d]) => (
                <button key={label} type="button" role="radio" aria-checked={payNow === v} onClick={() => setPayNow(v)}
                  className={`min-h-[44px] rounded-lg border px-3 py-2 text-left ${payNow === v ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"}`}>
                  <span className={`block text-[13.5px] font-medium ${payNow === v ? "text-brand" : "text-text-primary"}`}>{label}</span>
                  <span className="block text-[12px] text-text-muted">{d}</span>
                </button>
              ))}
            </div>
            {payNow && (
              <fieldset>
                <legend className="mb-1 text-[13px] font-medium text-text-primary">Paid by</legend>
                <div role="radiogroup" aria-label="Paid by" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {METHODS.map((m) => (
                    <button key={m.value} type="button" role="radio" aria-checked={method === m.value} onClick={() => setMethod(m.value)}
                      className={`min-h-[44px] rounded-lg border px-3 text-[13.5px] font-medium ${method === m.value ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Note (optional)</span>
              <input className={input} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
            </label>
            {error && <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>{error}</p>}
          </div>
        )}
      </Sheet>
    </div>
  );
}

const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const maxYmd = (a: string, b: string) => (a > b ? a : b);

function Tile({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-brand bg-brand/5" : "border-app-border bg-surface"}`}>
      <p className="mb-1 text-[12px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`text-xl font-semibold ${accent ? "text-brand" : "text-text-primary"}`}>{value}</p>
      {hint && <p className="text-[12px] text-text-muted">{hint}</p>}
    </div>
  );
}

function Money({ value, onChange, allowNegative }: { value: string; onChange: (v: string) => void; allowNegative?: boolean }) {
  return (
    <div className="relative max-w-[220px]">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">$</span>
      <input type="text" inputMode={allowNegative ? "text" : "decimal"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={allowNegative ? "0.00 or -0.00" : "0.00"}
        className="min-h-[44px] w-full rounded-lg border border-app-border bg-surface pl-7 pr-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand" />
    </div>
  );
}

function SheetButtons({ busy, onCancel, onOk, ok }: { busy: boolean; onCancel: () => void; onOk: () => void; ok: string }) {
  return (
    <>
      <button type="button" disabled={busy} onClick={onCancel} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`}>Cancel</button>
      <button type="button" disabled={busy} onClick={onOk} className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}>{busy ? "Saving…" : ok}</button>
    </>
  );
}
