"use client";

// B13 — the Membership panel (design handoff screen 3a) and its slice-1
// dialogs: Assign (3b), Cancel (3g), Make it free (3h), plus the small
// confirms for Keep / Pause / Resume / Cancel setup.
//
// The panel renders what GET /api/members/[id]/membership-panel derived — it
// never composes a sentence of its own. Every dialog ends with a consequence
// line the server computed (or, for Assign, the one rule the handoff fixes:
// which route runs and what Stripe does), and money that moves today is
// behind a checkbox naming the amount.
//
// Slice 2 added Pause/Resume with real dates (Stripe pause_collection) and
// Change dates. Change plan (Stripe) still hands off to B12's dialog in
// Advanced billing; offline plan changes wait for slice 3.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import type { PanelView, PanelAction } from "@/lib/membershipPanel";

// ── Payload (mirrors the route) ──────────────────────────────────────────────

type Option = { planId: string; planName: string; id: string; label: string; price: number; billingPeriod: string; contractMonths: number | null; autoRenew: boolean };
type Consequence = { text: string; tone: "info" | "danger" };
type Payload = {
  view: PanelView;
  member: { id: string; firstName: string; lastName: string; isMinor: boolean; guardianEmail: string | null; email: string | null };
  club: { passProcessingFees: boolean; stripeReady: boolean };
  hasCard: boolean;
  cardLabel: string | null;
  requestedPaymentMethod: string | null;
  draft: { planId: string; planName: string; optionId: string | null; optionLabel: string | null; price: number | null; period: string | null; offerSentAt: string | null } | null;
  options: Option[];
  cancel: { periodEnd: string | null; atPeriodEndAvailable: boolean; periodEndAccessUntil: string; nowAccessUntil: string; consequencePeriodEnd: Consequence; consequenceNow: Consequence } | null;
  current: {
    id: string; hasStripe: boolean; price: number; optionLabel: string; planName: string | null; billingPeriod: string | null; deliberateFree: boolean;
    startDate: string | null; endDate: string | null; paidThroughDate: string | null; currentPeriodEnd: string | null; minimumTermEndsAt: string | null;
    pausedAt: string | null; pausedUntil: string | null;
    editable: { startDate: boolean; paidThroughDate: boolean; endDate: boolean; minimumTermEndsAt: boolean };
  } | null;
  history: { id: string; label: string; price: number; billingPeriod: string | null; status: string; startDate: string | null; endDate: string | null; hasStripe: boolean }[];
  // B3 slice 2 — the sibling membership discount for this athlete's family.
  sibling?: {
    summary: string;
    groups: { id: string; label: string; options: string[]; value: string }[];
    family: { memberId: string; name: string; position: number | null; price: number; expected: number | null }[];
    current: { subId: string; optionId: string | null; drift: "DOWN" | "UP" | null; label: string | null; source: "SIBLING" | "GROUP" | null; price: number; expected: number | null } | null;
  } | null;
};

