"use client";

// Attendees — the ONE place to see and act on who is coming and what they owe
// (design handoff options 1c desktop / 1d phone; B11 slice 3). It replaces the
// old Bookings and Registrations modals.
//
// Numbers: every tile, chip count, the collect panel and the footer come from
// the ledger served by GET /api/events/[id]/attendees
// (lib/eventAttendees.buildAttendeeLedger) through the pure helpers in
// lib/eventAttendeeActions. Nothing on screen is a second copy.
//
// Actions: each one calls an EXISTING route — this screen never computes an
// amount anyone is billed:
//   Record: cash · check   POST registrations/[regId]/offline-payment
//   Record cash (selected) the same route, once per selected row
//   Resend receipt         POST registrations/[regId]/resend-receipt
//   Charge now             POST registrations/[regId]/charge-now (the event-day
//                          charge whose date has arrived; never early)
//   Approve/Propose/Decline POST registrations/[regId]/{approve,propose-change,decline}
//   Email payment links    POST bill-registrants (preview → review → send)
//   Reprice                POST reprice-registrations
//   Discount               POST registrations/[regId]/discount
//   Add an email           PATCH /api/members/[id]
//   Remove                 DELETE registrations/[regId] (roster + bill together)
//                          or DELETE bookings?memberId= for a spot with no bill
//   + Add attendee         POST bookings (free) or POST charge (spot + bill)
//
// Detail the actions need (payment method, recipient repair, the coach
// policy) comes from GET /api/events/[id]/registrations, loaded FIRST so its
// lazy event-day charge sweep — which the Registrations modal used to run on
// open — still runs, and the ledger loaded after it reflects the result.

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { AttendeeFilter, AttendeeRow } from "@/lib/eventAttendees";
import {
  attendeeTiles,
  cashRecordable,
  collectAmount,
  collectSummary,
  filterChips,
  initials,
  isSelectable,
  ledgerGrandTotal,
  mismatchedRows,
  removePlan,
  rowActions,
  selectedCash,
  selectedCollect,
  visibleRows,
  type CollectContext,
  type RowAction,
} from "@/lib/eventAttendeeActions";
import { SkeletonList } from "@/components/LoadingSkeleton";
import Sheet from "@/components/Sheet";
import AddAttendeeForm from "@/components/events/attendees/AddAttendeeForm";
import DecisionSheet, { type DecisionMode } from "@/components/events/attendees/DecisionSheet";
import InvoiceReviewSheet from "@/components/events/attendees/InvoiceReviewSheet";
import {
  money,
  type AttendeesPayload,
  type InvoicePreview,
  type RegDetail,
  type RegistrationsPayload,
} from "@/components/events/attendees/types";

