"use client";

// Refund one registration: what they paid, what has already gone back, which
// card it goes to, and how much to send. Used from the registrant sheet, the
// Removed section, and as the second step of "Remove and refund" (`remove`),
// where the person only comes off the event once the refund has gone through.
//
// Every number is worked out again on the server (lib/eventRefundServer.ts);
// this sheet tells it what it saw, so a second tap is refused, not repeated.

import { useCallback, useEffect, useState } from "react";
import Sheet from "@/components/Sheet";
import { useSingleFlight } from "@/lib/useSingleFlight";
import { centsText, parseDollars, refundDestination, refundOptions, resolveRefund, type RefundMode } from "@/lib/eventRefunds";
import type { RefundSheetData } from "@/lib/eventRefundServer";

const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";

export default function RefundSheet({
  eventId,
  registrationId,
  name,
  remove = false,
  onClose,
  onDone,
}: {
  eventId: string;
  registrationId: string;
  name: string;
  /** "Remove and refund". */
  remove?: boolean;
  onClose: () => void;
  onDone: (msg: { ok: boolean; text: string }) => void;
}) {
  const [data, setData] = useState<RefundSheetData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<RefundMode | null>(null);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const flight = useSingleFlight();
  const busy = flight.isBusy("refund");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${registrationId}/refund`, { cache: "no-store" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setLoadError(typeof d.error === "string" ? d.error : "We couldn't load this payment. Close this and try again.");
      setData(d as RefundSheetData);
      setMode((m) => m ?? refundOptions((d as RefundSheetData).facts)[0]?.mode ?? null);
    } catch {
      setLoadError("We couldn't load this payment. Check your connection and try again.");
    }
  }, [eventId, registrationId]);
  useEffect(() => { load(); }, [load]);

  const options = data && !data.blocked ? refundOptions(data.facts) : [];
  const customCents = parseDollars(custom);
  const resolved = data && mode ? resolveRefund(mode, customCents, data.facts) : null;
  const amount = resolved?.ok ? resolved.cents : null;

  async function submit() {
    if (!data || !mode || amount == null) return;
    setError("");
    await flight.run("refund", async () => {
      try {
        const body = { mode, amountCents: mode === "custom" ? amount : null, expectedRefundedCents: data.facts.refundedCents };
        const res = await fetch(
          remove ? `/api/events/${eventId}/registrations/${registrationId}` : `/api/events/${eventId}/registrations/${registrationId}/refund`,
          { method: remove ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(remove ? { paid: "refund", ...body } : body) },
        );
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          const why = typeof d.error === "string" ? d.error : "The refund didn't go through. Nothing was refunded.";
          setError(remove ? `${why} ${name} is still registered.` : why);
          // What's left may have changed under us (that can be why it was refused).
          if (d.code === "CHANGED" || d.code === "BUSY" || d.code === "ALREADY_REFUNDED" || d.code === "UNKNOWN") load();
          return;
        }
        const text = typeof d.message === "string" ? d.message : `${centsText(amount)} refunded.`;
        onDone({ ok: remove ? d.removed !== false : true, text: remove && d.removed !== false ? `${name} removed. ${text}` : `${name}: ${text}` });
      } catch {
        setError("We lost the connection, so we can't tell yet if the refund went through. Close this and open it again to see. Trying again won't refund them twice.");
      }
    });
  }

  const f = data?.facts;
  return (
    <Sheet
      open
      onClose={onClose}
      dismissable={!busy}
      title={remove ? `Remove and refund ${name}?` : `Refund ${name}`}
      description={data?.eventName}
      footer={
        data && !data.blocked ? (
          <>
            <button type="button" className={`${btn} border border-app-border text-text-primary`} disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className={`${btn} bg-danger-text text-white`} disabled={busy || amount == null} onClick={submit}>
              {busy ? "Refunding…" : `${remove ? "Remove and refund" : "Refund"}${amount != null ? ` ${centsText(amount)}` : ""}`}
            </button>
          </>
        ) : (
          <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={onClose}>Close</button>
        )
      }
    >
      {loadError ? (
        <p role="alert" className="text-[14px] text-danger-text">{loadError}</p>
      ) : !data || !f ? (
        <p className="text-[14px] text-text-muted">Loading the payment…</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 tabular-nums">
            {([["Paid", f.paidCents], ["Already refunded", f.refundedCents], ["Left to refund", data.leftCents]] as [string, number][]).map(([k, v]) => (
              <div key={k} className="rounded-[10px] bg-app-bg px-3 py-2">
                <dt className="text-[12px] text-text-muted">{k}</dt>
                <dd className="text-[15px] font-semibold text-text-primary">{centsText(v)}</dd>
              </div>
            ))}
          </dl>

          {data.blocked ? (
            <p className="mt-3 text-[14px] text-text-primary">{data.blocked}</p>
          ) : (
            <>
              <fieldset className="mt-4 space-y-2" disabled={busy}>
                <legend className="text-[12.5px] font-semibold text-text-primary mb-1.5">How much?</legend>
                {options.map((o) => (
                  <label key={o.mode} className={`flex items-start gap-3 min-h-11 px-3 py-2.5 rounded-[10px] border cursor-pointer ${mode === o.mode ? "border-brand bg-prospect-surface" : "border-app-border"}`}>
                    <input type="radio" name="refund-mode" className="mt-1 h-4 w-4" checked={mode === o.mode} onChange={() => { setMode(o.mode); setError(""); }} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-[14px] font-semibold text-text-primary">{o.label}</span>
                        {o.mode !== "custom" && <span className="text-[14px] font-semibold tabular-nums text-text-primary">{centsText(o.cents)}</span>}
                      </span>
                      <span className="block text-[12.5px] text-text-muted">{o.note}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {mode === "custom" && (
                <div className="mt-2">
                  <label htmlFor="refund-amount" className="block text-[12.5px] font-semibold text-text-primary mb-1">Amount to refund</label>
                  <input
                    id="refund-amount"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={custom}
                    disabled={busy}
                    onChange={(e) => { setCustom(e.target.value); setError(""); }}
                    className="w-full min-h-11 px-3 py-2 border border-app-border rounded-[10px] text-[16px] bg-surface text-text-primary tabular-nums"
                  />
                  {custom.trim() !== "" && (
                    customCents == null
                      ? <p className="mt-1 text-[12.5px] text-danger-text">Enter a dollar amount, like 25 or 25.50.</p>
                      : resolved && !resolved.ok && <p className="mt-1 text-[12.5px] text-danger-text">{resolved.error}</p>
                  )}
                </div>
              )}
              <p className="mt-3 text-[13.5px] text-text-primary">{refundDestination(data.via, data.card)} They get a refund receipt by email.</p>
              {remove && <p className="mt-1 text-[12.5px] text-text-muted">{name} comes off the event only if the refund goes through.</p>}
            </>
          )}
          {error && <p role="alert" className="mt-3 text-[13px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{error}</p>}
        </>
      )}
    </Sheet>
  );
}
