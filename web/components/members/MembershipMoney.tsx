"use client";

// B16 — the money half of the Membership panel: one summary in plain words
// with real dates, one list of payment actions, the recent payments with
// Refund, and who-did-what history. Every sheet asks the server for its
// sentences first (`preview: true` on the same route that acts), so what the
// owner reads is what runs. Nothing here does date maths of its own.
//
// The trap this replaces: "Advanced billing setup → payment method: Cash"
// edited a migration draft and changed nothing about billing, so Stripe still
// charged Blake's family on the 27th. Here the two real jobs have their own
// buttons — "They paid another way this time" and "Switch how they pay".

import { useEffect, useState } from "react";
import AppSheet from "@/components/Sheet";

// ── Payload (mirrors buildMoney in the membership-panel route) ───────────────

export type MoneyPayment = {
  id: string; at: string; amount: number; method: string; status: string; tone: "ok" | "warn" | "bad" | "pend";
  description: string | null; covers: { start: string; end: string } | null; refundable: number; refundReason: string | null;
};
export type MoneyPayload = {
  subscriptionId: string;
  hasStripe: boolean;
  liveRead: boolean | null;
  pmLabel: string | null;
  howTheyPay: string;
  next: { at: string | null; amount: number | null; text: string; overdue: boolean };
  paidThrough: string | null;
  commitment:
    | { state: "NONE"; text: string }
    | { state: "MISSING"; text: string; suggestedStart: string; suggestedEnd: string; months: number }
    | { state: "ACTIVE" | "DONE"; text: string; end: string; then: "renews" | "ends"; progress: string | null };
  skippedChargeAt: string | null;
  autoRenew: { on: boolean; nowText: string; toggle: { endsAt: string | null; sentence: string; blocked?: boolean } };
  payments: MoneyPayment[];
  history: { id: string; at: string; text: string }[];
};

export type MoneySheet = null | "paid" | "waive" | "switch" | "autorenew" | "commit" | "chargeDate" | { refund: MoneyPayment };

const fmt = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
const fmtS = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const money2 = (n: number) => `$${n.toFixed(2)}`;

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

const btn = "min-h-[44px] px-4 py-2 rounded-lg border border-app-border bg-surface text-sm text-text-primary hover:bg-app-bg disabled:opacity-50";
const btnP = "min-h-[44px] px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50";
const btnD = "min-h-[44px] px-4 py-2 rounded-lg bg-danger text-white text-sm font-medium hover:opacity-90 disabled:opacity-50";
const input = "w-full min-h-[44px] px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary";
const chip = (on: boolean) => `min-h-[44px] px-3.5 rounded-full border text-[13px] ${on ? "border-brand bg-brand/5 text-brand-hover font-semibold" : "border-app-border text-text-primary"}`;

// ── Summary ──────────────────────────────────────────────────────────────────

