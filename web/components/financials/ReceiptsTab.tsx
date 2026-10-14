"use client";

// Receipt inbox (2026-10-14). Drop in many receipts at once; each shows the
// bank rows it most likely belongs to. Nothing attaches itself — the owner
// presses "Attach". Amount and date are read from the file name when they're
// in it ("Home Depot 2026-03-14 84.17.pdf"); otherwise type them and the
// suggestions appear.
import { useCallback, useEffect, useRef, useState } from "react";

type Sug = { rowId: string; score: number; why: string[]; date: string; amount: number; name: string; account: string };
type Receipt = {
  id: string; fileName: string; mimeType: string; url: string; vendor: string | null; amount: number | null; date: string | null;
  notes: string | null; status: string; createdAt: string;
  matched: { id: string; date: string; amount: number; name: string; account: string } | null;
  suggestions: Sug[];
};

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3 text-[13px] font-medium md:min-h-[34px] disabled:opacity-50";
const BATCH = 20;

export default function ReceiptsTab({ canEdit }: { canEdit: boolean }) {
  const [status, setStatus] = useState<"UNMATCHED" | "MATCHED" | "IGNORED">("UNMATCHED");
  const [list, setList] = useState<Receipt[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/financials/receipts?status=${status}`, { cache: "no-store" });
    if (r.ok) setList((await r.json()).receipts);
  }, [status]);
  useEffect(() => { setList(null); load(); }, [load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    setMsg(null);
    let added = 0;
    const rejected: string[] = [];
    for (let i = 0; i < all.length; i += BATCH) {
      setUploading(`Uploading ${Math.min(i + BATCH, all.length)} of ${all.length}…`);
      const fd = new FormData();
      for (const f of all.slice(i, i + BATCH)) fd.append("file", f);
      const r = await fetch("/api/financials/receipts", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      added += d.added ?? 0;
      for (const x of d.rejected ?? []) rejected.push(`${x.name} (${x.reason})`);
      if (!r.ok && !d.rejected) rejected.push(d.error || "A batch failed.");
    }
    setUploading(null);
    if (fileRef.current) fileRef.current.value = "";
    setMsg({ ok: rejected.length === 0, text: `${added} receipt${added === 1 ? "" : "s"} added.${rejected.length ? ` Not added: ${rejected.slice(0, 5).join("; ")}${rejected.length > 5 ? "…" : ""}` : ""}` });
    setStatus("UNMATCHED");
    load();
  }

  async function patch(id: string, body: Record<string, unknown>, ok?: string) {
    const r = await fetch(`/api/financials/receipts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setMsg({ ok: false, text: d.error || "That didn't save." });
    if (ok) setMsg({ ok: true, text: ok });
    load();
  }
  async function remove(id: string) {
    const r = await fetch(`/api/financials/receipts/${id}`, { method: "DELETE" });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return setMsg({ ok: false, text: d.error || "Couldn't remove it." }); }
    load();
  }

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-app-border p-4">
        <h3 className="text-[15px] font-semibold text-text-primary">Receipts</h3>
        <p className="mt-1 text-[13px] text-text-muted">
          Drop in as many receipts as you like (PDFs or photos). Each one is checked against your bank transactions and
          the likely matches are shown — you attach it with one click. If the amount and date are in the file name
          (“Home Depot 2026-03-14 84.17.pdf”) the matches show straight away; otherwise type the amount.
        </p>
        {canEdit && (
          <label className={`${btn} mt-3 cursor-pointer bg-brand text-white`}>
            {uploading ?? "Add receipts"}
            <input ref={fileRef} type="file" multiple accept="application/pdf,image/*,.heic" className="hidden" disabled={!!uploading} onChange={(e) => upload(e.target.files)} />
          </label>
        )}
        {msg && (
          <p role="status" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={msg.ok ? { background: "var(--color-success-surface)", color: "var(--color-success-text)" } : { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>{msg.text}</p>
        )}
      </section>

      <div className="flex gap-1 rounded-lg bg-app-bg p-1 w-fit" role="tablist" aria-label="Receipts">
        {([["UNMATCHED", "To match"], ["MATCHED", "Attached"], ["IGNORED", "Set aside"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} onClick={() => setStatus(k)}
            className={`min-h-[44px] rounded-md px-3 text-[13px] md:min-h-[32px] ${status === k ? "bg-white shadow-sm font-medium text-text-primary" : "text-text-muted"}`}>{l}</button>
        ))}
      </div>

      {!list ? (
        <p className="text-[13px] text-text-muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-app-border bg-white px-4 py-8 text-center text-[13px] text-text-muted">
          {status === "UNMATCHED" ? "No receipts waiting. Add some above." : status === "MATCHED" ? "No receipts attached yet." : "Nothing set aside."}
        </p>
      ) : (
        <ul className="space-y-3">
          {list.map((r) => <ReceiptCard key={r.id} r={r} canEdit={canEdit} onPatch={patch} onRemove={remove} />)}
        </ul>
      )}
    </div>
  );
}