const LABELS: Record<PanelAction, string> = {
  change_plan: "Change plan", change_dates: "Change dates", pause: "Pause", resume: "Resume", cancel: "Cancel", keep: "Keep membership",
  record_payment: "Record payment", activate: "Activate now", send_offer: "Send offer", edit_setup: "Edit setup", cancel_setup: "Cancel setup",
  assign: "Assign membership", sync_stripe: "Sync from Stripe", transfer: "Transfer to another athlete", comp: "Make it free", retry_payment: "Retry payment",
};
const PILL: Record<PanelView["pill"]["tone"], string> = {
  ok: "bg-lime-accent/25 text-[#3F6212]", warn: "bg-[var(--color-warn-surface)] text-[var(--color-warn-text)]",
  pend: "bg-[#EDEBFF] text-[#4F46E5]", bad: "bg-red-50 text-red-700", none: "bg-app-bg text-text-muted",
};
const fmt = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
const fmtS = (s: string | Date | null | undefined) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const PERIOD_WORD: Record<string, string> = { WEEKLY: "weekly", MONTHLY: "monthly", QUARTERLY: "every 3 months", QUADRIMESTRAL: "every 4 months", SEMI_ANNUAL: "every 6 months", ANNUAL: "yearly" };
const PERIOD_MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, QUADRIMESTRAL: 4, SEMI_ANNUAL: 6, ANNUAL: 12 };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const todayISO = () => iso(new Date());
function addMonthsUTC(start: Date, n: number): Date {
  const d = new Date(start.getTime()); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, dim)); return d;
}
function addPeriodUTC(start: Date, period: string): Date {
  if (period === "WEEKLY") { const d = new Date(start.getTime()); d.setUTCDate(d.getUTCDate() + 7); return d; }
  return addMonthsUTC(start, PERIOD_MONTHS[period] ?? 1);
}
const feeOf = (p: number) => Math.round(p * 100 * 0.029) / 100;

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
async function patch(url: string, body: unknown) {
  const r = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

// ── Shell pieces ─────────────────────────────────────────────────────────────

function Sheet({ title, sub, children, onClose }: { title: string; sub?: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 pt-4 pb-2.5 border-b border-[#F1F1F3]">
          <h3 className="text-[15px] font-semibold text-text-primary">{title}</h3>
          {sub && <p className="text-[11px] text-text-muted mt-0.5">{sub}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
function ConseqLine({ text, tone = "info" }: { text: string; tone?: "info" | "warn" | "danger" }) {
  const cls = tone === "danger" ? "bg-red-50 border-red-200 text-red-700" : tone === "warn" ? "bg-[var(--color-warn-surface)] border-[rgba(180,83,9,.22)] text-[var(--color-warn-text)]" : "bg-brand/5 border-brand/25 text-text-primary";
  return <div className={`mt-2.5 border rounded-xl px-3 py-2 text-[12.5px] leading-[1.45] ${cls}`}><b className={tone === "info" ? "text-brand-hover" : ""}>Stripe:</b> <span dangerouslySetInnerHTML={{ __html: text }} /></div>;
}
function Foot({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 justify-end px-4 py-3 border-t border-app-border">{children}</div>;
}
const btn = "min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-app-border bg-surface text-sm text-text-primary hover:bg-app-bg disabled:opacity-50";
const btnP = "min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50";
const input = "w-full min-h-[44px] sm:min-h-0 px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary";
const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="block mt-3"><span className="block text-xs font-medium text-text-primary mb-1">{label}</span>{children}{hint && <span className="block text-[11px] text-text-muted mt-1">{hint}</span>}</label>
);
const Ack = ({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) => (
  <label className="flex items-start gap-2 text-sm text-text-primary mt-3"><input type="checkbox" className="mt-0.5 w-[18px] h-[18px]" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span>{children}</span></label>
);

// ── The panel ────────────────────────────────────────────────────────────────

export default function MembershipPanel({
  memberId, canBill, onChanged, onEditSub, onTransfer, openAssign, onOpenAssignHandled,
}: {
  memberId: string;
  canBill: boolean;
  /** Reload the profile after anything changed. */
  onChanged: () => void;
  /** Slice 1: Change dates still uses the profile's edit modal. */
  onEditSub: (subId: string) => void;
  onTransfer?: (subId: string) => void;
  /** Open the Assign dialog from outside (roster menu / ?assign=1). */
  openAssign?: boolean;
  onOpenAssignHandled?: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<null | "assign" | "cancel" | "comp" | "keep" | "pause" | "resume" | "dates" | "cancel_setup" | "sync">(null);
  const [assignMode, setAssignMode] = useState<"CARD" | "CASH" | "OFFER" | null>(null);
  const [menu, setMenu] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/members/${memberId}/membership-panel`);
    if (r.ok) setData(await r.json());
    setLoading(false);
  }, [memberId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (openAssign && data) { setAssignMode(null); setDialog("assign"); onOpenAssignHandled?.(); } }, [openAssign, data, onOpenAssignHandled]);

  const done = (m: string) => { setDialog(null); setMsg(m); load(); onChanged(); };

  const run = async (action: PanelAction) => {
    if (!data) return;
    const v = data.view;
    switch (action) {
      case "assign": setAssignMode(null); setDialog("assign"); return;
      case "activate": setAssignMode(data.requestedPaymentMethod === "CASH" || data.requestedPaymentMethod === "CHECK" ? "CASH" : "CARD"); setDialog("assign"); return;
      case "send_offer": setAssignMode("OFFER"); setDialog("assign"); return;
      case "edit_setup": router.push(`/dashboard/members/${memberId}/billing`); return;
      case "cancel_setup": setDialog("cancel_setup"); return;
      case "cancel": setDialog("cancel"); return;
      case "keep": setDialog("keep"); return;
      case "comp": setMenu(false); setDialog("comp"); return;
      case "pause": setDialog("pause"); return;
      case "resume": setDialog("resume"); return;
      case "record_payment": router.push(`/dashboard/members/${memberId}/billing?enrol=1`); return;
      case "change_plan":
        // B13 slice 3 — one Change plan dialog for Stripe and offline rows.
        if (v.currentSubId) router.push(`/dashboard/members/${memberId}/billing?changePlan=${v.currentSubId}`);
        return;
      case "change_dates": setDialog("dates"); return;
      case "transfer": setMenu(false); if (v.currentSubId) onTransfer?.(v.currentSubId); return;
      case "retry_payment": router.push(`/dashboard/members/${memberId}/billing`); return;
      case "sync_stripe": {
        setMenu(false); setBusy("sync");
        const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "sync_stripe", confirm: true, subscriptionId: v.currentSubId });
        setBusy(null); done(r.d.message ?? r.d.error ?? (r.ok ? "Synced." : "Sync failed."));
        return;
      }
    }
  };

  if (loading || !data) {
    return <div className="bg-surface border border-app-border rounded-xl p-5 lg:col-span-2"><div className="h-5 w-40 bg-app-bg rounded animate-pulse" /><div className="h-4 w-72 bg-app-bg rounded animate-pulse mt-2" /><div className="h-10 w-full bg-app-bg rounded-lg animate-pulse mt-4" /></div>;
  }
  const v = data.view;
  const first = data.member.firstName;

  return (
    <div className="bg-surface border border-app-border rounded-xl p-4 sm:p-5 lg:col-span-2 relative">
      {msg && (
        <div className="mb-3 text-xs rounded-lg px-3 py-2 bg-brand/5 border border-brand/25 text-text-primary flex justify-between gap-3">
          <span>{msg}</span><button className="text-text-muted" onClick={() => setMsg(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text-primary leading-tight">{v.headline}</h2>
          <p className="text-[13px] text-[#4B5563] mt-1">
            {v.moneyLine}
            {v.committedThrough && <span className="text-text-muted"> · committed through {fmt(String(v.committedThrough))}</span>}
          </p>
          {v.upcoming && <p className="text-xs text-text-muted mt-0.5">Then: {v.upcoming.label} from {fmt(String(v.upcoming.from))}.</p>}
        </div>
        <span className={`shrink-0 inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full ${PILL[v.pill.tone]}`}>{v.pill.label}</span>
      </div>

      {v.facts && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
          {[["Pays with", v.facts.paysWith], ["Started", fmt(v.facts.started ? String(v.facts.started) : null)], ["Renews", v.facts.renews], ["Payer", v.facts.payer ?? "—"]].map(([k, val]) => (
            <div key={k} className="bg-[#F4F4F6] rounded-lg px-2.5 py-2"><div className="text-[10.5px] uppercase tracking-wide font-semibold text-[#9CA3AF]">{k}</div><div className="text-[13px] font-medium text-text-primary mt-0.5 truncate">{val}</div></div>
          ))}
        </div>
      )}

      {data.sibling?.current?.drift && data.sibling.current.expected != null && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          {data.sibling.current.drift === "DOWN" ? (
            <>
              <strong>{data.sibling.current.source === "GROUP" ? "Group rate recommended." : "Sibling discount recommended."}</strong> {data.sibling.current.label}: {money(data.sibling.current.price)} → {money(data.sibling.current.expected)}.
              {" "}Nothing changes until you apply it — it starts on the next payment.
            </>
          ) : (
            <>
              <strong>Discount no longer earned.</strong> The family or group has fewer paying athletes now, so the price would be {money(data.sibling.current.expected)} (today {money(data.sibling.current.price)}). Nothing changes on its own.
            </>
          )}
          {canBill && data.sibling.current.optionId && (
            <button
              className="block mt-1.5 text-brand font-medium hover:underline"
              onClick={() => router.push(`/dashboard/members/${memberId}/billing?changePlan=${data.sibling!.current!.subId}&option=${data.sibling!.current!.optionId}`)}
            >
              Review in Change plan →
            </button>
          )}
        </div>
      )}
      {data.sibling && data.sibling.groups.length > 0 && (
        <GroupAnswers memberId={memberId} groups={data.sibling.groups} canEdit={canBill} onSaved={() => { load(); onChanged(); }} />
      )}
      {data.sibling && data.sibling.family.length > 1 && (
        <p className="text-xs text-text-muted mt-2">
          Family: {data.sibling.family.map((f) => `${f.name.split(" ")[0]} (${f.position === 1 ? "full price" : `${f.position === 2 ? "2nd" : f.position === 3 ? "3rd" : `${f.position}th`}`})`).join(", ")}
        </p>
      )}

      {canBill && (
        <div className="flex flex-wrap gap-2 mt-3">
          <button className={`${btnP} !min-h-[40px] text-[13px]`} onClick={() => run(v.actions.primary)} disabled={busy !== null}>{LABELS[v.actions.primary]}</button>
          {v.actions.others.map((a) => (
            <button key={a} className={`${btn} !min-h-[40px] text-[13px] ${a === "cancel" || a === "cancel_setup" ? "text-red-700" : ""}`} onClick={() => run(a)} disabled={busy !== null}>{LABELS[a]}</button>
          ))}
          {v.actions.more.length > 0 && (
            <div className="relative">
              <button className={`${btn} !min-h-[40px] px-2.5`} aria-label="More" onClick={() => setMenu((m) => !m)}><MoreHorizontal size={16} /></button>
              {menu && (
                <div className="absolute left-0 top-full mt-1 z-20 bg-surface border border-app-border rounded-xl shadow-lg p-1.5 min-w-[220px]" onMouseLeave={() => setMenu(false)}>
                  {v.actions.more.map((a) => <button key={a} className="block w-full text-left text-sm px-2.5 py-2.5 rounded-lg hover:bg-app-bg text-text-primary whitespace-nowrap" onClick={() => run(a)}>{busy === "sync" && a === "sync_stripe" ? "Syncing…" : LABELS[a]}</button>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-[#F1F1F3]">
        <Link href={`/dashboard/members/${memberId}/billing`} className="text-xs text-brand hover:underline font-medium">Advanced billing →</Link>
        {data.history.length > 0 && <button className="text-xs text-text-muted hover:text-text-primary" onClick={() => setShowHistory((s) => !s)}>Membership history ({data.history.length})</button>}
      </div>
      {showHistory && (
        <div className="mt-2 space-y-1.5">
          {data.history.map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-3 text-xs border border-app-border rounded-lg px-2.5 py-2">
              <div className="min-w-0"><span className="font-medium text-text-primary">{h.label}</span><span className="text-text-muted"> · {h.price <= 0 ? "Free" : `${money(h.price)} ${PERIOD_WORD[h.billingPeriod ?? ""] ?? ""}`} · {h.status}{h.hasStripe ? " · Stripe" : ""}</span><div className="text-text-muted">{fmt(h.startDate)} → {h.endDate ? fmt(h.endDate) : "open-ended"}</div></div>
              {canBill && <button className="text-brand hover:underline shrink-0" onClick={() => onEditSub(h.id)}>Edit</button>}
            </div>
          ))}
        </div>
      )}

      {dialog === "assign" && <AssignDialog data={data} initialMode={assignMode} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "cancel" && data.cancel && data.current && <CancelDialog data={data} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "comp" && data.current && <CompDialog data={data} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "keep" && data.current && (
        <ConfirmDialog title="Keep the membership" sub={`${first} · ${v.headline}`}
          body={<p className="text-sm text-text-primary">The scheduled cancel is removed — {first}&apos;s membership keeps renewing{data.current.currentPeriodEnd ? `, next charge ${fmtS(data.current.currentPeriodEnd)}` : ""}.</p>}
          conseq={data.current.hasStripe ? { text: "cancel date removed — renews until cancelled.", tone: "info" } : { text: "nothing — billed offline. The end date is cleared.", tone: "info" }}
          cta="Keep membership" onClose={() => setDialog(null)}
          onConfirm={async () => { const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "keep_membership", confirm: true, subscriptionId: data.current!.id }); if (!r.ok) throw new Error(r.d.error ?? "Failed"); return r.d.message; }}
          onDone={done} />
      )}
      {dialog === "pause" && data.current && <PauseDialog data={data} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "resume" && data.current && (
        <ConfirmDialog title="Resume membership" sub={`${first} · ${v.headline}`}
          body={<p className="text-sm text-text-primary">{first} is active again from today{data.current.pausedAt && !data.current.hasStripe && data.current.paidThroughDate ? ` — the ${Math.max(0, Math.round((Date.now() - new Date(data.current.pausedAt).getTime()) / 86400000))} paused days are added back to the paid-through date` : ""}.</p>}
          conseq={data.current.hasStripe && data.current.pausedAt ? { text: "collection resumes now — the next invoice is charged on the normal cycle date.", tone: "info" } : { text: "nothing — billed offline.", tone: "info" }}
          cta="Resume" onClose={() => setDialog(null)}
          onConfirm={async () => { const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "resume_membership", confirm: true, subscriptionId: data.current!.id }); if (!r.ok) throw new Error(r.d.error ?? "Failed"); return r.d.message ?? `${first} is active.`; }}
          onDone={done} />
      )}
      {dialog === "dates" && data.current && <DatesDialog data={data} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "cancel_setup" && (
        <ConfirmDialog title="Cancel the setup" sub={`${first} · ${v.headline}`}
          body={<p className="text-sm text-text-primary">The saved setup and any open offer link stop working. {first} goes back to having no membership. The saved card, if any, stays on file.</p>}
          conseq={{ text: "nothing — no subscription was created.", tone: "info" }}
          cta="Cancel setup" danger onClose={() => setDialog(null)}
          onConfirm={async () => { const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "cancel_pending_activation", confirm: true }); if (!r.ok) throw new Error(r.d.error ?? "Failed"); return r.d.message ?? "Setup cancelled."; }}
          onDone={done} />
      )}
    </div>
  );
}

// ── Generic one-question confirm ─────────────────────────────────────────────

function ConfirmDialog({ title, sub, body, conseq, cta, danger, onClose, onConfirm, onDone }: {
  title: string; sub?: string; body: React.ReactNode; conseq: { text: string; tone: "info" | "warn" | "danger" }; cta: string; danger?: boolean;
  onClose: () => void; onConfirm: () => Promise<string>; onDone: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  return (
    <Sheet title={title} sub={sub} onClose={onClose}>
      <div className="px-4 py-3">
        {err && <p className="text-xs text-white bg-red-600 rounded-lg px-2.5 py-2 mb-2">{err}</p>}
        <div className="bg-app-bg rounded-xl px-3 py-2.5">{body}</div>
        <ConseqLine text={conseq.text} tone={conseq.tone} />
      </div>
      <Foot>
        <button className={btn} onClick={onClose} disabled={busy}>Back</button>
        <button className={danger ? `${btnP} !bg-red-700 hover:!bg-red-800` : btnP} disabled={busy} onClick={async () => { setBusy(true); setErr(""); try { onDone(await onConfirm()); } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); setBusy(false); } }}>{busy ? "Working…" : cta}</button>
      </Foot>
    </Sheet>
  );
}

// ── 3b Assign ────────────────────────────────────────────────────────────────

function AssignDialog({ data, initialMode, onClose, onDone }: { data: Payload; initialMode: "CARD" | "CASH" | "OFFER" | null; onClose: () => void; onDone: (msg: string) => void }) {
  const first = data.member.firstName;
  const memberId = data.member.id;
  const defaultOpt = data.draft?.optionId ?? (data.view.lastMembership ? data.options.find((o) => data.view.lastMembership!.label.includes(o.label))?.id : undefined) ?? data.options[0]?.id ?? "";
  const [optId, setOptId] = useState(defaultOpt);
  const [override, setOverride] = useState<string>(data.draft?.price != null && data.options.find((o) => o.id === defaultOpt)?.price !== data.draft.price ? String(data.draft.price) : "");
  const [showOverride, setShowOverride] = useState(override !== "");
  const [start, setStart] = useState(todayISO());
  const [pay, setPay] = useState<"CARD" | "CASH" | "OFFER">(initialMode ?? (data.hasCard ? "CARD" : data.requestedPaymentMethod === "CASH" || data.requestedPaymentMethod === "CHECK" ? "CASH" : "OFFER"));
  const [firstCharge, setFirstCharge] = useState<"today" | "date">("today");
  const [firstDate, setFirstDate] = useState(iso(addMonthsUTC(new Date(), 1)));
  const [ack, setAck] = useState(false);
  const [method, setMethod] = useState<"CASH" | "CHECK">(data.requestedPaymentMethod === "CHECK" ? "CHECK" : "CASH");
  const [amount, setAmount] = useState("");
  const [through, setThrough] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");

  const o = data.options.find((x) => x.id === optId) ?? null;
  const price = override !== "" ? Number(override) || 0 : o?.price ?? 0;
  const isComp = price === 0;
  const startD = new Date(start + "T00:00:00Z");
  const commit = o?.contractMonths ? addMonthsUTC(startD, o.contractMonths) : null;
  const end = o && !o.autoRenew ? (commit ?? addPeriodUTC(startD, o.billingPeriod)) : null;
  const throughD = through ? new Date(through + "T00:00:00Z") : o ? addPeriodUTC(startD, o.billingPeriod) : startD;
  const amt = amount !== "" ? Number(amount) || 0 : price;
  const total = data.club.passProcessingFees ? price + feeOf(price) : price;
  const chargesToday = pay === "CARD" && firstCharge === "today";
  const cardBlocked = !data.hasCard ? "No card on file — send the offer, or collect a card in Advanced billing." : !data.club.stripeReady ? "Online payments aren't connected for this club." : null;

  let conseq: { text: string; tone: "info" | "warn" }; let cta: string;
  if (!o) { conseq = { text: "pick an option first.", tone: "info" }; cta = "Assign"; }
  else if (isComp) { conseq = { text: "nothing — a $0 membership is recorded and marked as a comp on purpose.", tone: "info" }; cta = "Make it free"; }
  else if (pay === "CARD") {
    if (cardBlocked) { conseq = { text: "nothing yet — " + cardBlocked.toLowerCase(), tone: "info" }; cta = "Assign"; }
    else if (chargesToday) { conseq = { text: `creates a subscription on ${data.cardLabel ?? "the saved card"} — <b>${money2(total)} charged today</b>, then ${PERIOD_WORD[o.billingPeriod]}.${end ? ` Ends ${fmtS(end)}.` : " Renews until cancelled."}`, tone: "warn" }; cta = `Charge ${money2(total)} & assign`; }
    else { conseq = { text: `creates a subscription on ${data.cardLabel ?? "the saved card"} — nothing today; first charge ${money2(total)} on ${fmtS(new Date(firstDate + "T00:00:00Z"))}, then ${PERIOD_WORD[o.billingPeriod]}.${end ? ` Ends ${fmtS(end)}.` : ""}`, tone: "info" }; cta = "Assign"; }
  } else if (pay === "CASH") { conseq = { text: `nothing — recorded as a ${method.toLowerCase()} membership, ${money(amt)} received, paid through ${fmtS(throughD)}.`, tone: "info" }; cta = `Record ${money(amt)} & assign`; }
  else { conseq = { text: "nothing until the family confirms and pays from the link.", tone: "info" }; cta = "Send offer"; }

  const disabled = busy || !o || (pay === "CARD" && !isComp && (!!cardBlocked || (chargesToday && !ack)));

  async function submit() {
    if (!o) return;
    setBusy(true); setErr("");
    try {
      // 1. The setup the routes read, written in the same breath.
      const draft = await patch(`/api/members/${memberId}/billing-admin`, {
        membershipId: o.planId, selectedOptionLabel: o.label,
        priceOverride: override !== "" ? Number(override) : null,
        membershipStartDate: start,
        billingAnchorDate: pay === "CARD" && firstCharge === "date" ? firstDate : null,
        migrationFinalBillingDate: null,
        commitmentEndDate: end ? iso(end) : commit ? iso(commit) : null,
        paymentMethodPreference: pay === "CARD" ? "CARD" : pay === "CASH" ? method : "LATER",
        ...(isComp ? { markFree: true } : {}),
      });
      if (!draft.ok) throw new Error(draft.d.error ?? "Couldn't save the setup.");
      // 2. The path.
      if (isComp || pay === "CASH") {
        const r = await post(`/api/members/${memberId}/enroll-paid`, {
          confirm: true, membershipId: o.planId, optionId: o.id, amountReceived: isComp ? 0 : amt, method, coversUntil: iso(isComp ? (end ?? addMonthsUTC(startD, 12)) : throughD),
          note: note || null, allowAmountMismatch: true,
        });
        if (!r.ok) throw new Error(r.d.error ?? "Couldn't record the membership.");
        if (isComp) await post(`/api/members/${memberId}/billing-admin/actions`, { action: "comp_membership", confirm: true, subscriptionId: r.d.subscriptionId ?? r.d.subscription?.id });
        onDone(isComp ? `${first} is on "${o.label}" — free, comped on purpose.` : r.d.message ?? `${first} is on "${o.label}" — ${money(amt)} ${method.toLowerCase()} recorded, paid through ${fmtS(throughD)}.`);
      } else if (pay === "CARD") {
        const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "activate_card", confirm: true, confirmImmediateCharge: chargesToday && ack });
        if (!r.ok) throw new Error(r.d.error ?? "Couldn't start the subscription.");
        onDone(r.d.message ?? `${first} is on "${o.label}".`);
      } else {
        const r = await post(`/api/members/${memberId}/reactivation`, { firstChargeDate: null, personalNote: note || null, acknowledgeImmediateCharge: true });
        if (!r.ok) throw new Error(r.d.error ?? "Couldn't create the offer.");
        const s = await post(`/api/members/${memberId}/reactivation/send`, {});
        if (!s.ok) throw new Error(s.d.error ?? "Offer created but not sent — send it from Advanced billing.");
        onDone(`Offer sent${s.d.sentTo ? ` to ${s.d.sentTo}` : ""} — ${first} is on "${o.label}" once the family confirms.`);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); setBusy(false); }
  }

  return (
    <Sheet title="Assign a membership" sub={`${first} ${data.member.lastName} · ${data.view.state === "NONE" ? "no active membership" : data.view.headline}`} onClose={onClose}>
      <div className="px-4 py-3">
        {err && <p className="text-xs text-white bg-red-600 rounded-lg px-2.5 py-2 mb-2">{err}</p>}
        <div className="border border-app-border rounded-xl p-3">
          <Field label="Plan & option">
            <select className={input} value={optId} onChange={(e) => { setOptId(e.target.value); setThrough(""); }}>
              {data.options.length === 0 && <option value="">No sellable options — add one in Memberships</option>}
              {data.options.map((x) => <option key={x.id} value={x.id}>{x.planName} · {x.label} — {money(x.price)} {PERIOD_WORD[x.billingPeriod] ?? x.billingPeriod.toLowerCase()}{x.contractMonths ? `, ${x.contractMonths}-mo` : ""}</option>)}
            </select>
          </Field>
          {o && <p className="text-[11px] text-text-muted mt-1">{isComp ? <b className="text-text-primary">$0 — this becomes a comp.</b> : `${money(price)} ${PERIOD_WORD[o.billingPeriod]}${o.contractMonths ? ` · ${o.contractMonths}-month commitment` : ""} · then ${o.autoRenew ? `renews ${PERIOD_WORD[o.billingPeriod]}` : "ends"}`}</p>}
          {showOverride ? (
            <Field label="Different price" hint="Leave empty for the option price. $0 makes it a comp."><input className={input} type="number" min="0" step="0.01" placeholder={o ? String(o.price) : ""} value={override} onChange={(e) => setOverride(e.target.value)} /></Field>
          ) : (
            <button className={`${btn} !min-h-[36px] text-xs mt-2`} onClick={() => setShowOverride(true)}>Different price?</button>
          )}
        </div>
        <div className="border border-app-border rounded-xl p-3 mt-2.5">
          <Field label="Starts"><input className={input} type="date" value={start} onChange={(e) => { setStart(e.target.value); setThrough(""); }} /></Field>
          {o && <p className="text-[11px] text-text-muted mt-1">{commit ? `Committed through ${fmt(iso(commit))}${end ? " · ends there" : " · renews after"}` : end ? `Ends ${fmt(iso(end))} unless renewed` : "Renews until cancelled"}</p>}
        </div>
        {!isComp && (
          <div className="border border-app-border rounded-xl p-3 mt-2.5">
            <span className="block text-xs font-medium text-text-primary mb-1.5">How they pay</span>
            <div className="space-y-1.5">
              {([
                ["CARD", `Saved card${data.cardLabel ? ` · ${data.cardLabel}` : ""}`, cardBlocked ?? "A Stripe subscription on the card on file.", !!cardBlocked],
                ["CASH", "Cash / check", "Record what was received; renews when they pay again.", false],
                ["OFFER", "Send the offer to the family", "They confirm and pay from the link — card or cash.", false],
              ] as const).map(([k, t, s, dis]) => (
                <button key={k} type="button" disabled={dis} onClick={() => { setPay(k); setAck(false); }}
                  className={`w-full text-left min-h-[44px] px-3 py-2 rounded-xl border ${pay === k ? "border-brand bg-brand/5" : "border-app-border"} disabled:bg-[#F4F4F6] disabled:cursor-not-allowed`}>
                  <span className={`block text-sm font-semibold ${pay === k ? "text-brand-hover" : dis ? "text-[#9CA3AF]" : "text-text-primary"}`}>{t}</span>
                  <span className={`block text-[11.5px] ${pay === k ? "text-brand-hover" : "text-text-muted"}`}>{s}</span>
                </button>
              ))}
            </div>
            {pay === "CARD" && !cardBlocked && (
              <div className="mt-2.5">
                <div className="inline-flex bg-[#F1F1F3] rounded-lg p-0.5 gap-0.5">
                  {(["today", "date"] as const).map((k) => <button key={k} type="button" onClick={() => { setFirstCharge(k); setAck(false); }} className={`min-h-[32px] px-2.5 rounded-md text-xs font-medium ${firstCharge === k ? "bg-surface text-text-primary shadow-sm" : "text-[#4B5563]"}`}>{k === "today" ? "First charge today" : "On a date"}</button>)}
                </div>
                {firstCharge === "date" && <input className={`${input} mt-2`} type="date" value={firstDate} min={todayISO()} onChange={(e) => setFirstDate(e.target.value)} />}
              </div>
            )}
            {pay === "CASH" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Amount received"><input className={input} type="number" min="0" step="0.01" placeholder={String(price)} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
                  <Field label="Method"><select className={input} value={method} onChange={(e) => setMethod(e.target.value as "CASH" | "CHECK")}><option>CASH</option><option>CHECK</option></select></Field>
                </div>
                <Field label="Paid through" hint={o ? `One ${PERIOD_WORD[o.billingPeriod].replace("every ", "")} from the start. Edit if they paid for more.` : undefined}><input className={input} type="date" value={iso(throughD)} onChange={(e) => setThrough(e.target.value)} /></Field>
                <Field label="Note"><input className={input} placeholder="Optional — e.g. check #1042" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              </>
            )}
            {pay === "OFFER" && (
              <>
                <Field label="To"><input className={input} value={data.member.isMinor ? data.member.guardianEmail ?? data.member.email ?? "" : data.member.email ?? data.member.guardianEmail ?? ""} readOnly /></Field>
                <Field label="Note to the family"><input className={input} placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              </>
            )}
          </div>
        )}
        {o && (
          <div className="bg-app-bg rounded-xl px-3 py-2.5 text-sm mt-2.5">
            <p><b>{first}</b> goes on <b>{o.planName} · {o.label}</b>{override !== "" ? ` at ${money(price)}` : ""} from {fmt(start)}.</p>
            <p className="text-text-muted mt-0.5">{isComp ? "Free — comped on purpose." : pay === "CASH" ? `${money(amt)} ${method.toLowerCase()} received · paid through ${fmt(iso(throughD))}` : pay === "OFFER" ? "Nothing charged until they confirm." : chargesToday ? `${money2(total)} on the card today` : `First charge ${fmt(firstDate)}`}</p>
          </div>
        )}
        <ConseqLine text={conseq.text} tone={conseq.tone} />
        {chargesToday && !isComp && !cardBlocked && <Ack checked={ack} onChange={setAck}>I understand the saved card is charged <b>{money2(total)} right now</b>.</Ack>}
      </div>
      <Foot><button className={btn} onClick={onClose} disabled={busy}>Cancel</button><button className={btnP} disabled={disabled} onClick={submit}>{busy ? "Working…" : cta}</button></Foot>
    </Sheet>
  );
}

// ── 3g Cancel ────────────────────────────────────────────────────────────────

function CancelDialog({ data, onClose, onDone }: { data: Payload; onClose: () => void; onDone: (msg: string) => void }) {
  const c = data.cancel!; const cur = data.current!; const first = data.member.firstName; const memberId = data.member.id;
  const [when, setWhen] = useState<"period_end" | "now">(c.atPeriodEndAvailable ? "period_end" : "now");
  const [reason, setReason] = useState<string | null>(null);
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const now = when === "now";
  const until = now ? c.nowAccessUntil : c.periodEndAccessUntil;
  const cq = now ? c.consequenceNow : c.consequencePeriodEnd;
  async function submit() {
    setBusy(true); setErr("");
    try {
      if (now) {
        const r = await fetch(`/api/members/subscriptions/${cur.id}`, { method: "DELETE" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Couldn't cancel.");
        onDone(`${first}'s membership is cancelled.`);
      } else {
        const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "cancel_at_period_end", confirm: true, subscriptionId: cur.id, cancelReason: reason });
        if (!r.ok) throw new Error(r.d.error ?? "Couldn't schedule the cancel.");
        onDone(r.d.message ?? "Cancel scheduled.");
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); setBusy(false); }
  }
  return (
    <Sheet title="Cancel membership" sub={`${first} · ${data.view.headline}`} onClose={onClose}>
      <div className="px-4 py-3">
        {err && <p className="text-xs text-white bg-red-600 rounded-lg px-2.5 py-2 mb-2">{err}</p>}
        <span className="block text-xs font-medium text-text-primary mb-1.5">When</span>
        <div className="space-y-1.5">
          <button type="button" disabled={!c.atPeriodEndAvailable} onClick={() => { setWhen("period_end"); setAck(false); }} className={`w-full text-left min-h-[44px] px-3 py-2 rounded-xl border ${!now ? "border-brand bg-brand/5" : "border-app-border"} disabled:bg-[#F4F4F6] disabled:cursor-not-allowed`}>
            <span className={`block text-sm font-semibold ${!now ? "text-brand-hover" : "text-text-primary"}`}>At the end of the paid period{c.periodEnd ? ` · ${fmtS(c.periodEnd)}` : ""}</span>
            <span className={`block text-[11.5px] ${!now ? "text-brand-hover" : "text-text-muted"}`}>{c.atPeriodEndAvailable ? `${first} keeps access until then. The usual choice.` : "Nothing is paid ahead — only \"right now\" applies."}</span>
          </button>
          <button type="button" onClick={() => { setWhen("now"); setAck(false); }} className={`w-full text-left min-h-[44px] px-3 py-2 rounded-xl border ${now ? "border-brand bg-brand/5" : "border-app-border"}`}>
            <span className={`block text-sm font-semibold ${now ? "text-brand-hover" : "text-text-primary"}`}>Right now</span>
            <span className={`block text-[11.5px] ${now ? "text-brand-hover" : "text-text-muted"}`}>Access ends today. Nothing already paid is refunded from here.</span>
          </button>
        </div>
        <span className="block text-xs font-medium text-text-primary mt-3 mb-1.5">Reason <span className="text-text-muted font-normal">(optional — shows in Reports)</span></span>
        <div className="flex flex-wrap gap-1.5">
          {["Moving", "Cost", "Injury", "Season over", "Other"].map((r) => <button key={r} type="button" onClick={() => setReason(reason === r ? null : r)} className={`min-h-[36px] px-3 rounded-full border text-xs ${reason === r ? "border-brand bg-brand/5 text-brand-hover font-semibold" : "border-app-border text-text-primary"}`}>{r}</button>)}
        </div>
        <div className="bg-app-bg rounded-xl px-3 py-2.5 text-sm mt-3">
          <p><b>{first}</b> keeps access until <b>{fmt(until)}</b>.</p>
          <p className="text-text-muted mt-0.5">{now ? "This can't be undone from here — assign a new membership to bring them back." : "You can undo this before that date with Keep membership."}</p>
        </div>
        <ConseqLine text={cq.text} tone={cq.tone} />
        <Ack checked={ack} onChange={setAck}>Cancel {first}&apos;s membership{now ? <b> now</b> : ` on ${fmtS(until)}`}.</Ack>
      </div>
      <Foot><button className={btn} onClick={onClose} disabled={busy}>Keep it</button><button className={`${btnP} !bg-red-700 hover:!bg-red-800`} disabled={busy || !ack} onClick={submit}>{busy ? "Working…" : "Cancel membership"}</button></Foot>
    </Sheet>
  );
}

// ── 3f Pause ─────────────────────────────────────────────────────────────────

function PauseDialog({ data, onClose, onDone }: { data: Payload; onClose: () => void; onDone: (msg: string) => void }) {
  const cur = data.current!; const first = data.member.firstName; const memberId = data.member.id;
  const [mode, setMode] = useState<"date" | "open">("date");
  const [until, setUntil] = useState(iso(addMonthsUTC(new Date(), 1)));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const untilD = mode === "date" && until ? new Date(until + "T00:00:00Z") : null;
  const days = untilD ? Math.max(0, Math.round((untilD.getTime() - Date.now()) / 86400000)) : null;
  const conseq = cur.hasStripe
    ? untilD ? `collection paused — invoices are voided until ${fmtS(untilD)}, then billing resumes automatically.` : "collection paused — invoices are voided until you resume. No charges while paused."
    : `nothing. When you resume, paid-through moves out by the paused days${days ? ` (${days})` : ""}.`;
  return (
    <Sheet title="Pause membership" sub={`${first} · ${data.view.headline}`} onClose={onClose}>
      <div className="px-4 py-3">
        {err && <p className="text-xs text-white bg-red-600 rounded-lg px-2.5 py-2 mb-2">{err}</p>}
        <span className="block text-xs font-medium text-text-primary mb-1.5">Until</span>
        <div className="flex gap-1.5">
          {([["date", "A date"], ["open", "Until I resume it"]] as const).map(([k, l]) => <button key={k} type="button" onClick={() => setMode(k)} className={`min-h-[36px] px-3 rounded-full border text-xs ${mode === k ? "border-brand bg-brand/5 text-brand-hover font-semibold" : "border-app-border text-text-primary"}`}>{l}</button>)}
        </div>
        {mode === "date" && <input className={`${input} mt-2`} type="date" value={until} min={iso(new Date(Date.now() + 86400000))} onChange={(e) => setUntil(e.target.value)} />}
        <div className="bg-app-bg rounded-xl px-3 py-2.5 text-sm mt-3">
          <p>No charges and no class access from <b>{fmt(todayISO())}</b>{untilD ? <> to <b>{fmt(until)}</b>{days ? ` (${days} days)` : ""}</> : " until you resume it"}.</p>
          <p className="text-text-muted mt-0.5">Attendance is still recorded if {first} shows up. The roster shows {first} as Paused. You can resume any time.</p>
        </div>
        <ConseqLine text={conseq} />
      </div>
      <Foot><button className={btn} onClick={onClose} disabled={busy}>Cancel</button><button className={btnP} disabled={busy || (mode === "date" && (!until || (days ?? 0) <= 0))} onClick={async () => {
        setBusy(true); setErr("");
        const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "pause_membership", confirm: true, subscriptionId: cur.id, pausedUntil: mode === "date" ? until : null });
        if (!r.ok) { setErr(r.d.error ?? "Failed"); setBusy(false); return; }
        onDone(r.d.message ?? "Paused.");
      }}>{busy ? "Working…" : `Pause${untilD ? ` until ${fmtS(untilD)}` : ""}`}</button></Foot>
    </Sheet>
  );
}

