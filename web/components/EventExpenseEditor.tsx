"use client";

// Itemized expense breakdown for an event (tournament cost transparency).
// Self-contained: fetches/creates/deletes via /api/events/[id]/expenses and
// uploads receipts via /api/upload. Mounted in the event editor (ATTEND
// variable-cost section) once the event exists. Items sum into the amount the
// owner bills via "Invoice all unpaid"; per-athlete items are charged in full
// to each registrant, shared items are split across attendees.

import { useEffect, useState } from "react";

type Item = {
  id: string;
  label: string;
  kind: string;
  amount: number;
  description: string | null;
  perAthlete: boolean;
  receiptFileId: string | null;
};

const KINDS: { value: string; label: string }[] = [
  { value: "ENTRY", label: "Entry fee" },
  { value: "COACHING", label: "Coaching fee" },
  { value: "HOTEL", label: "Hotel" },
  { value: "TRANSPORT", label: "Transportation" },
  { value: "UNIFORM", label: "Uniform" },
  { value: "MISC", label: "Miscellaneous" },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

export default function EventExpenseEditor({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState("ENTRY");
  const [amount, setAmount] = useState("");
  const [perAthlete, setPerAthlete] = useState(true);
  const [description, setDescription] = useState("");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await fetch(`/api/events/${eventId}/expenses`);
      if (res.ok) setItems(await res.json());
    } catch {
      /* ignore — section is optional */
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function uploadReceipt(file: File) {
    setUploading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) {
        setError("Receipt upload failed.");
        return;
      }
      const d = await res.json();
      setReceiptUrl(d.url || null);
    } catch {
      setError("Receipt upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function addItem() {
    if (!label.trim() || !amount) {
      setError("Add a label and an amount.");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/events/${eventId}/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: label.trim(),
        kind,
        amount: parseFloat(amount),
        perAthlete,
        description: description.trim() || null,
        receiptFileId: receiptUrl,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not add item.");
      return;
    }
    setLabel("");
    setAmount("");
    setDescription("");
    setReceiptUrl(null);
    setKind("ENTRY");
    setPerAthlete(true);
    load();
  }

  async function removeItem(id: string) {
    const res = await fetch(`/api/events/${eventId}/expenses/${id}`, { method: "DELETE" });
    if (res.ok) setItems((prev) => prev.filter((i) => i.id !== id));
  }

  const perAthleteTotal = items.filter((i) => i.perAthlete).reduce((s, i) => s + i.amount, 0);
  const sharedTotal = items.filter((i) => !i.perAthlete).reduce((s, i) => s + i.amount, 0);

  return (
    <div className="rounded-lg border border-app-border bg-surface p-3 space-y-3">
      <div>
        <p className="text-sm font-medium text-text-primary">Expense breakdown (optional)</p>
        <p className="text-[11px] text-text-muted">
          Itemize the cost so parents see exactly what they&apos;re paying for. Items sum into the
          amount you invoice. <strong>Per-athlete</strong> items are charged to each registrant;
          shared items are split across attendees.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : items.length > 0 ? (
        <div className="divide-y divide-app-border rounded-lg border border-app-border">
          {items.map((i) => (
            <div key={i.id} className="flex items-center gap-2 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary truncate">
                  {i.label}
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-text-muted">
                    {kindLabel(i.kind)}
                  </span>
                </div>
                <div className="text-[11px] text-text-muted flex items-center gap-2 flex-wrap">
                  <span>{i.perAthlete ? "Per athlete" : "Shared / split"}</span>
                  {i.description && <span className="truncate">· {i.description}</span>}
                  {i.receiptFileId && (
                    <a
                      href={i.receiptFileId}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand hover:underline"
                    >
                      Receipt
                    </a>
                  )}
                </div>
              </div>
              <span className="text-sm font-medium text-text-primary tabular-nums">
                ${i.amount.toFixed(2)}
              </span>
              <button
                type="button"
                onClick={() => removeItem(i.id)}
                className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded"
              >
                Remove
              </button>
            </div>
          ))}
          <div className="px-3 py-2 text-[11px] text-text-muted flex items-center justify-between">
            <span>
              {perAthleteTotal > 0 && `Per athlete: $${perAthleteTotal.toFixed(2)}`}
              {perAthleteTotal > 0 && sharedTotal > 0 && " · "}
              {sharedTotal > 0 && `Shared: $${sharedTotal.toFixed(2)} (split)`}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-text-muted">No line items yet.</p>
      )}

      {/* Add row */}
      <div className="space-y-2 rounded-lg bg-app-bg/50 p-2.5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Tournament entry)"
            className="sm:col-span-2 px-3 py-2 border border-app-border rounded-lg text-sm"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount"
            className="px-3 py-2 border border-app-border rounded-lg text-sm"
          />
          <label className="flex items-center gap-2 text-xs text-text-primary px-1">
            <input
              type="checkbox"
              checked={perAthlete}
              onChange={(e) => setPerAthlete(e.target.checked)}
              className="w-3.5 h-3.5"
            />
            Charge per athlete
          </label>
          <label className="text-xs text-text-muted flex items-center gap-2 cursor-pointer">
            <span className="px-2 py-1 rounded border border-app-border hover:bg-app-bg">
              {uploading ? "Uploading…" : receiptUrl ? "Receipt ✓" : "Attach receipt"}
            </span>
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadReceipt(f);
              }}
            />
          </label>
        </div>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description shown to parents (optional)"
          className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          type="button"
          onClick={addItem}
          disabled={saving}
          className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-hover disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add expense item"}
        </button>
      </div>
    </div>
  );
}
