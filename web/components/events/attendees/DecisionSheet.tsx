"use client";

// Approve · Propose a change · Decline — the coach decision for one attendee,
// in a Sheet. Ported from the retired Registrations modal's review queue; the
// routes, bodies and consequences are unchanged:
//   POST /api/events/[id]/registrations/[regId]/approve         {}
//   POST /api/events/[id]/registrations/[regId]/propose-change  { changes, message?, priceDelta? }
//   POST /api/events/[id]/registrations/[regId]/decline         { reason }
// The money consequence of approving is stated before the button, because an
// approve can charge a saved card in the same request.

import { useEffect, useState } from "react";
import Sheet from "@/components/Sheet";
import {
  DEFAULT_EXTRA_ENTRY_LABEL,
  proposalNotePlaceholder,
  labelForChangeKey,
  type CategoryField,
} from "@/lib/eventCategories";
import type { RegDetail, RegistrationsPayload } from "./types";

export type DecisionMode = "approve" | "propose" | "decline";

type Roster = {
  rosters: { id: string; label: string }[];
  positions: { id: string; label: string }[];
  entries: { id: string; registrationId: string; rosterId: string | null; positionId: string | null; status: string }[];
};

const input = "w-full min-h-11 px-3 py-2 border border-app-border rounded-[10px] text-[14px] bg-surface text-text-primary";
const label = "block text-[12px] font-semibold text-text-primary mb-1";