// ── 3d Change dates ──────────────────────────────────────────────────────────

function DatesDialog({ data, onClose, onDone }: { data: Payload; onClose: () => void; onDone: (msg: string) => void }) {
  const cur = data.current!; const first = data.member.firstName; const memberId = data.member.id;
  const toInput = (s: string | null) => (s ? s.slice(0, 10) : "");
  const [start, setStart] = useState(toInput(cur.startDate));
  const [through, setThrough] = useState(toInput(cur.paidThroughDate));
  const [end, setEnd] = useState(toInput(cur.endDate));
  const [commit, setCommit] = useState(toInput(cur.minimumTermEndsAt));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const e = cur.editable;
  const endChanged = end !== toInput(cur.endDate);
  const commitCapped = !!end && !!commit && commit > end;
  const conseq = !cur.hasStripe ? "nothing — billed offline. Dates change on the record only."
    : !endChanged ? "nothing — the cancel date is unchanged."
    : !end ? "cancel date removed — renews until cancelled."
    : `cancel date moves to ${fmt(end)}; charges continue until then.`;
  const changed = start !== toInput(cur.startDate) || through !== toInput(cur.paidThroughDate) || endChanged || commit !== toInput(cur.minimumTermEndsAt);
  return (
    <Sheet title="Change dates" sub={`${first} · ${data.view.headline}`} onClose={onClose}>
      <div className="px-4 py-3">
        {err && <p className="text-xs text-white bg-red-600 rounded-lg px-2.5 py-2 mb-2">{err}</p>}
        <Field label="Started" hint={e.startDate ? undefined : "Stripe owns the billing cycle — the start is a fact, not a setting."}><input className={input} type="date" value={start} disabled={!e.startDate} onChange={(ev) => setStart(ev.target.value)} /></Field>
        <Field label="Paid through" hint={e.paidThroughDate ? "Moves with each recorded payment. Edit only to correct." : `Read from Stripe${cur.currentPeriodEnd ? `: the current period ends ${fmtS(cur.currentPeriodEnd)}` : ""}.`}><input className={input} type="date" value={e.paidThroughDate ? through : toInput(cur.currentPeriodEnd)} disabled={!e.paidThroughDate} onChange={(ev) => setThrough(ev.target.value)} /></Field>
        <Field label="Ends" hint={end ? `Access${cur.hasStripe ? " and billing" : ""} stop on ${fmt(end)}.` : "No end date — renews until cancelled."}>
          <div className="flex gap-2"><input className={input} type="date" value={end} onChange={(ev) => setEnd(ev.target.value)} /><button type="button" className={btn} disabled={!end} onClick={() => setEnd("")}>Clear</button></div>
        </Field>
        <Field label="Committed through" hint={commitCapped ? "Capped at the end date — a commitment can't outlive the membership." : "The floor for cancellations. Informational for the family."}><input className={input} type="date" value={commit} onChange={(ev) => setCommit(ev.target.value)} /></Field>
        <ConseqLine text={conseq} />
      </div>
      <Foot><button className={btn} onClick={onClose} disabled={busy}>Cancel</button><button className={btnP} disabled={busy || !changed} onClick={async () => {
        setBusy(true); setErr("");
        const dates: Record<string, string | null> = {};
        if (e.startDate && start !== toInput(cur.startDate)) dates.startDate = start || null;
        if (e.paidThroughDate && through !== toInput(cur.paidThroughDate)) dates.paidThroughDate = through || null;
        if (endChanged) dates.endDate = end || null;
        if (commit !== toInput(cur.minimumTermEndsAt)) dates.minimumTermEndsAt = commit || null;
        const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "set_dates", confirm: true, subscriptionId: cur.id, dates });
        if (!r.ok) { setErr(r.d.error ?? "Failed"); setBusy(false); return; }
        onDone(r.d.message ?? "Dates saved.");
      }}>{busy ? "Saving…" : "Save dates"}</button></Foot>
    </Sheet>
  );
}

