"use client";

// "+ Add attendee" — expands under the Attendees header (design handoff 1c).
//
// Who: a member search, or a new name (created as a member first via
// POST /api/members — a person on an event roster is a member record).
// Taking: the whole event, or chosen sessions when the event sells them.
// Paying by: ONLY the event's own payment methods (lib/eventAttendeeActions
// .staffAddPaymentPlan), with a note saying so.
//
// Adding makes ONE request that creates the spot and the bill together:
//   free event            → POST /api/events/[id]/bookings   (no bill exists)
//   everything else       → POST /api/events/[id]/charge     (registration + booking)
// "Card — email a payment link" then hands the new registration to the
// review-before-send step (bill-registrants), like every other unpaid row.

import { useEffect, useMemo, useState } from "react";
import {
  buildAddRequest,
  sellableSessions,
  sessionsTotal,
  staffAddPaymentPlan,
  takingOptions,
  STAFF_METHOD_LABELS,
  type AddEventShape,
  type StaffAddMethod,
  type TakingOption,
} from "@/lib/eventAttendeeActions";
import { EVENT_PAYMENT_METHOD_LABELS } from "@/lib/eventPayments";
import { money } from "./types";

type MemberLite = { id: string; firstName: string; lastName: string; email?: string | null };
type EventDetail = AddEventShape & { name: string; sessions?: { id: string; name?: string | null; price?: unknown; startsAt?: string | null }[] };

const field = "w-full min-h-11 px-3 py-2 border border-app-border rounded-[10px] text-[14px] bg-surface text-text-primary";
const lbl = "block text-[12px] font-semibold text-text-primary mb-1";

export type AddResult = { text: string; invoiceRegistrationId?: string };