function ReceiptCard({ r, canEdit, onPatch, onRemove }: { r: Receipt; canEdit: boolean; onPatch: (id: string, body: Record<string, unknown>, ok?: string) => void; onRemove: (id: string) => void }) {
  const [vendor, setVendor] = useState(r.vendor ?? "");
  const [amount, setAmount] = useState(r.amount != null ? r.amount.toFixed(2) : "");
  const [date, setDate] = useState(r.date ?? "");
  const dirty = vendor !== (r.vendor ?? "") || amount !== (r.amount != null ? r.amount.toFixed(2) : "") || date !== (r.date ?? "");
  function saveFacts() {
    const a = amount.trim() === "" ? null : Number(amount.replace(/[$,]/g, ""));
    if (a !== null && (!Number.isFinite(a) || a <= 0)) return;
    onPatch(r.id, { vendor: vendor.trim() || null, amount: a, date: date || null });
  }
  const isImage = r.mimeType.startsWith("image/") && !/heic|heif/.test(r.mimeType);
  return (
    <li className="bg-white rounded-xl border border-app-border p-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <a href={r.url} target="_blank" rel="noreferrer" className="flex h-24 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border border-app-border bg-app-bg text-[12px] text-text-muted sm:w-24">
          {isImage ? <img src={r.url} alt={r.fileName} className="h-full w-full object-cover" /> : "Open file"}
        </a>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-text-primary" title={r.fileName}>{r.fileName}</p>
          {canEdit && r.status !== "MATCHED" ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_120px_150px_auto]">
              <input aria-label="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor" className="min-h-[44px] rounded-lg border border-app-border px-2.5 text-[14px] md:min-h-[34px]" />
              <input aria-label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" className="min-h-[44px] rounded-lg border border-app-border px-2.5 text-[14px] md:min-h-[34px]" />
              <input aria-label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-[44px] rounded-lg border border-app-border px-2.5 text-[14px] md:min-h-[34px]" />
              <button type="button" disabled={!dirty} onClick={saveFacts} className={`${btn} border border-app-border`}>Save &amp; find</button>
            </div>
          ) : (
            <p className="text-[13px] text-text-muted">{[r.vendor, r.amount != null ? money(r.amount) : null, r.date ? fmt(r.date) : null].filter(Boolean).join(" · ") || "—"}</p>
          )}

          {r.status === "MATCHED" && r.matched && (
            <p className="mt-2 text-[13px] text-text-primary">
              ✓ Attached to <b>{r.matched.name}</b> · {money(r.matched.amount)} · {fmt(r.matched.date)} · {r.matched.account}
              {canEdit && <button type="button" onClick={() => onPatch(r.id, { unmatch: true }, "Detached.")} className="ml-2 text-[12px] text-text-muted underline">Detach</button>}
            </p>
          )}

          {r.status === "UNMATCHED" && (
            r.suggestions.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {r.suggestions.map((s) => (
                  <li key={s.rowId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app-border px-2.5 py-2">
                    <span className="min-w-0 text-[13px] text-text-primary">
                      <b>{s.name}</b> · {money(s.amount)} · {fmt(s.date)} · <span className="text-text-muted">{s.account}</span>
                      <span className="block text-[12px] text-text-muted">{s.score >= 0.8 ? "Very likely" : s.score >= 0.55 ? "Likely" : "Possible"} — {s.why.join(", ")}</span>
                    </span>
                    {canEdit && <button type="button" onClick={() => onPatch(r.id, { matchRowId: s.rowId }, "Receipt attached.")} className={`${btn} bg-brand text-white`}>Attach</button>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[12.5px] text-text-muted">
                {r.amount == null && !r.date ? "Type the amount (and date if you know it) to see matching bank transactions." : "No bank transaction matches yet. If it's on a card that isn't connected, add that account in the Bank tab and import its history."}
              </p>
            )
          )}

          {canEdit && (
            <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
              {r.status === "UNMATCHED" && <button type="button" onClick={() => onPatch(r.id, { ignore: true })} className="text-text-muted underline">Set aside</button>}
              {r.status === "IGNORED" && <button type="button" onClick={() => onPatch(r.id, { ignore: false })} className="text-text-muted underline">Back to inbox</button>}
              {r.status !== "MATCHED" && <button type="button" onClick={() => onRemove(r.id)} className="text-text-muted underline">Remove</button>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