// ── 3h Comp ──────────────────────────────────────────────────────────────────

function CompDialog({ data, onClose, onDone }: { data: Payload; onClose: () => void; onDone: (msg: string) => void }) {
  const cur = data.current!; const first = data.member.firstName; const memberId = data.member.id;
  const [ack, setAck] = useState(false); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const periodEnd = cur.currentPeriodEnd;
  return (
    <Sheet title="Make it free" sub={`${first} · ${data.view.headline}`} onClose={onClose}>
      <div className="px-4 py-3">
        {err && <p className="text-xs text-white bg-red-600 rounded-lg px-2.5 py-2 mb-2">{err}</p>}
        <div className="bg-app-bg rounded-xl px-3 py-2.5 text-sm">
          <p><b>{first}&apos;s</b> membership becomes <b>$0</b>, marked as a comp on purpose — not a placeholder.</p>
          <p className="text-text-muted mt-0.5">Access is unchanged. Reports count {first} as a member, not as unbilled.</p>
        </div>
        <Field label="Why (optional)"><input className={input} placeholder="e.g. coach's kid, scholarship" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ConseqLine text={cur.hasStripe ? `the subscription is cancelled at the period end${periodEnd ? `, ${fmtS(periodEnd)}` : ""}; the free membership starts that day. Nothing is refunded or charged.` : "nothing — the record is marked free."} />
        <Ack checked={ack} onChange={setAck}>Make {first}&apos;s membership free.</Ack>
      </div>
      <Foot><button className={btn} onClick={onClose} disabled={busy}>Cancel</button><button className={btnP} disabled={busy || !ack} onClick={async () => {
        setBusy(true); setErr("");
        const r = await post(`/api/members/${memberId}/billing-admin/actions`, { action: "comp_membership", confirm: true, subscriptionId: cur.id, reason: reason || null });
        if (!r.ok) { setErr(r.d.error ?? "Failed"); setBusy(false); return; }
        onDone(r.d.message ?? "Comped.");
      }}>{busy ? "Working…" : "Make it free"}</button></Foot>
    </Sheet>
  );
}

