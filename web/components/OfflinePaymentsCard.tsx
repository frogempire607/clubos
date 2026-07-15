"use client";

// Outstanding cash/check payments for ONE member + the staff "record payment
// received" flow. Renders nothing when the member has no PENDING offline
// Transactions. Recording (POST /api/members/[id]/offline-payment) is
// billing:full — there is no client-side permission signal here, so the
// button always shows and a 403 from the server is surfaced as its message.
// Used by the billing control center and the Approvals review panel.

import { useCallback, useEffect, useState } from "react";

type PendingRow = {
  id: string;
  amount: number;
  paymentSource: string; // CASH | CHECK
  description: string | null;
  discountCode: string | null;
  createdAt: string;
  stateLabel: string;
};

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function OfflinePaymentsCard({
  memberId,
  onChanged,
  variant = "card",
  className = "",
}: {
  memberId: string;
  onChanged?: () => void;
  /** "card" = standalone surface card; "inline" = compact block for embedding
   *  inside another panel (Approvals review panel). */
  variant?: "card" | "inline";
  className?: string;
}) {
  const [rows, setRows] = useState<PendingRow[] | null>(null);
  const [paidMsg, setPaidMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/members/${memberId}/offline-payment`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRows(Array.isArray(d?.pending) ? (d.pending as PendingRow[]) : []))
      .catch(() => setRows([]));
  }, [memberId]);
  useEffect(() => { load(); }, [load]);

  if (!rows || rows.length === 0) {
    // Keep the success confirmation visible after the last row is recorded.
    if (!paidMsg) return null;
    return (
      <Wrapper variant={variant} className={className}>
        <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2.5 py-1.5">{paidMsg}</p>
      </Wrapper>
    );
  }

  return (
    <Wrapper variant={variant} className={className}>
      <p className="text-xs text-text-muted mb-2">
        The client accepted — the money hasn&apos;t been recorded as received yet. Recording it marks the
        payment as revenue, activates any pending offline membership, and emails the receipt.
      </p>
      {paidMsg && <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2.5 py-1.5 mb-2">{paidMsg}</p>}
      <div className="space-y-2">
        {rows.map((t) => (
          <PendingPaymentRow
            key={t.id}
            memberId={memberId}
            row={t}
            onPaid={(msg) => { setPaidMsg(msg); load(); onChanged?.(); }}
          />
        ))}
      </div>
    </Wrapper>
  );
}

function Wrapper({ variant, className, children }: { variant: "card" | "inline"; className?: string; children: React.ReactNode }) {
  if (variant === "inline") {
    return (
      <div className={`rounded-lg border border-orange-accent/40 bg-orange-accent/5 p-3 ${className ?? ""}`}>
        <p className="text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1.5">Outstanding cash/check</p>
        {children}
      </div>
    );
  }
  return (
    <div className={`bg-surface border border-app-border rounded-xl p-5 ${className ?? ""}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary">Outstanding cash/check</h2>
      </div>
      {children}
    </div>
  );
}

function PendingPaymentRow({
  memberId,
  row,
  onPaid,
}: {
  memberId: string;
  row: PendingRow;
  onPaid: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<"CASH" | "CHECK">(row.paymentSource === "CHECK" ? "CHECK" : "CASH");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState(row.amount.toFixed(2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const record = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/members/${memberId}/offline-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: row.id,
        method,
        reference: reference.trim() || null,
        amountReceived: Number(amount),
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      onPaid(`Paid ✓ — $${row.amount.toFixed(2)} recorded by ${method.toLowerCase()} and receipt sent.`);
    } else if (r.status === 403) {
      setErr(d.error || "You need the full Billing management permission to record payments — ask the club owner.");
    } else {
      setErr(d.error || "Could not record the payment.");
    }
  };

  return (
    <div className="border border-app-border rounded-lg px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm min-w-0">
          <span className="font-medium text-text-primary">${row.amount.toFixed(2)}</span>{" "}
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-accent/15 text-orange-accent font-medium">{row.stateLabel}</span>
          <div className="text-xs text-text-muted mt-0.5">
            {row.description || "Membership payment"}
            {row.discountCode ? ` · ${row.discountCode} Discount Applied` : ""}
            {` · accepted ${fmtDate(row.createdAt)}`}
          </div>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="text-xs border border-app-border rounded-lg px-2.5 py-1.5 text-text-primary hover:bg-app-bg whitespace-nowrap"
          >
            Record payment received
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 pt-2 border-t border-app-border">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="text-xs text-text-muted">Method
              <select value={method} onChange={(e) => setMethod(e.target.value as "CASH" | "CHECK")}
                className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
                <option value="CASH">Cash</option>
                <option value="CHECK">Check</option>
              </select>
            </label>
            <label className="text-xs text-text-muted">{method === "CHECK" ? "Check # / reference" : "Reference (optional)"}
              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120}
                placeholder={method === "CHECK" ? "e.g. 1042" : "note"}
                className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
            </label>
            <label className="text-xs text-text-muted">Amount received ($)
              <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
            </label>
          </div>
          <p className="text-[11px] text-text-muted mt-1.5">
            Must equal the ${row.amount.toFixed(2)} due — adjust the member&apos;s billing first if the agreed amount changed.
          </p>
          {err && <p className="text-xs text-red-600 mt-1.5">{err}</p>}
          <div className="mt-2 flex gap-2 justify-end">
            <button disabled={busy} onClick={() => { setOpen(false); setErr(null); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-primary">Cancel</button>
            <button disabled={busy} onClick={record}
              className="text-xs px-3 py-1.5 rounded-lg bg-charcoal text-white hover:bg-charcoal-hover disabled:opacity-50">
              {busy ? "Recording…" : `Confirm $${Number(amount || 0).toFixed(2)} received`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