export default function AddAttendeeForm({
  eventId,
  excludeMemberIds,
  onAdded,
  onCancel,
}: {
  eventId: string;
  excludeMemberIds: Set<string>;
  onAdded: (r: AddResult) => void;
  onCancel: () => void;
}) {
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [members, setMembers] = useState<MemberLite[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<MemberLite | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [taking, setTaking] = useState<TakingOption["key"] | null>(null);
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [method, setMethod] = useState<StaffAddMethod | null>(null);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    let alive = true;
    Promise.all([fetch(`/api/events/${eventId}`), fetch("/api/members")])
      .then(async ([e, m]) => {
        if (!e.ok) throw new Error("Couldn't load this event.");
        const ev = (await e.json()) as EventDetail;
        const ms = m.ok ? ((await m.json()) as MemberLite[]) : [];
        if (!alive) return;
        setEvent(ev);
        setMembers(Array.isArray(ms) ? ms : []);
        const opts = takingOptions(ev, new Date());
        setTaking(opts[0]?.key ?? null);
        const plan = staffAddPaymentPlan(ev);
        if (plan.kind === "PAID") setMethod(plan.methods[0] ?? null);
      })
      .catch((x) => alive && setLoadErr(x instanceof Error ? x.message : "Couldn't load this event."));
    return () => { alive = false; };
  }, [eventId]);

  const plan = event ? staffAddPaymentPlan(event) : null;
  const options = event ? takingOptions(event, now) : [];
  const sessions = event ? sellableSessions(event, now) : [];

  const q = query.trim().toLowerCase();
  const matches = q.length === 0 || picked
    ? []
    : members
        .filter((m) => !excludeMemberIds.has(m.id))
        .filter((m) => `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q))
        .slice(0, 6);
  const nameParts = query.trim().split(/\s+/).filter(Boolean);
  const canCreateNew = !picked && nameParts.length >= 2;

  const quoted =
    taking === "SESSIONS" ? sessionsTotal(event ?? {}, sessionIds, now) : options.find((o) => o.key === taking)?.amount ?? null;

  async function submit() {
    if (!event) return;
    setErr("");
    let memberId = picked?.id ?? "";
    setBusy(true);
    try {
      if (!memberId) {
        if (!canCreateNew) { setErr("Pick a member, or type their first and last name."); return; }
        const email = newEmail.trim();
        if (!email) { setErr("Add an email for someone new — it's where their confirmation and any bill go."); return; }
        const res = await fetch("/api/members", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName: nameParts[0], lastName: nameParts.slice(1).join(" "), email, status: "PROSPECT" }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.id) { setErr(typeof d.error === "string" ? d.error : "Couldn't create that person."); return; }
        memberId = d.id;
      }
      const built = buildAddRequest(event, { memberId, taking, sessionIds, method, reference });
      if (!built.ok) { setErr(built.error); return; }
      const res = await fetch(`/api/events/${eventId}/${built.req.route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.req.body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Couldn't add them."); return; }
      const who = picked ? `${picked.firstName} ${picked.lastName}` : nameParts.join(" ");
      const wait = d.status === "WAITLISTED" ? " (on the waitlist — the event is full)" : "";
      if (d.coveredByMembership) onAdded({ text: `${who} added${wait} — covered by their membership.` });
      else if (d.variableCost) onAdded({ text: `${who} added${wait}. They'll be invoiced with everyone once the total is set.` });
      else if (d.recordedManually) onAdded({ text: `${who} added${wait} and ${money(Number(d.amount ?? 0))} recorded — receipt sent.` });
      else if (d.billedLater && d.registrationId) onAdded({ text: `${who} added${wait}, owing ${money(Number(d.amount ?? 0))}.`, invoiceRegistrationId: d.registrationId });
      else onAdded({ text: `${who} added${wait}.` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 sm:px-5 py-4 border-b border-app-border bg-info-surface">
      <div className="text-[15px] font-semibold text-text-primary mb-3">Add an attendee</div>
      {loadErr ? (
        <p className="text-[12.5px] text-danger-text">{loadErr}</p>
      ) : !event || !plan ? (
        <p className="text-[12.5px] text-text-muted">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1.2fr_1.2fr_auto] gap-3 sm:items-end">
            {/* Who */}
            <div className="relative">
              <label className={lbl} htmlFor="add-who">Who</label>
              {picked ? (
                <div className={`${field} flex items-center justify-between gap-2`}>
                  <span className="truncate">{picked.firstName} {picked.lastName}</span>
                  <button type="button" onClick={() => { setPicked(null); setQuery(""); }} className="text-[12.5px] text-brand min-h-11 px-2 -mr-2">Change</button>
                </div>
              ) : (
                <input
                  id="add-who"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search members or type a new name…"
                  autoComplete="off"
                  className={field}
                />
              )}
              {matches.length > 0 && (
                <ul className="absolute z-10 left-0 right-0 mt-1 rounded-[10px] border border-app-border bg-surface shadow-lg overflow-hidden">
                  {matches.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => { setPicked(m); setQuery(""); }} className="w-full text-left px-3 min-h-11 text-[14px] text-text-primary hover:bg-app-bg">
                        {m.firstName} {m.lastName}
                        {m.email && <span className="text-[12px] text-text-muted"> · {m.email}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Taking */}
            <div>
              <label className={lbl} htmlFor="add-taking">Taking</label>
              {plan.kind === "PAID" && options.length > 0 ? (
                <select id="add-taking" value={taking ?? ""} onChange={(e) => setTaking(e.target.value as TakingOption["key"])} className={field}>
                  {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              ) : (
                <div className={`${field} flex items-center text-text-muted`}>Whole event</div>
              )}
            </div>

            {/* Paying by */}
            <div>
              <label className={lbl} htmlFor="add-pay">Paying by</label>
              {plan.kind === "PAID" && plan.methods.length > 0 ? (
                <select id="add-pay" value={method ?? ""} onChange={(e) => setMethod(e.target.value as StaffAddMethod)} className={field}>
                  {plan.methods.map((m) => <option key={m} value={m}>{STAFF_METHOD_LABELS[m]}</option>)}
                </select>
              ) : (
                <div className={`${field} flex items-center text-text-muted`}>{plan.kind === "PAID" ? "No option staff can use" : "Nothing to collect now"}</div>
              )}
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={busy || (plan.kind === "PAID" && !method)}
              className="min-h-11 px-4 rounded-[10px] bg-brand text-white text-[14px] font-semibold hover:bg-brand-hover disabled:opacity-50 whitespace-nowrap"
            >
              {busy ? "Adding…" : quoted != null && plan.kind === "PAID" ? `Add · ${money(quoted)}` : "Add attendee"}
            </button>
          </div>

          {canCreateNew && matches.length === 0 && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1.4fr_2.4fr] gap-3 sm:items-end">
              <div>
                <label className={lbl} htmlFor="add-email">Email for {nameParts.join(" ")} (new)</label>
                <input id="add-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@example.com" className={field} />
              </div>
              <p className="text-[12px] text-text-muted pb-2">Not a member yet — they&apos;ll be added as a new person, then booked.</p>
            </div>
          )}

          {taking === "SESSIONS" && (
            <fieldset className="mt-3">
              <legend className={lbl}>Sessions</legend>
              <div className="flex flex-wrap gap-2">
                {sessions.map((s) => {
                  const on = sessionIds.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSessionIds((ids) => (on ? ids.filter((x) => x !== s.id) : [...ids, s.id]))}
                      className={`min-h-11 px-3 rounded-full text-[13px] border tabular-nums ${on ? "border-brand bg-prospect-surface text-prospect-text font-semibold" : "border-app-border bg-surface text-text-primary"}`}
                    >
                      {s.name || new Date(s.startsAt ?? "").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · {money(Number(s.price))}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {method === "CHECK" && (
            <div className="mt-3 sm:w-72">
              <label className={lbl} htmlFor="add-ref">Check number (optional)</label>
              <input id="add-ref" value={reference} onChange={(e) => setReference(e.target.value)} className={field} />
            </div>
          )}

          <p className="mt-3 text-[12px] text-text-muted">
            {plan.note}
            {plan.kind === "PAID" && plan.unavailable.map((u) => ` ${EVENT_PAYMENT_METHOD_LABELS[u.method]}: ${u.reason}`).join("")}
            {plan.kind === "PAID" && method === "INVOICE" && " You'll review the link before it's emailed."}
            {plan.kind === "PAID" && (method === "CASH" || method === "CHECK" || method === "TERMINAL") && " Records the payment now and sends a receipt — no card is charged."}
          </p>
          <div className="mt-2 sm:hidden">
            <button type="button" onClick={onCancel} className="min-h-11 text-[13.5px] text-text-muted">Cancel</button>
          </div>
        </>
      )}
      {err && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{err}</p>}
    </div>
  );
}