export function MoneySummary({ m, canBill, payer, onOpen }: { m: MoneyPayload; canBill: boolean; payer: string | null; onOpen: (s: MoneySheet) => void }) {
  const c = m.commitment;
  const rows: { k: string; v: React.ReactNode; tone?: "warn" }[] = [
    { k: "How they pay", v: m.howTheyPay },
    { k: "Next payment", v: m.next.text, tone: m.next.overdue ? "warn" : undefined },
    { k: "Paid through", v: fmt(m.paidThrough) },
    {
      k: "Commitment",
      v: (
        <>
          {c.text}
          {c.state === "MISSING" && canBill && (
            <button type="button" className="block mt-1 min-h-[44px] text-brand font-medium hover:underline" onClick={() => onOpen("commit")}>
              Set commitment dates ({fmtS(c.suggestedStart)} – {fmt(c.suggestedEnd)}) →
            </button>
          )}
        </>
      ),
      tone: c.state === "MISSING" ? "warn" : undefined,
    },
  ];
  if (payer) rows.push({ k: "Payer", v: payer });
  return (
    <div className="mt-3 rounded-xl border border-app-border divide-y divide-app-border">
      {rows.map((r) => (
        <div key={r.k} className="px-3 py-2.5 sm:flex sm:gap-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted sm:w-32 sm:shrink-0 sm:pt-0.5">{r.k}</div>
          <div className={`text-[13.5px] leading-[1.45] ${r.tone === "warn" ? "text-warn-text" : "text-text-primary"}`}>{r.v}</div>
        </div>
      ))}
      <div className="px-3 py-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Auto-renew</div>
          <div className="text-[13.5px] text-text-primary">
            {m.autoRenew.nowText}
          </div>
        </div>
        <button
          type="button" role="switch" aria-checked={m.autoRenew.on} aria-label="Auto-renew" disabled={!canBill || m.autoRenew.toggle.blocked}
          onClick={() => onOpen("autorenew")}
          className="shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[56px] disabled:opacity-50"
        >
          <span className={`relative inline-block w-11 h-[26px] rounded-full transition ${m.autoRenew.on ? "bg-brand" : "bg-inset-dashed"}`}>
            <span className={`absolute top-[3px] h-5 w-5 rounded-full bg-surface shadow transition-all ${m.autoRenew.on ? "left-[21px]" : "left-[3px]"}`} />
          </span>
        </button>
      </div>
      {m.skippedChargeAt && (
        <div className="px-3 py-2.5 text-[13px] bg-info-surface text-text-primary">The {fmtS(m.skippedChargeAt)} charge will be skipped — nothing is charged that day.</div>
      )}
      {m.hasStripe && m.liveRead === false && (
        <div className="px-3 py-2 text-[12px] text-text-muted">Stripe didn&apos;t answer just now — showing the last synced details.</div>
      )}
    </div>
  );
}

// ── Payment actions ──────────────────────────────────────────────────────────