const shortDate = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
function dateRange(a: string, b: string) {
  const s = new Date(a), e = new Date(b);
  return s.toDateString() === e.toDateString() ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`;
}

const GRID = "26px 1.5fr 1.6fr .7fr 1.2fr .8fr 1.5fr";
const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";
const field = "w-full min-h-11 px-3 py-2 border border-app-border rounded-[10px] text-[14px] bg-surface text-text-primary";

function pill(r: AttendeeRow): { label: string; cls: string } {
  if (r.status === "SCHEDULED") {
    return { label: r.scheduledAt ? `Card charge ${shortDate(r.scheduledAt)}` : r.label, cls: "bg-pending-surface text-pending-text" };
  }
  if (r.waitingOn === "PARENT" && !r.removed) return { label: "Waiting on the parent", cls: "bg-chip-surface text-chip-text" };
  const cls =
    r.tone === "paid" ? "bg-success-surface text-success-text"
    : r.tone === "owed" ? "bg-warn-surface text-warn-text"
    : r.tone === "warn" ? "bg-danger-surface text-danger-text"
    : r.tone === "info" ? "bg-info-surface text-brand border border-info-border"
    : "bg-chip-surface text-chip-text";
  return { label: r.label, cls };
}

function StatusPill({ r }: { r: AttendeeRow }) {
  const p = pill(r);
  return <span className={`inline-block text-[12px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap tabular-nums ${p.cls}`}>{p.label}</span>;
}

function SourceChip({ r }: { r: AttendeeRow }) {
  return (
    <span className="text-[12px] font-semibold px-1.5 py-px rounded-full bg-chip-surface text-chip-text">
      {r.source === "MEMBER" ? "Member" : "Public"}
    </span>
  );
}

const ACTION_LABEL: Record<RowAction, string> = {
  decide: "Approve · Propose · Decline",
  record: "Record: cash · check",
  resend: "Resend receipt",
  chargeNow: "Charge now",
  addEmail: "Add an email",
  discount: "Discount",
  remove: "Remove",
};

type SheetState =
  | { kind: "record"; row: AttendeeRow; method: "CASH" | "CHECK" }
  | { kind: "recordBulk" }
  | { kind: "remove"; row: AttendeeRow }
  | { kind: "chargeNow"; row: AttendeeRow }
  | { kind: "decide"; row: AttendeeRow; mode: DecisionMode }
  | { kind: "addEmail"; row: AttendeeRow }
  | { kind: "discount"; row: AttendeeRow }
  | { kind: "reprice" }
  | { kind: "more"; row: AttendeeRow };

type Flash = { ok: boolean; text: string } | null;

export default function AttendeesModal({
  eventId,
  onClose,
  initialAdd = false,
}: {
  eventId: string;
  /** `changed` = something was written; the events list should reload. */
  onClose: (changed: boolean) => void;
  /** Open with the "+ Add attendee" form already expanded. */
  initialAdd?: boolean;
}) {
  const [data, setData] = useState<AttendeesPayload | null>(null);
  const [regs, setRegs] = useState<RegistrationsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AttendeeFilter>("all");
  const [showRemoved, setShowRemoved] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(initialAdd);
  const [flash, setFlash] = useState<Flash>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheetErr, setSheetErr] = useState("");
  const [preview, setPreview] = useState<{ p: InvoicePreview; ids: string[] } | null>(null);
  const [changed, setChanged] = useState(false);
  // Sheet inputs
  const [checkRef, setCheckRef] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [guardianInput, setGuardianInput] = useState("");
  const [codeInput, setCodeInput] = useState("");

  const load = useCallback(async () => {
    try {
      // Registrations first: its lazy event-day charge sweep runs, then the
      // ledger reflects whatever it settled.
      const rr = await fetch(`/api/events/${eventId}/registrations`);
      const rj = rr.ok ? ((await rr.json()) as RegistrationsPayload) : null;
      const ar = await fetch(`/api/events/${eventId}/attendees`);
      if (!ar.ok) throw new Error((await ar.json().catch(() => ({}))).error || `Failed (${ar.status})`);
      const aj = (await ar.json()) as AttendeesPayload;
      setRegs(rj);
      setData(aj);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load attendees.");
    }
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  const ledger = data?.ledger;
  const ev = data?.event;
  const detailById = useMemo(() => new Map((regs?.registrations ?? []).map((r) => [r.id, r] as const)), [regs]);
  const detail = (r: AttendeeRow): RegDetail | null => (r.registrationId ? detailById.get(r.registrationId) ?? null : null);

  const ctx: CollectContext = useMemo(
    () => ({ isVariable: !!regs?.event.variableCostEnabled, perHead: regs?.perHead ?? null, publicPrice: regs?.publicPrice ?? null }),
    [regs],
  );
  const now = useMemo(() => new Date(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (ledger ? visibleRows(ledger, filter, showRemoved) : []), [ledger, filter, showRemoved]);
  const allRows = ledger?.rows ?? [];
  const collect = useMemo(() => collectSummary(allRows, ctx), [allRows, ctx]);
  const selCollect = selectedCollect(selected, allRows, ctx);
  const selCash = selectedCash(selected, allRows);
  const mismatched = useMemo(
    () => mismatchedRows(allRows, ctx, (id) => {
      const d = detailById.get(id);
      return d ? { discountAmount: d.discountAmount == null ? null : Number(d.discountAmount), sessionIds: d.sessionIds ?? null } : null;
    }),
    [allRows, ctx, detailById],
  );
  const canDecide = regs?.event.canDecide !== false && !!regs;
  const allowPropose = !!regs?.event.policy?.allowProposedChanges;
  const actionsFor = (r: AttendeeRow) =>
    regs
      ? rowActions(r, { canDecide, now, detail: { transactionId: detail(r)?.transactionId ?? null, fixMemberId: detail(r)?.recipient?.fixMemberId ?? null } })
      : r.removed ? [] : (["remove"] as RowAction[]);

  // Drop selections that stopped being selectable after a reload.
  useEffect(() => {
    setSelected((prev) => {
      const ok = new Set(allRows.filter((r) => r.registrationId && isSelectable(r, ctx)).map((r) => r.registrationId as string));
      const next = new Set([...prev].filter((id) => ok.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allRows, ctx]);

  function done(msg: Flash) {
    setFlash(msg);
    setSheet(null);
    setSheetErr("");
    setChanged(true);
    load();
  }

  function openSheet(s: SheetState) {
    setSheetErr("");
    setCheckRef("");
    setEmailInput("");
    setGuardianInput("");
    if (s.kind === "discount") setCodeInput(detail(s.row)?.discountCode ?? "");
    setSheet(s);
  }

  async function call(key: string, url: string, init: RequestInit): Promise<{ ok: boolean; d: Record<string, unknown> }> {
    setBusy(key);
    setSheetErr("");
    try {
      const res = await fetch(url, init);
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, d };
    } finally {
      setBusy(null);
    }
  }
  const errText = (d: Record<string, unknown>, fallback: string) =>
    typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : fallback;
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // ── Actions ────────────────────────────────────────────────────────────────
  function runAction(r: AttendeeRow, a: RowAction, method?: "CASH" | "CHECK") {
    if (a === "record") return openSheet({ kind: "record", row: r, method: method ?? (r.status === "AWAITING_CHECK" || detail(r)?.paymentMethod === "CHECK" ? "CHECK" : "CASH") });
    if (a === "resend") return resendReceipt(r);
    if (a === "chargeNow") return openSheet({ kind: "chargeNow", row: r });
    if (a === "decide") return openSheet({ kind: "decide", row: r, mode: "approve" });
    if (a === "addEmail") return openSheet({ kind: "addEmail", row: r });
    if (a === "discount") return openSheet({ kind: "discount", row: r });
    if (a === "remove") return openSheet({ kind: "remove", row: r });
  }

  async function resendReceipt(r: AttendeeRow) {
    const { ok, d } = await call(`resend:${r.id}`, `/api/events/${eventId}/registrations/${r.registrationId}/resend-receipt`, { method: "POST" });
    setFlash(ok ? { ok: true, text: `Receipt for ${r.name} re-sent to ${String(d.to ?? "their email")}.` } : { ok: false, text: errText(d, "Could not resend the receipt.") });
  }

  async function recordOne(r: AttendeeRow, method: "CASH" | "CHECK") {
    const { ok, d } = await call("record", `/api/events/${eventId}/registrations/${r.registrationId}/offline-payment`,
      json({ method, reference: method === "CHECK" ? checkRef.trim() || null : null, amountReceived: r.amountDue }));
    if (!ok) return setSheetErr(errText(d, "Could not record the payment."));
    done({ ok: true, text: `Recorded ${money(r.amountDue)} ${method === "CHECK" ? "check" : "cash"} from ${r.name} — receipt sent.` });
  }

  async function recordBulk() {
    const targets = allRows.filter((r) => r.registrationId && selCash.ids.includes(r.registrationId));
    setBusy("recordBulk");
    setSheetErr("");
    const failed: string[] = [];
    let recorded = 0;
    for (const r of targets) {
      const res = await fetch(`/api/events/${eventId}/registrations/${r.registrationId}/offline-payment`, json({ method: "CASH", amountReceived: r.amountDue }));
      if (res.ok) recorded++;
      else {
        const d = await res.json().catch(() => ({}));
        failed.push(`${r.name}: ${errText(d, "not recorded")}`);
      }
    }
    setBusy(null);
    setSelected(new Set());
    done(failed.length
      ? { ok: false, text: `Recorded cash for ${recorded} of ${targets.length}. ${failed.join(" · ")}` }
      : { ok: true, text: `Recorded cash for ${recorded} — receipts sent.` });
  }

  async function remove(r: AttendeeRow) {
    const plan = removePlan(r, { transactionId: detail(r)?.transactionId ?? null });
    if (plan.kind === "blocked") return;
    const url = plan.kind === "registration"
      ? `/api/events/${eventId}/registrations/${plan.registrationId}`
      : `/api/events/${eventId}/bookings?memberId=${encodeURIComponent(plan.memberId)}`;
    const { ok, d } = await call("remove", url, { method: "DELETE" });
    if (!ok) return setSheetErr(errText(d, "Could not remove them."));
    done({ ok: true, text: `${r.name} removed from the roster and the billing list.` });
  }

  async function chargeNow(r: AttendeeRow) {
    const { ok, d } = await call("charge", `/api/events/${eventId}/registrations/${r.registrationId}/charge-now`, { method: "POST" });
    if (!ok) return setSheetErr(errText(d, "The charge didn't go through."));
    done({ ok: true, text: typeof d.message === "string" ? d.message : `${r.name}'s card was charged — receipt sent.` });
  }

  async function saveEmail(r: AttendeeRow) {
    const dt = detail(r);
    const memberId = dt?.recipient?.fixMemberId;
    const email = emailInput.trim();
    if (!memberId) return;
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return setSheetErr(`"${email}" doesn't look like an email address.`);
    const isMinor = dt?.member?.isMinor !== false;
    const payload: Record<string, string> = isMinor ? { guardianEmail: email } : { email };
    if (isMinor && !dt?.member?.guardianName) {
      if (!guardianInput.trim()) return setSheetErr(`A parent/guardian name is required to save an email for ${r.name}.`);
      payload.guardianName = guardianInput.trim();
    }
    const { ok, d } = await call("email", `/api/members/${memberId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!ok) return setSheetErr(errText(d, "Could not save that email."));
    done({ ok: true, text: `Saved ${email} for ${r.name}. Their bill and receipt will go there.` });
  }

  async function setDiscount(r: AttendeeRow, code: string | null) {
    const { ok, d } = await call("discount", `/api/events/${eventId}/registrations/${r.registrationId}/discount`, json({ discountCode: code }));
    if (!ok) return setSheetErr(errText(d, "Could not apply that code."));
    const amt = money(Number(d.amountDue ?? 0));
    done({ ok: true, text: code ? `${String(d.discountCode ?? code)} applied to ${r.name} — now ${amt}.${d.reinvoiceNeeded ? " They were already sent a link — email them a fresh one." : ""}` : `Discount cleared for ${r.name} — now ${amt}.` });
  }

  async function reprice() {
    const { ok, d } = await call("reprice", `/api/events/${eventId}/reprice-registrations`, json({ apply: true }));
    if (!ok) return setSheetErr(errText(d, "Could not reprice."));
    const updated = Number(d.updated ?? 0);
    const locked = Array.isArray(d.locked) ? d.locked.length : 0;
    done({ ok: true, text: updated > 0 ? `Repriced ${updated} registration${updated === 1 ? "" : "s"}.${locked ? ` ${locked} left alone (money already committed).` : ""}` : "Everyone already matches the event's current pricing." });
  }

  async function startInvoice(ids: string[]) {
    if (ids.length === 0) return;
    const { ok, d } = await call("invoice", `/api/events/${eventId}/bill-registrants`, json({ registrationIds: ids, preview: true }));
    if (!ok) return setFlash({ ok: false, text: errText(d, "Could not build the payment-link preview.") });
    setPreview({ p: d as unknown as InvoicePreview, ids });
  }

  async function sendInvoice() {
    if (!preview) return;
    const { ok, d } = await call("invoice", `/api/events/${eventId}/bill-registrants`, json({ registrationIds: preview.ids, confirmMismatched: preview.p.mismatched > 0 }));
    if (!ok) return setFlash({ ok: false, text: errText(d, "Could not send the payment links.") });
    setPreview(null);
    setSelected(new Set());
    const errs = Array.isArray(d.errors) ? d.errors.length : 0;
    const parts = [`Emailed ${Number(d.billed ?? 0)} payment link${Number(d.billed) === 1 ? "" : "s"}`];
    if (d.skipped) parts.push(`${String(d.skipped)} already paid`);
    if (errs) parts.push(`${errs} failed`);
    done({ ok: errs === 0, text: parts.join(" · ") + "." });
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const selectableVisible = rows.filter((r) => r.registrationId && isSelectable(r, ctx)).map((r) => r.registrationId as string);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((id) => selected.has(id));

  const excludeMemberIds = useMemo(() => new Set(allRows.filter((r) => !r.removed && r.memberId).map((r) => r.memberId as string)), [allRows]);
  const tiles = ledger ? attendeeTiles(ledger) : [];
  const categoryLabel = ev?.categoryLabel ?? null;

  // ── Inline actions for one row ──────────────────────────────────────────────
  function renderActions(r: AttendeeRow, compact?: boolean) {
    const acts = actionsFor(r);
    const primary = acts.filter((a) => a !== "remove" && a !== "discount" && a !== "addEmail");
    const link = "text-[12.5px] text-brand hover:underline disabled:opacity-50";
    if (compact) {
      const first = primary[0];
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {first && (
            <button type="button" className={`${link} min-h-11 px-1`} disabled={busy === `resend:${r.id}`} onClick={() => runAction(r, first)}>
              {first === "decide" ? "Review" : first === "record" ? "Record payment" : ACTION_LABEL[first]}
            </button>
          )}
          {acts.length > (first ? 1 : 0) && (
            <button type="button" className="min-h-11 px-2 text-[12.5px] text-text-muted" onClick={() => openSheet({ kind: "more", row: r })}>
              More
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-text-muted">
        {primary.map((a) =>
          a === "record" ? (
            <span key={a}>
              Record:{" "}
              <button type="button" className={link} onClick={() => runAction(r, "record", "CASH")}>cash</button>
              {" · "}
              <button type="button" className={link} onClick={() => runAction(r, "record", "CHECK")}>check</button>
            </span>
          ) : a === "decide" ? (
            <span key={a}>
              <button type="button" className={link} onClick={() => openSheet({ kind: "decide", row: r, mode: "approve" })}>Approve</button>
              {allowPropose && <>{" · "}<button type="button" className={link} onClick={() => openSheet({ kind: "decide", row: r, mode: "propose" })}>Propose</button></>}
              {" · "}
              <button type="button" className={link} onClick={() => openSheet({ kind: "decide", row: r, mode: "decline" })}>Decline</button>
            </span>
          ) : (
            <button key={a} type="button" className={link} disabled={busy === `resend:${r.id}`} onClick={() => runAction(r, a)}>
              {busy === `resend:${r.id}` && a === "resend" ? "Sending…" : ACTION_LABEL[a]}
            </button>
          ),
        )}
        {acts.includes("addEmail") && <button type="button" className={link} onClick={() => runAction(r, "addEmail")}>Add an email</button>}
        {acts.includes("discount") && <button type="button" className={link} onClick={() => runAction(r, "discount")}>Discount</button>}
        {acts.includes("remove") && <button type="button" className="text-[12.5px] text-danger-text hover:underline" onClick={() => runAction(r, "remove")}>Remove</button>}
      </div>
    );
  }

  const phoneAmount = (r: AttendeeRow) =>
    r.owes > 0 ? { v: money(r.owes), n: "owes" }
    : r.status === "SCHEDULED" ? { v: money(r.scheduledAmount), n: r.scheduledAt ? `auto ${shortDate(r.scheduledAt)}` : "scheduled" }
    : r.paid > 0 ? { v: money(r.paid), n: "paid" }
    : collectAmount(r, ctx) > 0 ? { v: money(collectAmount(r, ctx)), n: "unpaid" }
    : { v: "—", n: r.status === "COVERED" ? "covered" : "" };

  // ── Render ─────────────────────────────────────────────────────────────────
  const sheetRow = sheet && "row" in sheet ? sheet.row : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={() => onClose(changed)}>
      <div
        className="w-full sm:max-w-[1120px] bg-surface sm:rounded-[14px] rounded-t-2xl shadow-2xl max-h-[92dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Attendees"
      >
        {/* Header */}
        <div className="px-4 sm:px-5 py-3 border-b border-app-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[16px] sm:text-[20px] font-semibold text-text-primary leading-tight">
              Attendees{ledger ? ` · ${ledger.visible}` : ""}
            </h2>
            {ev && (
              <p className="text-[12.5px] text-text-muted truncate">
                {ev.name} · {dateRange(ev.startsAt, ev.endsAt)}
                {ledger?.capacity.spotsLeft != null ? ` · ${ledger.capacity.spotsLeft} spots left` : ""}
                {ev.publicSlug ? ` · /e/${ev.publicSlug}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className={`min-h-11 px-3 sm:px-4 rounded-[10px] text-[13.5px] font-semibold ${addOpen ? "border border-app-border text-text-primary" : "bg-brand text-white hover:bg-brand-hover"}`}
            >
              {addOpen ? "Close" : "+ Add attendee"}
            </button>
            <button type="button" onClick={() => onClose(changed)} aria-label="Close" className="w-11 h-11 rounded-[10px] hover:bg-app-bg flex items-center justify-center text-text-muted">
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {addOpen && (
            <AddAttendeeForm
              eventId={eventId}
              excludeMemberIds={excludeMemberIds}
              onCancel={() => setAddOpen(false)}
              onAdded={(r) => {
                setAddOpen(false);
                done({ ok: true, text: r.invoiceRegistrationId ? `${r.text} Review their payment link below.` : r.text });
                if (r.invoiceRegistrationId) startInvoice([r.invoiceRegistrationId]);
              }}
            />
          )}

          {error ? (
            <div className="p-8 text-center text-[14px] text-danger-text">{error}</div>
          ) : !data || !ledger ? (
            <div className="p-4"><SkeletonList rows={5} /></div>
          ) : (
            <>
              {/* Phone: sticky money bar + the primary collect button (1d) */}
              <div className="sm:hidden sticky top-0 z-[1] bg-table-chrome border-b border-app-border px-4 py-3">
                <div className="grid grid-cols-2 gap-2">
                  {tiles.filter((t) => t.key === "collected" || t.key === "outstanding").map((t) => (
                    <div key={t.key} className={`rounded-[12px] px-3 py-2 border ${t.tone === "warn" ? "bg-warn-surface border-warn-border" : "bg-surface border-app-border"}`}>
                      <div className="text-[12px] font-semibold uppercase tracking-[.05em] text-text-muted">{t.label}</div>
                      <div className="text-[18px] font-bold tabular-nums text-text-primary leading-tight">{money(t.amount ?? 0)}</div>
                    </div>
                  ))}
                </div>
                {collect.count > 0 && (
                  <button type="button" onClick={() => startInvoice(collect.ids)} disabled={busy === "invoice"} className={`${btn} w-full mt-2 bg-brand text-white`}>
                    {busy === "invoice" ? "Preparing…" : `Email payment link to all unpaid (${collect.count})`}
                  </button>
                )}
              </div>

              {/* Desktop: explainer + four tiles (1c) */}
              <div className="hidden sm:block px-5 py-4 bg-table-chrome">
                <p className="text-[12.5px] text-text-muted mb-3">
                  Everyone signed up — booked as a member or through the public link — and what each one owes. Adding someone books the spot and the bill together; removing takes both away.
                </p>
                <div className="grid grid-cols-4 gap-3">
                  {tiles.map((t) => (
                    <div
                      key={t.key}
                      className={`rounded-[12px] px-3 py-2.5 border ${t.tone === "warn" ? "bg-warn-surface border-warn-border" : t.tone === "brand" ? "bg-info-surface border-info-border" : "bg-surface border-app-border"}`}
                    >
                      <div className="text-[12px] font-semibold uppercase tracking-[.05em] text-text-muted">{t.label}</div>
                      <div className="text-[20px] font-bold tabular-nums text-text-primary leading-tight mt-0.5">{t.amount != null ? money(t.amount) : t.count}</div>
                      <div className="text-[12px] text-text-muted">{t.sub}</div>
                    </div>
                  ))}
                </div>
              </div>

              {flash && (
                <div className={`mx-4 sm:mx-5 mt-3 text-[13px] rounded-[10px] px-3 py-2 border flex items-start justify-between gap-2 ${flash.ok ? "bg-success-surface text-success-text border-success-border" : "bg-danger-surface text-danger-text border-danger-border"}`} role="status">
                  <span>{flash.text}</span>
                  <button type="button" onClick={() => setFlash(null)} aria-label="Dismiss" className="-my-2 -mr-2 w-11 h-11 flex items-center justify-center"><X size={14} /></button>
                </div>
              )}

              {/* Filter chips — live counts, they really filter */}
              <div className="px-4 sm:px-5 py-2.5 flex gap-1.5 overflow-x-auto border-b border-app-border" style={{ scrollbarWidth: "none" }}>
                {filterChips(ledger).map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    aria-pressed={filter === f.key}
                    className={`min-h-11 sm:min-h-9 text-[13px] px-3 rounded-full whitespace-nowrap tabular-nums flex-shrink-0 ${filter === f.key ? "bg-brand text-white font-semibold" : "bg-app-bg text-text-muted hover:text-text-primary"}`}
                  >
                    {f.label} · {f.count}
                  </button>
                ))}
              </div>

              {/* Stale amounts, surfaced before anything is emailed */}
              {mismatched.length > 0 && (
                <div className="mx-4 sm:mx-5 mt-3 rounded-[12px] border border-warn-border bg-warn-surface px-4 py-3">
                  <div className="text-[14px] font-semibold text-text-primary">
                    {mismatched.length} {mismatched.length === 1 ? "person carries" : "people carry"} an amount that doesn&apos;t match this event&apos;s {money(ctx.publicPrice ?? 0)} price
                  </div>
                  <p className="text-[12.5px] text-text-muted mt-0.5">
                    {mismatched.slice(0, 5).map((r) => `${r.name} ${money(r.amountDue)}`).join(" · ")}{mismatched.length > 5 ? ` · and ${mismatched.length - 5} more` : ""}. They&apos;ll be billed what they carry unless you reprice.
                  </p>
                  <button type="button" onClick={() => openSheet({ kind: "reprice" })} className="mt-2 min-h-11 px-3 rounded-[10px] text-[13px] font-semibold border border-app-border bg-surface text-text-primary">
                    Reprice all unpaid to {money(ctx.publicPrice ?? 0)}
                  </button>
                </div>
              )}

              {/* Collect payment — shown only when someone owes */}
              {collect.count > 0 && (
                <div className="hidden sm:block mx-5 mt-3 rounded-[12px] border border-app-border px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold text-text-primary">Collect payment</div>
                      <p className="text-[12.5px] text-text-muted mt-0.5">
                        {ctx.isVariable
                          ? `The cost is split — each person owes about ${money(ctx.perHead ?? 0)}. Email them a link for exactly their share.`
                          : "Public signups are recorded before checkout, so anyone who closed the payment page is still on the list and still owes. Email them a fresh link for exactly what they owe."}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 tabular-nums">
                      <div className="text-[12px] text-text-muted">{collect.count} unpaid</div>
                      <div className="text-[16px] font-bold text-text-primary">{money(collect.total)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button type="button" onClick={() => startInvoice(collect.ids)} disabled={busy === "invoice"} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
                      {busy === "invoice" ? "Preparing…" : `Email payment link to all unpaid (${collect.count})`}
                    </button>
                    <button type="button" onClick={() => startInvoice(selCollect.ids)} disabled={selCollect.count === 0 || busy === "invoice"} className={`${btn} border border-app-border text-text-primary`}>
                      Email selected ({selCollect.count})
                    </button>
                    <button type="button" onClick={() => openSheet({ kind: "recordBulk" })} disabled={selCash.count === 0} className={`${btn} border border-app-border text-text-primary`}>
                      Record cash for selected{selCash.count > 0 ? ` (${selCash.count})` : ""}
                    </button>
                  </div>
                </div>
              )}
              {ctx.isVariable && collect.count === 0 && ledger.visible > 0 && ctx.perHead == null && (
                <p className="mx-4 sm:mx-5 mt-3 text-[12.5px] text-text-muted">Set the event&apos;s total cost to work out each person&apos;s share before emailing payment links.</p>
              )}

              {rows.length === 0 ? (
                <div className="p-10 text-center text-[14px] text-text-muted">
                  {filter === "all" ? "Nobody has signed up yet." : "Nobody matches this filter."}
                </div>
              ) : (
                <>
                  {/* Phone: one card per attendee */}
                  <ul className="sm:hidden divide-y divide-hairline">
                    {rows.map((r) => {
                      const amt = phoneAmount(r);
                      return (
                        <li key={r.id} className={`px-4 py-3 flex items-start gap-3 ${r.removed ? "opacity-60" : ""}`}>
                          <div className="w-9 h-9 rounded-full bg-app-bg flex items-center justify-center text-[12px] font-semibold text-text-muted flex-shrink-0">{initials(r.name)}</div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[14.5px] font-semibold text-text-primary truncate">{r.name}</div>
                            <div className="text-[12px] text-text-muted flex items-center gap-1.5 flex-wrap">
                              <SourceChip r={r} />
                              <span>{[r.categoryValue, r.attending].filter(Boolean).join(" · ")}</span>
                            </div>
                            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                              <StatusPill r={r} />
                              {!r.removed && renderActions(r, true)}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0 tabular-nums">
                            <div className="text-[15px] font-bold text-text-primary">{amt.v}</div>
                            <div className="text-[12px] text-text-muted">{amt.n}</div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {/* Desktop: table. Header and rows share one track list. */}
                  <div className="hidden sm:block px-5 py-3">
                    <div className="grid gap-3 px-3 pb-2 items-center text-[12px] font-semibold uppercase tracking-[.05em] text-text-muted" style={{ gridTemplateColumns: GRID }}>
                      <div>
                        <input type="checkbox" aria-label="Select everyone shown who can be billed" checked={allVisibleSelected} disabled={selectableVisible.length === 0}
                          onChange={() => setSelected(allVisibleSelected ? new Set() : new Set([...selected, ...selectableVisible]))} className="h-4 w-4" />
                      </div>
                      <div>Name</div><div>Contact</div><div>{categoryLabel ?? "Category"}</div><div>Attending</div><div className="text-right">Owes</div><div>Status</div>
                    </div>
                    <div className="rounded-[12px] border border-app-border overflow-hidden divide-y divide-hairline">
                      {rows.map((r) => {
                        const selectable = !!r.registrationId && isSelectable(r, ctx);
                        const owed = r.owes > 0 ? r.owes : collectAmount(r, ctx);
                        return (
                          <div key={r.id} className={`grid gap-3 items-start px-3 py-2.5 text-[13.5px] ${r.removed ? "opacity-60" : ""}`} style={{ gridTemplateColumns: GRID }}>
                            <div className="pt-0.5">
                              {selectable && (
                                <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.registrationId as string)} onChange={() => toggle(r.registrationId as string)} className="h-4 w-4" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="font-semibold text-text-primary truncate">{r.name}</div>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <SourceChip r={r} />
                                {r.bookingStatus === "WAITLISTED" && <span className="text-[12px] text-text-muted">waitlist</span>}
                              </div>
                            </div>
                            <div className="min-w-0 text-[12.5px]">
                              <div className="text-text-primary truncate">{r.email ?? <span className="text-warn-text">{detail(r)?.recipient?.reason ?? "No address on file"}</span>}</div>
                              <div className="text-text-muted truncate">{[r.emailNote, r.phone].filter(Boolean).join(" · ")}</div>
                            </div>
                            <div className="text-text-primary">{r.categoryValue ?? <span className="text-text-muted">—</span>}</div>
                            <div className="text-[12.5px] text-text-muted">{r.attending}</div>
                            <div className="text-right font-semibold tabular-nums text-[14px] text-text-primary">{owed > 0 ? money(owed) : <span className="text-text-muted">—</span>}</div>
                            <div className="min-w-0">
                              <StatusPill r={r} />
                              {detail(r)?.lastChargeError && r.status === "PAYMENT_FAILED" && (
                                <div className="text-[12px] text-text-muted mt-0.5 truncate">{detail(r)?.lastChargeError}</div>
                              )}
                              {!r.removed && renderActions(r)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {ledger && (
          <div className="px-4 sm:px-5 py-2.5 border-t border-app-border flex items-center justify-between gap-3 text-[12.5px] text-text-muted flex-wrap">
            <div>
              Showing {rows.length === ledger.visible && filter === "all" && !showRemoved ? "all " : ""}{rows.length}
              {ledger.removed > 0 && (
                <>
                  {" · "}
                  <button type="button" className="text-brand hover:underline min-h-11 sm:min-h-0" onClick={() => { setShowRemoved((v) => !v); setFilter("all"); }}>
                    {showRemoved ? "Hide" : "Show"} {ledger.removed} removed attendee{ledger.removed === 1 ? "" : "s"}
                  </button>
                </>
              )}
            </div>
            <div className="tabular-nums">
              Outstanding <b className="font-semibold text-text-primary">{money(ledger.tiles.outstanding)}</b> of {money(ledgerGrandTotal(ledger))}
            </div>
          </div>
        )}
      </div>

      {/* ── Sheets (confirms and small forms) ─────────────────────────────── */}
      <div onClick={(e) => e.stopPropagation()}>
        {preview && (
          <InvoiceReviewSheet preview={preview.p} busy={busy === "invoice"} onSend={sendInvoice} onClose={() => setPreview(null)} />
        )}

        {sheet?.kind === "decide" && sheetRow && regs && detail(sheetRow) && (
          <DecisionSheet
            eventId={eventId}
            reg={detail(sheetRow) as RegDetail}
            owed={sheetRow.owes > 0 ? sheetRow.owes : sheetRow.amountDue}
            mode={sheet.mode}
            regs={regs}
            onClose={() => setSheet(null)}
            onDone={(m) => done(m)}
          />
        )}

        {sheet?.kind === "more" && sheetRow && (
          <Sheet open onClose={() => setSheet(null)} title={sheetRow.name} description={pill(sheetRow).label}>
            <div className="flex flex-col">
              {actionsFor(sheetRow).flatMap((a) =>
                a === "decide"
                  ? ([["approve", "Approve"], ...(allowPropose ? [["propose", "Propose a change"]] : []), ["decline", "Decline"]] as [DecisionMode, string][]).map(([m, l]) => (
                      <button key={m} type="button" className="min-h-11 text-left text-[14px] text-text-primary border-b border-hairline" onClick={() => openSheet({ kind: "decide", row: sheetRow, mode: m })}>{l}</button>
                    ))
                  : a === "record"
                    ? (["CASH", "CHECK"] as const).map((m) => (
                        <button key={m} type="button" className="min-h-11 text-left text-[14px] text-text-primary border-b border-hairline" onClick={() => openSheet({ kind: "record", row: sheetRow, method: m })}>
                          Record {m === "CASH" ? "cash" : "check"} · {money(sheetRow.amountDue)}
                        </button>
                      ))
                    : [
                        <button key={a} type="button" className={`min-h-11 text-left text-[14px] border-b border-hairline ${a === "remove" ? "text-danger-text" : "text-text-primary"}`} onClick={() => { if (a === "resend") setSheet(null); runAction(sheetRow, a); }}>
                          {ACTION_LABEL[a]}
                        </button>,
                      ],
              )}
            </div>
          </Sheet>
        )}

        {sheet?.kind === "record" && sheetRow && (() => {
          const expected = !ctx.isVariable && (ctx.publicPrice ?? 0) > 0 && !(detail(sheetRow)?.sessionIds?.length)
            ? Math.max(0, (ctx.publicPrice ?? 0) - Number(detail(sheetRow)?.discountAmount ?? 0)) : null;
          const off = expected != null && Math.round(expected * 100) !== Math.round(sheetRow.amountDue * 100);
          return (
            <Sheet
              open
              onClose={() => setSheet(null)}
              title={`Record ${money(sheetRow.amountDue)} ${sheet.method === "CHECK" ? "check" : "cash"} from ${sheetRow.name}?`}
              description="This marks them paid and emails a receipt."
              footer={<>
                <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setSheet(null)}>Cancel</button>
                <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={busy === "record"} onClick={() => recordOne(sheetRow, sheet.method)}>
                  {busy === "record" ? "Recording…" : `Record ${money(sheetRow.amountDue)}`}
                </button>
              </>}
            >
              <div className="flex gap-2 mb-3" role="radiogroup" aria-label="Received as">
                {(["CASH", "CHECK"] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={sheet.method === m} onClick={() => setSheet({ ...sheet, method: m })}
                    className={`min-h-11 px-4 rounded-full text-[13.5px] border ${sheet.method === m ? "border-brand bg-prospect-surface text-prospect-text font-semibold" : "border-app-border text-text-primary"}`}>
                    {m === "CASH" ? "Cash" : "Check"}
                  </button>
                ))}
              </div>
              {sheet.method === "CHECK" && (
                <div>
                  <label className="block text-[12px] font-semibold text-text-primary mb-1" htmlFor="check-ref">Check number or note (optional)</label>
                  <input id="check-ref" value={checkRef} onChange={(e) => setCheckRef(e.target.value)} className={field} />
                </div>
              )}
              {off && (
                <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-warn-surface text-warn-text border border-warn-border">
                  Heads up: this event&apos;s price is {money(expected as number)}, but {sheetRow.name} is recorded at {money(sheetRow.amountDue)}. Cancel and reprice if {money(sheetRow.amountDue)} is wrong.
                </p>
              )}
              {sheetErr && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{sheetErr}</p>}
            </Sheet>
          );
        })()}

        {sheet?.kind === "recordBulk" && (
          <Sheet
            open
            onClose={() => setSheet(null)}
            title={`Record ${money(selCash.total)} cash from ${selCash.count} ${selCash.count === 1 ? "person" : "people"}?`}
            description="Each one is marked paid for what they're recorded as owing, and gets a receipt."
            footer={<>
              <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setSheet(null)}>Cancel</button>
              <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={busy === "recordBulk" || selCash.count === 0} onClick={recordBulk}>
                {busy === "recordBulk" ? "Recording…" : `Record ${money(selCash.total)}`}
              </button>
            </>}
          >
            <ul className="text-[13.5px] text-text-primary divide-y divide-hairline">
              {allRows.filter((r) => r.registrationId && selCash.ids.includes(r.registrationId)).map((r) => (
                <li key={r.id} className="py-2 flex justify-between tabular-nums"><span>{r.name}</span><span>{money(r.amountDue)}</span></li>
              ))}
            </ul>
            {selCash.skipped.length > 0 && (
              <p className="mt-2 text-[12.5px] text-text-muted">Not included — nothing recorded to settle: {selCash.skipped.join(", ")}.</p>
            )}
            {sheetErr && <p className="mt-3 text-[12.5px] text-danger-text">{sheetErr}</p>}
          </Sheet>
        )}

        {sheet?.kind === "remove" && sheetRow && (() => {
          const plan = removePlan(sheetRow, { transactionId: detail(sheetRow)?.transactionId ?? null });
          return plan.kind === "blocked" ? (
            <Sheet open onClose={() => setSheet(null)} title={`${sheetRow.name} can't be removed yet`} footer={<button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setSheet(null)}>OK</button>}>
              <p className="text-[14px] text-text-primary">{plan.reason}</p>
            </Sheet>
          ) : (
            <Sheet
              open
              onClose={() => setSheet(null)}
              title={`Remove ${sheetRow.name}?`}
              footer={<>
                <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setSheet(null)}>Keep them</button>
                <button type="button" className={`${btn} bg-danger-text text-white`} disabled={busy === "remove"} onClick={() => remove(sheetRow)}>
                  {busy === "remove" ? "Removing…" : "Remove"}
                </button>
              </>}
            >
              <p className="text-[14px] text-text-primary">{plan.note}</p>
              <p className="mt-2 text-[12.5px] text-text-muted">The record stays in history under “Show removed”.</p>
              {sheetErr && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{sheetErr}</p>}
            </Sheet>
          );
        })()}

        {sheet?.kind === "chargeNow" && sheetRow && (
          <Sheet
            open
            onClose={() => setSheet(null)}
            title={`Charge ${sheetRow.name}'s saved card ${money(sheetRow.scheduledAmount)} now?`}
            description={`Their card was set to be charged ${sheetRow.scheduledAt ? `on ${shortDate(sheetRow.scheduledAt)}` : "on the event's charge date"} — that date has arrived. They get a receipt.`}
            footer={<>
              <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setSheet(null)}>Cancel</button>
              <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={busy === "charge"} onClick={() => chargeNow(sheetRow)}>
                {busy === "charge" ? "Charging…" : `Charge ${money(sheetRow.scheduledAmount)}`}
              </button>
            </>}
          >
            {sheetErr && <p className="text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{sheetErr}</p>}
          </Sheet>
        )}

        {sheet?.kind === "addEmail" && sheetRow && (() => {
          const dt = detail(sheetRow);
          const needsGuardian = dt?.member?.isMinor !== false && !dt?.member?.guardianName;
          return (
            <Sheet
              open
              onClose={() => setSheet(null)}
              title={`Email for ${sheetRow.name}`}
              description="Saved on their member record, so every future bill and receipt goes there too. A parent's address is fine."
              footer={<>
                <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setSheet(null)}>Cancel</button>
                <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={busy === "email" || !emailInput.trim()} onClick={() => saveEmail(sheetRow)}>
                  {busy === "email" ? "Saving…" : "Save"}
                </button>
              </>}
            >
              <label className="block text-[12px] font-semibold text-text-primary mb-1" htmlFor="fix-email">Email</label>
              <input id="fix-email" type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} className={field} />
              {needsGuardian && (
                <>
                  <label className="block text-[12px] font-semibold text-text-primary mb-1 mt-3" htmlFor="fix-guardian">Parent/guardian name</label>
                  <input id="fix-guardian" value={guardianInput} onChange={(e) => setGuardianInput(e.target.value)} className={field} />
                </>
              )}
              {sheetErr && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{sheetErr}</p>}
            </Sheet>
          );
        })()}

        {sheet?.kind === "discount" && sheetRow && (() => {
          const dt = detail(sheetRow);
          const has = !!(dt?.discountCode || dt?.discountLabel);
          return (
            <Sheet
              open
              onClose={() => setSheet(null)}
              title={`Discount for ${sheetRow.name}`}
              description={has ? `Now: ${dt?.discountLabel || dt?.discountCode}${Number(dt?.discountAmount ?? 0) > 0 ? ` · −${money(Number(dt?.discountAmount))}` : ""}` : "The code is checked against this event's current price."}
              footer={<>
                {has && <button type="button" className={`${btn} border border-app-border text-danger-text`} disabled={busy === "discount"} onClick={() => setDiscount(sheetRow, null)}>Remove discount</button>}
                <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={busy === "discount" || !codeInput.trim()} onClick={() => setDiscount(sheetRow, codeInput.trim())}>
                  {busy === "discount" ? "Saving…" : "Apply"}
                </button>
              </>}
            >
              <label className="block text-[12px] font-semibold text-text-primary mb-1" htmlFor="disc-code">Code</label>
              <input id="disc-code" value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} className={`${field} font-mono uppercase`} />
              {sheetErr && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{sheetErr}</p>}
            </Sheet>
          );
        })()}

        {sheet?.kind === "reprice" && (
          <Sheet
            open
            onClose={() => setSheet(null)}
            title="Reprice every unpaid registration?"
            description="Moves everyone who hasn't paid onto this event's current price. Nobody is charged — this only changes what their next payment link says. Paid, scheduled and awaiting-cash/check people are left alone."
            footer={<>
              <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setSheet(null)}>Cancel</button>
              <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={busy === "reprice"} onClick={reprice}>
                {busy === "reprice" ? "Repricing…" : "Reprice"}
              </button>
            </>}
          >
            {sheetErr && <p className="text-[12.5px] text-danger-text">{sheetErr}</p>}
          </Sheet>
        )}
      </div>
    </div>
  );
}