// B3 slice 3 — which group (team, school, …) this athlete is in, per club group rate.
function GroupAnswers({ memberId, groups, canEdit, onSaved }: { memberId: string; groups: { id: string; label: string; options: string[]; value: string }[]; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(groups.map((g) => [g.id, g.value])));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr("");
    const r = await fetch(`/api/members/${memberId}/group-values`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: vals }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.error || "Couldn't save."); return; }
    setEdit(false); onSaved();
  }
  if (!edit) {
    return (
      <p className="text-xs text-text-muted mt-2">
        {groups.map((g) => `${g.label}: ${g.value || "—"}`).join(" · ")}
        {canEdit && <button className="text-brand hover:underline ml-2" onClick={() => setEdit(true)}>Edit</button>}
      </p>
    );
  }
  return (
    <div className="mt-2 rounded-lg border border-app-border p-2.5 space-y-2">
      {groups.map((g) => (
        <label key={g.id} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 text-text-primary">{g.label}</span>
          {g.options.length ? (
            <select value={vals[g.id] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [g.id]: e.target.value }))} className="flex-1 px-2 py-1.5 border border-app-border rounded-lg bg-surface">
              <option value="">None</option>
              {g.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input value={vals[g.id] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [g.id]: e.target.value }))} className="flex-1 px-2 py-1.5 border border-app-border rounded-lg bg-surface" />
          )}
        </label>
      ))}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        <button onClick={() => setEdit(false)} className="text-xs px-3 py-1.5 rounded-lg border border-app-border">Cancel</button>
      </div>
    </div>
  );
}