export function MoneyActions({ m, onOpen, disabled }: { m: MoneyPayload; onOpen: (s: MoneySheet) => void; disabled?: boolean }) {
  const next = m.next.at ? fmtS(m.next.at) : null;
  const items: { key: MoneySheet; label: string; sub: string }[] = m.hasStripe
    ? [
        { key: "paid", label: "They paid another way this time", sub: `Record cash or check${next ? ` and skip the ${next} charge` : ""} so they aren't charged twice.` },
        { key: "waive", label: "Waive a payment", sub: `Give ${next ? `the ${next} payment` : "one payment"} free — e.g. for volunteer help.` },
        { key: "chargeDate", label: "Change charge date", sub: next ? `Next charge ${next} — move it to another day. Renews on the new day after that.` : "Move the next charge to another day." },
        { key: "switch", label: "Switch how they pay", sub: "Stop automatic charges and collect cash or check from now on." },
      ]
    : [
        { key: "paid", label: "Record a payment", sub: "Cash or check they handed over for the next period." },
        { key: "waive", label: "Waive a payment", sub: "Give one period free — e.g. for volunteer help." },
        { key: "chargeDate", label: "Change due date", sub: next ? `Next payment due ${next} — give them more time.` : "Set when the next payment is due." },
        { key: "switch", label: "Switch to automatic payments", sub: "Charge their saved card or Cash App from when the cash runs out." },
      ];
  return (
    <div className="mt-3">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted mb-1.5">Payments</div>
      <div className="rounded-xl border border-app-border divide-y divide-app-border overflow-hidden">
        {items.map((it) => (
          <button key={it.label} type="button" disabled={disabled} onClick={() => onOpen(it.key)} className="w-full text-left min-h-[56px] px-3 py-2.5 hover:bg-app-bg disabled:opacity-50 flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-text-primary">{it.label}</span>
              <span className="block text-[12.5px] text-text-muted">{it.sub}</span>
            </span>
            <span aria-hidden className="text-text-muted">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Payments list + history ──────────────────────────────────────────────────

const TONE: Record<MoneyPayment["tone"], string> = { ok: "text-success-text", warn: "text-warn-text", bad: "text-danger-text", pend: "text-pending-text" };

export function PaymentsList({ m, canBill, onRefund }: { m: MoneyPayload; canBill: boolean; onRefund: (p: MoneyPayment) => void }) {
  if (m.payments.length === 0 && m.history.length === 0) return null;
  return (
    <div className="mt-3">
      {m.payments.length > 0 && (
        <>
          <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted mb-1.5">Recent payments</div>
          <ul className="rounded-xl border border-app-border divide-y divide-app-border">
            {m.payments.map((p) => (
              <li key={p.id} className="px-3 py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13.5px] text-text-primary">
                    <span className="font-semibold">{money2(p.amount)}</span> · {p.method} · <span className={TONE[p.tone]}>{p.status}</span>
                  </div>
                  <div className="text-[12px] text-text-muted truncate">
                    {fmt(p.at)}{p.covers ? ` · for ${fmtS(p.covers.start)} – ${fmtS(p.covers.end)}` : ""}{p.refundReason ? ` · ${p.refundReason}` : ""}
                  </div>
                </div>
                {canBill && p.refundable > 0 && (
                  <button type="button" className={`${btn} shrink-0`} onClick={() => onRefund(p)}>Refund</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {m.history.length > 0 && (
        <>
          <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted mt-3 mb-1.5">What changed</div>
          <ul className="space-y-1">
            {m.history.slice(0, 6).map((h) => (
              <li key={h.id} className="text-[12.5px] text-text-primary"><span className="text-text-muted">{fmtS(h.at)}</span> · {h.text}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Preview plumbing ─────────────────────────────────────────────────────────

type Preview = { loading: boolean; sentence: string | null; consequence: string | null; facts: Record<string, unknown>; error: string | null; code: string | null; needsChargeAck: boolean };
const EMPTY: Preview = { loading: false, sentence: null, consequence: null, facts: {}, error: null, code: null, needsChargeAck: false };

/** Ask the acting route what it WOULD do. Debounced; the newest answer wins. */
function usePreview(url: string, body: Record<string, unknown>, enabled: boolean): Preview {
  const [p, setP] = useState<Preview>({ ...EMPTY, loading: enabled });
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!enabled) { setP(EMPTY); return; }
    let alive = true;
    setP((x) => ({ ...x, loading: true }));
    const t = setTimeout(async () => {
      const r = await post(url, { ...JSON.parse(key), preview: true });
      if (!alive) return;
      setP(r.ok
        ? { loading: false, sentence: r.d.sentence ?? null, consequence: r.d.consequence ?? null, facts: r.d.facts ?? {}, error: null, code: null, needsChargeAck: !!r.d.needsChargeAck }
        : { ...EMPTY, error: r.d.error ?? "Couldn't work out what this would do.", code: r.d.code ?? null });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [url, key, enabled]);
  return p;
}

function PreviewBox({ p, label = "Stripe" }: { p: Preview; label?: string }) {
  if (p.loading) return <div className="mt-3 rounded-xl bg-app-bg px-3 py-3"><div className="h-4 w-4/5 bg-app-border rounded animate-pulse" /><div className="h-4 w-3/5 bg-app-border rounded animate-pulse mt-2" /></div>;
  if (p.error) return <p role="alert" className="mt-3 rounded-xl border border-danger-border bg-danger-surface text-danger-text px-3 py-2.5 text-[13px]">{p.error}</p>;
  if (!p.sentence) return null;
  return (
    <>
      <div className="mt-3 rounded-xl bg-app-bg px-3 py-2.5 text-sm text-text-primary">{p.sentence}</div>
      {p.consequence && <div className="mt-2 rounded-xl border border-info-border bg-info-surface px-3 py-2 text-[13px] text-text-primary"><b>{label}:</b> {p.consequence}</div>}
    </>
  );
}

function ErrLine({ err }: { err: string }) {
  return err ? <p role="alert" className="mt-3 rounded-xl border border-danger-border bg-danger-surface text-danger-text px-3 py-2.5 text-[13px]">{err}</p> : null;
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="block text-[13px] font-medium text-text-primary mb-1.5 mt-3">{children}</span>;
}

// ── The sheets ───────────────────────────────────────────────────────────────

type SheetProps = { memberId: string; first: string; headline: string; m: MoneyPayload; price: number; onClose: () => void; onDone: (msg: string) => void };

async function commit(url: string, body: Record<string, unknown>, setBusy: (b: boolean) => void, setErr: (e: string) => void, onDone: (m: string) => void) {
  setBusy(true); setErr("");
  const r = await post(url, { ...body, confirm: true });
  if (!r.ok) { setErr(r.d.error ?? "That didn't work — nothing was changed."); setBusy(false); return; }
  onDone(r.d.message ?? "Done.");
}

export function PaidSheet({ memberId, first, headline, m, price, onClose, onDone }: SheetProps) {
  const [method, setMethod] = useState<"CASH" | "CHECK">("CASH");
  const [amount, setAmount] = useState(String(price));
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const amt = Number(amount);
  const url = `/api/members/${memberId}/membership/paid-another-way`;
  const p = usePreview(url, { subscriptionId: m.subscriptionId, method, amount: amt > 0 ? amt : null }, amt > 0);
  const skipAt = (p.facts.skipAt as string | null | undefined) ?? null;
  const cta = m.hasStripe && skipAt ? `Record ${money2(amt || 0)} & skip ${fmtS(skipAt)} charge` : `Record ${money2(amt || 0)} ${method === "CHECK" ? "check" : "cash"}`;
  return (
    <AppSheet open onClose={onClose} title={m.hasStripe ? "They paid another way this time" : "Record a payment"} description={`${first} · ${headline}`}
      footer={<><button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={btnP} disabled={busy || p.loading || !!p.error || !(amt > 0)} onClick={() => commit(url, { subscriptionId: m.subscriptionId, method, amount: amt, reference: reference || null, expectedSkipAt: skipAt }, setBusy, setErr, onDone)}>{busy ? "Working…" : cta}</button></>}>
      <Label>How they paid</Label>
      <div className="flex gap-2">
        {(["CASH", "CHECK"] as const).map((k) => <button key={k} type="button" className={chip(method === k)} onClick={() => setMethod(k)}>{k === "CASH" ? "Cash" : "Check"}</button>)}
      </div>
      <label className="block"><Label>Amount received</Label><input className={input} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="block"><Label>Note (optional)</Label><input className={input} placeholder={method === "CHECK" ? "Check number" : "e.g. handed to Sal at the front desk"} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
      <PreviewBox p={p} label={m.hasStripe ? "Stripe" : "Billing"} />
      {!m.hasStripe && !p.error && <p className="mt-2 text-[12.5px] text-text-muted">Paying this way every time? Nothing to change — this membership is already cash.</p>}
      {m.hasStripe && !p.error && <p className="mt-2 text-[12.5px] text-text-muted">Paying cash from now on? Use <b>Switch how they pay</b> instead.</p>}
      <ErrLine err={err} />
    </AppSheet>
  );
}

const WAIVE_REASONS = ["Volunteer help", "Family hardship", "Staff family", "Make-good for a missed week"];

export function WaiveSheet({ memberId, first, headline, m, onClose, onDone }: SheetProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const url = `/api/members/${memberId}/membership/waive`;
  const p = usePreview(url, { subscriptionId: m.subscriptionId, reason }, reason.trim().length > 0);
  const skipAt = (p.facts.skipAt as string | null | undefined) ?? null;
  const start = (p.facts.waivedStart as string | null | undefined) ?? null;
  return (
    <AppSheet open onClose={onClose} title="Waive a payment" description={`${first} · ${headline}`}
      footer={<><button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={btnP} disabled={busy || p.loading || !!p.error || !reason.trim()} onClick={() => commit(url, { subscriptionId: m.subscriptionId, reason, expectedSkipAt: skipAt }, setBusy, setErr, onDone)}>{busy ? "Working…" : `Waive ${start ? `${fmtS(start)} ` : ""}payment`}</button></>}>
      <Label>Why (shows in the history and in Reports)</Label>
      <div className="flex flex-wrap gap-2">
        {WAIVE_REASONS.map((r) => <button key={r} type="button" className={chip(reason === r)} onClick={() => setReason(reason === r ? "" : r)}>{r}</button>)}
      </div>
      <input className={`${input} mt-2`} placeholder="Or type a reason" value={WAIVE_REASONS.includes(reason) ? "" : reason} onChange={(e) => setReason(e.target.value)} />
      {!reason.trim() ? <p className="mt-3 text-[13px] text-text-muted">Pick or type a reason to see exactly what happens.</p> : <PreviewBox p={p} label={m.hasStripe ? "Stripe" : "Billing"} />}
      <ErrLine err={err} />
    </AppSheet>
  );
}

export function SwitchSheet({ memberId, first, headline, m, onClose, onDone }: SheetProps) {
  const direction = m.hasStripe ? "to_cash" : "to_card";
  const [method, setMethod] = useState<"CASH" | "CHECK">("CASH");
  const [ack, setAck] = useState(false);
  const [link, setLink] = useState<{ url: string; copied: boolean } | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const url = `/api/members/${memberId}/membership/switch-method`;
  const p = usePreview(url, { subscriptionId: m.subscriptionId, direction, method }, true);
  const eff = (p.facts.effectiveAt as string | null | undefined) ?? null;
  const noCard = p.code === "CARD_SETUP_REQUIRED";
  async function sendLink() {
    setBusy(true); setErr("");
    const r = await post(`/api/members/${memberId}/payment-methods/setup`, { intent: "ADD" });
    setBusy(false);
    if (!r.ok || !r.d.url) { setErr(r.d.error ?? "Couldn't create the link."); return; }
    setLink({ url: r.d.url, copied: false });
  }
  const cta = direction === "to_cash" ? `Switch to ${method === "CHECK" ? "check" : "cash"}${eff ? ` from ${fmtS(eff)}` : ""}` : p.needsChargeAck ? "Charge now & start" : `Start automatic payments${eff ? ` ${fmtS(eff)}` : ""}`;
  return (
    <AppSheet open onClose={onClose} title={direction === "to_cash" ? "Switch to cash or check" : "Switch to automatic payments"} description={`${first} · ${headline}`}
      footer={noCard ? <button type="button" className={btn} onClick={onClose}>Close</button> : <><button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={btnP} disabled={busy || p.loading || !!p.error || (p.needsChargeAck && !ack)} onClick={() => commit(url, { subscriptionId: m.subscriptionId, direction, method, confirmImmediateCharge: ack, expectedEffectiveAt: eff }, setBusy, setErr, onDone)}>{busy ? "Working…" : cta}</button></>}>
      {direction === "to_cash" && (
        <>
          <p className="mt-1 text-[13px] text-text-muted">For good — every payment from now on. For just one month, use <b>They paid another way this time</b>.</p>
          <Label>They&apos;ll pay by</Label>
          <div className="flex gap-2">{(["CASH", "CHECK"] as const).map((k) => <button key={k} type="button" className={chip(method === k)} onClick={() => setMethod(k)}>{k === "CASH" ? "Cash" : "Check"}</button>)}</div>
        </>
      )}
      {noCard ? (
        <div className="mt-3">
          <p className="rounded-xl bg-app-bg px-3 py-2.5 text-sm text-text-primary">There&apos;s no saved card or Cash App on file for {first}. Send the family a secure Stripe page to add one — nothing is charged when they save it. Then come back and switch.</p>
          {!link ? (
            <button type="button" className={`${btnP} mt-3 w-full`} disabled={busy} onClick={sendLink}>{busy ? "Creating link…" : "Create a link to add a card"}</button>
          ) : (
            <div className="mt-3">
              <input className={input} readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Card setup link" />
              <div className="flex gap-2 mt-2">
                <button type="button" className={`${btnP} flex-1`} onClick={() => navigator.clipboard?.writeText(link.url).then(() => setLink({ ...link, copied: true }), () => {})}>{link.copied ? "Copied" : "Copy link"}</button>
                <a className={`${btn} flex-1 inline-flex items-center justify-center`} href={link.url} target="_blank" rel="noreferrer">Open it here</a>
              </div>
              <p className="mt-2 text-[12.5px] text-text-muted">Text or email it to the family, or open it on this device and hand it over.</p>
            </div>
          )}
        </div>
      ) : (
        <PreviewBox p={p} />
      )}
      {p.needsChargeAck && !p.error && (
        <label className="flex items-start gap-2 text-sm text-text-primary mt-3 min-h-[44px]"><input type="checkbox" className="mt-0.5 w-[18px] h-[18px]" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I understand they are charged <b>{money2(Number(p.facts.chargeAmount ?? 0))} right now</b>.</span></label>
      )}
      <ErrLine err={err} />
    </AppSheet>
  );
}

export function RefundSheet({ memberId, first, m, payment, onClose, onDone }: SheetProps & { payment: MoneyPayment }) {
  const [mode, setMode] = useState<"full" | "part">("full");
  const [amount, setAmount] = useState(String(payment.refundable));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const amt = mode === "full" ? payment.refundable : Number(amount);
  const url = `/api/members/${memberId}/membership/refund`;
  const p = usePreview(url, { transactionId: payment.id, subscriptionId: m.subscriptionId, amount: amt > 0 ? amt : null, reason: reason || "—" }, amt > 0);
  return (
    <AppSheet open onClose={onClose} title="Refund a payment" description={`${first} · ${money2(payment.amount)} ${payment.method.toLowerCase()} on ${fmt(payment.at)}`}
      footer={<><button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={btnD} disabled={busy || p.loading || !!p.error || !reason.trim() || !(amt > 0)} onClick={() => commit(url, { transactionId: payment.id, subscriptionId: m.subscriptionId, amount: amt, reason }, setBusy, setErr, onDone)}>{busy ? "Refunding…" : `Refund ${money2(amt || 0)}`}</button></>}>
      <Label>How much</Label>
      <div className="flex gap-2">
        <button type="button" className={chip(mode === "full")} onClick={() => setMode("full")}>All that&apos;s left · {money2(payment.refundable)}</button>
        <button type="button" className={chip(mode === "part")} onClick={() => setMode("part")}>Part of it</button>
      </div>
      {mode === "part" && <input className={`${input} mt-2`} type="number" inputMode="decimal" min="0.01" max={payment.refundable} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Refund amount" />}
      <label className="block"><Label>Why (required)</Label><input className={input} placeholder="e.g. charged twice, missed two weeks" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <PreviewBox p={p} />
      <ErrLine err={err} />
    </AppSheet>
  );
}

export function AutoRenewSheet({ memberId, first, headline, m, onClose, onDone }: SheetProps) {
  const on = !m.autoRenew.on;
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const url = `/api/members/${memberId}/membership/auto-renew`;
  const p = usePreview(url, { subscriptionId: m.subscriptionId, autoRenew: on }, true);
  return (
    <AppSheet open onClose={onClose} title={on ? "Turn auto-renew on" : "Turn auto-renew off"} description={`${first} · ${headline}`}
      footer={<><button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={on ? btnP : btnD} disabled={busy || p.loading || !!p.error} onClick={() => commit(url, { subscriptionId: m.subscriptionId, autoRenew: on }, setBusy, setErr, onDone)}>{busy ? "Working…" : on ? "Turn on" : "Turn off"}</button></>}>
      <PreviewBox p={p} label={m.hasStripe ? "Stripe" : "Billing"} />
      <ErrLine err={err} />
    </AppSheet>
  );
}

/**
 * "Change charge date" — Stripe: move the next charge (the cycle renews on the
 * new day); cash/check: move the next due date. Every sentence comes from the
 * route's preview (lib/chargeDate.chargeDateMovePlan).
 */
export function ChargeDateSheet({ memberId, first, headline, m, onClose, onDone }: SheetProps) {
  const current = m.next.at ? m.next.at.slice(0, 10) : "";
  const [date, setDate] = useState(current);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const url = `/api/members/${memberId}/membership/charge-date`;
  const picked = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const changed = picked && date !== current;
  const p = usePreview(url, { subscriptionId: m.subscriptionId, newDate: date }, changed);
  const from = (p.facts.from as string | null | undefined) ?? null;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const title = m.hasStripe ? "Change charge date" : "Change payment due date";
  return (
    <AppSheet open onClose={onClose} title={title} description={`${first} · ${headline}`}
      footer={<><button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={btnP} disabled={busy || !changed || p.loading || !!p.error || !p.sentence} onClick={() => commit(url, { subscriptionId: m.subscriptionId, newDate: date, expectedFrom: from }, setBusy, setErr, onDone)}>{busy ? "Working…" : changed ? `Move to ${fmtS(date + "T00:00:00Z")}` : "Move"}</button></>}>
      <div className="mt-1 rounded-xl bg-app-bg px-3 py-2.5 text-sm text-text-primary">Now: {m.next.text}</div>
      <label className="block"><Label>{m.hasStripe ? "Charge on" : "Next payment due"}</Label><input className={input} type="date" min={tomorrow} value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {!changed ? (
        <p className="mt-3 text-[13px] text-text-muted">Pick a different day to see exactly what happens.</p>
      ) : (
        <PreviewBox p={p} label={m.hasStripe ? "Stripe" : "Billing"} />
      )}
      {m.hasStripe && <p className="mt-2 text-[12.5px] text-text-muted">Can&apos;t be earlier than what they&apos;ve already paid for — use Refund or Waive a payment for that.</p>}
      <ErrLine err={err} />
    </AppSheet>
  );
}

/** "Commitment not recorded — set dates": the existing set_dates action, one field. */
export function CommitSheet({ memberId, first, headline, m, onClose, onDone }: SheetProps) {
  const c = m.commitment;
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  if (c.state !== "MISSING") return null;
  const end = c.suggestedEnd.slice(0, 10);
  return (
    <AppSheet open onClose={onClose} title="Record the commitment" description={`${first} · ${headline}`}
      footer={<><button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={btnP} disabled={busy} onClick={() => commit(`/api/members/${memberId}/billing-admin/actions`, { action: "set_dates", subscriptionId: m.subscriptionId, dates: { minimumTermEndsAt: end } }, setBusy, setErr, onDone)}>{busy ? "Saving…" : "Save commitment"}</button></>}>
      <div className="mt-1 rounded-xl bg-app-bg px-3 py-2.5 text-sm text-text-primary">
        {c.months}-month commitment: <b>{fmtS(c.suggestedStart)} – {fmt(c.suggestedEnd)}</b>, from the start date and the option&apos;s term.
      </div>
      <div className="mt-2 rounded-xl border border-info-border bg-info-surface px-3 py-2 text-[13px] text-text-primary"><b>Billing:</b> nothing changes — no charge, no new end date. It records the commitment so the panel, cancel requests and auto-renew use it.</div>
      <p className="mt-2 text-[12.5px] text-text-muted">Different dates? Use <b>Change dates</b> in the membership actions.</p>
      <ErrLine err={err} />
    </AppSheet>
  );
}