export default function DecisionSheet({
  eventId,
  reg,
  owed,
  mode,
  regs,
  onClose,
  onDone,
}: {
  eventId: string;
  reg: RegDetail;
  /** What this registrant owes — the ledger's figure, never recomputed here. */
  owed: number;
  mode: DecisionMode;
  regs: RegistrationsPayload;
  onClose: () => void;
  /** Called with a message to show on the screen after a decision lands. */
  onDone: (msg: { ok: boolean; text: string }) => void;
}) {
  const ev = regs.event;
  const categoryFields: CategoryField[] = ev.categoryFields ?? [];
  const formFields = ev.registrationForm ?? [];
  const extraEntryLabel = ev.extraEntryLabel || DEFAULT_EXTRA_ENTRY_LABEL;
  const notePlaceholder = ev.proposalNotePlaceholder || proposalNotePlaceholder(categoryFields);

  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [categoryValues, setCategoryValues] = useState<Record<string, string>>({});
  const [session, setSession] = useState("");
  const [addExtraEntry, setAddExtraEntry] = useState(false);
  const [priceDelta, setPriceDelta] = useState("");
  const [entryMoves, setEntryMoves] = useState<Record<string, string>>({});
  const [roster, setRoster] = useState<Roster | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (mode !== "propose") return;
    let alive = true;
    fetch(`/api/events/${eventId}/roster`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.definition) setRoster({ rosters: d.definition.rosters, positions: d.definition.positions, entries: d.entries ?? [] });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [eventId, mode]);

  const answers = Object.entries(reg.formResponses ?? {})
    .filter(([k]) => !k.startsWith("__"))
    .map(([k, v]) => {
      const l = categoryFields.find((f) => f.key === k)?.label ?? formFields.find((f) => f.id === k)?.label ?? labelForChangeKey(k);
      return `${l}: ${String(v)}`;
    });

  const consequence =
    reg.paymentMethod === "APPROVAL_CHARGE" && owed > 0
      ? `This charges ${reg.name}'s saved card $${owed.toFixed(2)} now.`
      : reg.paymentMethod === "INVOICE" && owed > 0
        ? `This emails ${reg.name} a payment link for $${owed.toFixed(2)}.`
        : reg.paymentMethod === "CASH" || reg.paymentMethod === "CHECK"
          ? `${reg.name} will be confirmed, and owes $${owed.toFixed(2)} at the event.`
          : `${reg.name} will be confirmed for this event.`;

  async function post(action: string, body: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/events/${eventId}/registrations/${reg.id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(d.message || (typeof d.error === "string" ? d.error : "") || "That didn't go through.");
      return;
    }
    // The decision stands even when the money side didn't — but it is said out loud.
    if (d.invoiceError) onDone({ ok: false, text: `Approved — but the payment link didn't send: ${d.invoiceError}` });
    else if (d.chargeError) onDone({ ok: false, text: `Approved — but the card charge didn't go through: ${d.chargeError}` });
    else if (d.refund?.error) onDone({ ok: false, text: `Declined — but the refund failed: ${d.refund.error}. Check Stripe.` });
    else
      onDone({
        ok: true,
        text: action === "approve" ? `${reg.name} approved.` : action === "decline" ? `${reg.name} declined — the family was told why.` : `Change sent to ${reg.name}'s family.`,
      });
  }

  function submitProposal() {
    const changes: Record<string, unknown> = {};
    for (const f of categoryFields) {
      const v = (categoryValues[f.key] ?? "").trim();
      if (v) changes[f.key] = v;
    }
    if (session.trim()) changes.session = session.trim();
    if (addExtraEntry) changes.extraEntry = true;
    for (const [entryId, v] of Object.entries(entryMoves)) if (v) changes[`entry:${entryId}`] = v;
    if (Object.keys(changes).length === 0) {
      setErr("Propose at least one change.");
      return;
    }
    const dropping = Object.values(entryMoves).includes("DROP");
    post("propose-change", {
      changes,
      message: note.trim() || undefined,
      priceDelta: (addExtraEntry || dropping) && priceDelta ? parseFloat(priceDelta) : undefined,
    });
  }

  const title = mode === "approve" ? `Approve ${reg.name}?` : mode === "decline" ? `Decline ${reg.name}` : `Propose a change for ${reg.name}`;
  const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";

  const footer =
    mode === "approve" ? (
      <>
        <button type="button" onClick={onClose} className={`${btn} border border-app-border text-text-primary`}>Cancel</button>
        <button type="button" onClick={() => post("approve", {})} disabled={busy} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
          {busy ? "Approving…" : "Approve"}
        </button>
      </>
    ) : mode === "decline" ? (
      <>
        <button type="button" onClick={onClose} className={`${btn} border border-app-border text-text-primary`}>Cancel</button>
        <button
          type="button"
          onClick={() => post("decline", { reason: reason.trim() })}
          disabled={!reason.trim() || busy}
          className={`${btn} bg-danger-text text-white`}
        >
          {busy ? "Declining…" : "Decline and notify"}
        </button>
      </>
    ) : (
      <>
        <button type="button" onClick={onClose} className={`${btn} border border-app-border text-text-primary`}>Cancel</button>
        <button type="button" onClick={submitProposal} disabled={busy} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
          {busy ? "Sending…" : "Send to the parent"}
        </button>
      </>
    );

  return (
    <Sheet open onClose={onClose} title={title} width={560} description={answers.length > 0 ? answers.join(" · ") : "No form answers"} footer={footer}>
      {mode === "approve" && <p className="text-[14px] text-text-primary">{consequence}</p>}

      {mode === "decline" && (
        <div>
          <label className={label} htmlFor="decline-reason">Why can&apos;t you take this registration?</label>
          <textarea id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className={input} />
          <p className="text-[12px] text-text-muted mt-1">
            This goes to the family word for word.
            {(reg.status === "PAID" || Number(reg.amountPaid ?? 0) > 0) && " They already paid, so declining refunds them in full."}
          </p>
        </div>
      )}

      {mode === "propose" && (
        <div className="space-y-3">
          <p className="text-[12.5px] text-text-muted">Nothing changes until the parent accepts. Leave a field blank to keep what they signed up for.</p>
          {categoryFields.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {categoryFields.map((f) => (
                <div key={f.key}>
                  <label className={label}>{f.label}</label>
                  {f.options.length > 0 ? (
                    <select value={categoryValues[f.key] ?? ""} onChange={(e) => setCategoryValues((v) => ({ ...v, [f.key]: e.target.value }))} className={input}>
                      <option value="">No change</option>
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input value={categoryValues[f.key] ?? ""} onChange={(e) => setCategoryValues((v) => ({ ...v, [f.key]: e.target.value }))} placeholder="No change" className={input} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-text-muted">This event has no entry categories set, so there&apos;s nothing to swap — you can still move them to another session, add an entry, or send a note.</p>
          )}
          {roster && roster.rosters.length > 0 && (() => {
            const mine = roster.entries.filter((x) => x.registrationId === reg.id);
            if (mine.length === 0) return null;
            const labelOf = (rid: string | null, pid: string | null) =>
              `${roster.positions.find((p) => p.id === pid)?.label ?? "?"} · ${roster.rosters.find((x) => x.id === rid)?.label ?? "?"}`;
            return mine.map((en, i) => (
              <div key={en.id}>
                <label className={label}>
                  {mine.length > 1 ? `Entry ${i + 1}` : "Spot"} — now {labelOf(en.rosterId, en.positionId)}{en.status === "WAITLIST" ? " (waitlist)" : ""}
                </label>
                <select value={entryMoves[en.id] ?? ""} onChange={(e) => setEntryMoves((m) => ({ ...m, [en.id]: e.target.value }))} className={input}>
                  <option value="">Keep this spot</option>
                  {roster.rosters.map((ro) => (
                    <optgroup key={ro.id} label={ro.label}>
                      {roster.positions.map((po) => (
                        <option key={po.id} value={`${ro.id}|${po.id}`} disabled={ro.id === en.rosterId && po.id === en.positionId}>
                          Move to {po.label} · {ro.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {mine.length > 1 && <option value="DROP">Remove this entry</option>}
                </select>
              </div>
            ));
          })()}
          <div>
            <label className={label}>Session</label>
            <input value={session} onChange={(e) => setSession(e.target.value)} placeholder="No change" className={input} />
          </div>
          <label className="flex items-start gap-3 p-3 rounded-[12px] border border-app-border cursor-pointer min-h-11">
            <input type="checkbox" checked={addExtraEntry} onChange={(e) => { setAddExtraEntry(e.target.checked); if (!e.target.checked) setPriceDelta(""); }} className="mt-1 h-4 w-4" />
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium text-text-primary">{extraEntryLabel}</span>
              <span className="block text-[12px] text-text-muted">Usually adds an entry fee — put it below and the parent agrees to that exact amount before it is charged.</span>
            </span>
          </label>
          {(addExtraEntry || Object.values(entryMoves).includes("DROP")) && (
            <div>
              <label className={label}>{addExtraEntry ? "Additional fee" : "Price change (negative to lower what they owe, e.g. -85)"}</label>
              <input type="number" step="0.01" {...(addExtraEntry ? { min: "0" } : {})} value={priceDelta} onChange={(e) => setPriceDelta(e.target.value)} placeholder="0.00" className={`${input} sm:w-40`} />
            </div>
          )}
          <div>
            <label className={label}>Note to the parent</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={notePlaceholder} className={input} />
          </div>
        </div>
      )}

      {err && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{err}</p>}
    </Sheet>
  );
}
