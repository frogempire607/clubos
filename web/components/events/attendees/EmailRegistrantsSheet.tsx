"use client";

// "Email registrants": one message to everyone registered for this event.
// The server decides who that is (POST /api/events/[id]/email-registrants,
// from the same ledger as the list) and this sheet shows the count BEFORE
// anything is sent: how many people, how many addresses after families are
// merged, and who has no address. Sending goes through the club's normal
// email path, so the unsubscribe list applies.

import { useEffect, useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import { useSingleFlight } from "@/lib/useSingleFlight";

type Audience = "all" | "paid";
type Counts = { people: number; addresses: number; noEmail: number };

const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";
const field = "w-full min-h-11 px-3 py-2 border border-app-border rounded-[10px] text-[14px] bg-surface text-text-primary";

export default function EmailRegistrantsSheet({
  eventId,
  eventName,
  onClose,
  onSent,
}: {
  eventId: string;
  eventName: string;
  onClose: () => void;
  onSent: (text: string) => void;
}) {
  const [audience, setAudience] = useState<Audience>("all");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [noEmail, setNoEmail] = useState<string[]>([]);
  const [subject, setSubject] = useState(eventName);
  const [message, setMessage] = useState("");
  const [err, setErr] = useState("");
  const flight = useSingleFlight();
  const sending = flight.isBusy("send");
  // One key for this open sheet: a second tap, or a retry after a dropped
  // connection, reaches the same batch and sends nothing twice.
  const clientKey = useRef<string>(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

  useEffect(() => {
    let live = true;
    setCounts(null);
    fetch(`/api/events/${eventId}/email-registrants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience, preview: true }),
    })
      .then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
      .then(({ ok, d }) => {
        if (!live) return;
        if (!ok) return setErr(typeof d.error === "string" ? d.error : "Couldn't work out who this would reach.");
        setErr("");
        setCounts(d.counts as Counts);
        setNoEmail(Array.isArray(d.noEmail) ? d.noEmail : []);
      })
      .catch(() => live && setErr("Couldn't work out who this would reach. Check your connection."));
    return () => { live = false; };
  }, [eventId, audience]);

  const send = () =>
    flight.run("send", async () => {
      setErr("");
      try {
        const res = await fetch(`/api/events/${eventId}/email-registrants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audience, subject: subject.trim(), message: message.trim(), clientKey: clientKey.current }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return setErr(typeof d.error === "string" ? d.error : "The email was not sent.");
        const r = d.results as { sent: number; queued: number; skipped: number; duplicate: number; failed: number };
        const parts = [
          r.sent ? `Sent to ${r.sent}` : "",
          r.queued ? `${r.queued} queued and going out over the next few minutes` : "",
          r.skipped ? `${r.skipped} skipped (unsubscribed)` : "",
          r.failed ? `${r.failed} failed` : "",
        ].filter(Boolean);
        onSent(parts.length ? `${parts.join(" · ")}.` : "Already sent.");
      } catch {
        setErr("The connection dropped. Tap Send again: nobody will get it twice.");
      }
    });

  const choice = (on: boolean) =>
    `min-h-11 px-3 py-2 rounded-[10px] border text-left text-[14px] ${on ? "border-brand bg-info-surface text-text-primary font-semibold" : "border-app-border text-text-primary"}`;
  const ready = !!counts && counts.addresses > 0 && subject.trim().length > 0 && message.trim().length > 0;

  return (
    <Sheet
      open
      onClose={onClose}
      title="Email registrants"
      description="Cancelled registrations are never included. A family with two athletes gets one email."
      footer={
        <>
          <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={onClose}>Cancel</button>
          <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={!ready || sending} onClick={send}>
            {sending ? "Sending…" : counts ? `Send to ${counts.addresses} ${counts.addresses === 1 ? "address" : "addresses"}` : "Send"}
          </button>
        </>
      }
    >
      <fieldset>
        <legend className="text-[12px] font-semibold text-text-primary mb-1.5">Who</legend>
        <div className="flex flex-col gap-2">
          <button type="button" aria-pressed={audience === "all"} className={choice(audience === "all")} onClick={() => setAudience("all")}>
            Everyone registered
          </button>
          <button type="button" aria-pressed={audience === "paid"} className={choice(audience === "paid")} onClick={() => setAudience("paid")}>
            Paid only (includes anyone covered by a membership)
          </button>
        </div>
        <p className="mt-2 text-[12.5px] text-text-muted" role="status">
          {!counts
            ? "Counting…"
            : `${counts.people} ${counts.people === 1 ? "person" : "people"} · ${counts.addresses} ${counts.addresses === 1 ? "address" : "addresses"}${counts.noEmail ? ` · ${counts.noEmail} with no email on file` : ""}`}
        </p>
        {noEmail.length > 0 && (
          <p className="text-[12.5px] text-warn-text">No email for: {noEmail.slice(0, 8).join(", ")}{noEmail.length > 8 ? ` and ${noEmail.length - 8} more` : ""}.</p>
        )}
      </fieldset>

      <label className="block mt-4">
        <span className="text-[12px] font-semibold text-text-primary">Subject</span>
        <input className={`${field} mt-1`} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="block mt-3">
        <span className="text-[12px] font-semibold text-text-primary">Message</span>
        <textarea className={`${field} mt-1`} rows={7} value={message} maxLength={10000} onChange={(e) => setMessage(e.target.value)} placeholder="Doors open at 7:30. Park behind the building." />
      </label>
      <p className="mt-2 text-[12.5px] text-text-muted">Sent from your club&apos;s email name with your logo, contact details and an unsubscribe link. Anyone who has unsubscribed from club emails is skipped.</p>
      {err && <p className="mt-2 text-[13px] text-danger-text" role="alert">{err}</p>}
    </Sheet>
  );
}
