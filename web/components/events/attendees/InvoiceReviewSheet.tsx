"use client";

// Review before sending — exactly what each family will be emailed and
// charged, straight from POST /api/events/[id]/bill-registrants {preview:true}.
// Nothing is sent until "Send" (the same call without preview). Carried over
// from the retired Registrations modal; the two-step is the safety, not UI.

import Sheet from "@/components/Sheet";
import { money, type InvoicePreview } from "./types";

export default function InvoiceReviewSheet({
  preview,
  busy,
  onSend,
  onClose,
}: {
  preview: InvoicePreview;
  busy: boolean;
  onSend: () => void;
  onClose: () => void;
}) {
  const n = preview.lines.length;
  const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";
  return (
    <Sheet
      open
      onClose={busy ? () => undefined : onClose}
      title={`Review before sending · ${n} payment link${n === 1 ? "" : "s"}`}
      description="Nothing has been sent yet. This is exactly what each family will be emailed and charged."
      width={620}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={`${btn} border border-app-border text-text-primary`}>Cancel</button>
          <button type="button" onClick={onSend} disabled={busy || n === 0} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
            {busy ? "Sending…" : `Send ${n} link${n === 1 ? "" : "s"} · ${money(preview.grandTotal)}`}
          </button>
        </>
      }
    >
      <ul className="divide-y divide-hairline">
        {preview.lines.map((l) => (
          <li key={l.registrationId} className="py-2.5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-text-primary">
                {l.name}
                {l.alreadyInvoiced && <span className="ml-2 text-[12px] text-text-muted">re-send</span>}
                {l.mismatch && (
                  <span className="ml-2 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-warn-surface text-warn-text">not {money(l.expected)}</span>
                )}
              </div>
              {l.email ? (
                <div className="text-[12px] text-text-muted break-all">→ {l.email}</div>
              ) : (
                <div className="text-[12px] text-warn-text">{l.emailReason ?? "No email on file"} — will be skipped</div>
              )}
            </div>
            <div className="text-right tabular-nums flex-shrink-0">
              <div className="text-[14px] font-semibold text-text-primary">{money(l.chargedTotal)}</div>
              {preview.passProcessingFees && l.processingFee > 0 && (
                <div className="text-[12px] text-text-muted">{money(l.amount)} + {money(l.processingFee)} fee</div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-2 pt-2 border-t border-app-border flex justify-between text-[14px] font-semibold text-text-primary tabular-nums">
        <span>Total across {n}</span>
        <span>{money(preview.grandTotal)}</span>
      </div>
      {preview.passProcessingFees && (
        <p className="text-[12px] text-text-muted mt-2">The club passes processing fees, so the payment page totals more than the amount in the email body. Both are shown above.</p>
      )}
      {preview.mismatched > 0 && (
        <p className="text-[12.5px] mt-2 rounded-[10px] px-3 py-2 bg-warn-surface text-warn-text border border-warn-border">
          {preview.mismatched} of these don&apos;t match the event&apos;s price of {money(preview.expected)}. Reprice first, or send anyway if the amounts are deliberate.
        </p>
      )}
    </Sheet>
  );
}
