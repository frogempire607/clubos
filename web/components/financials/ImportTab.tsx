"use client";

// Import from QuickBooks (2026-10-14). Upload the "Transaction List by Date"
// export, say what each QuickBooks account is (one of your bank accounts, a
// category, or skip), check the plan, then import. Nothing is written until
// "Import"; an import can be undone as a whole.
import { useCallback, useEffect, useMemo, useState } from "react";
import { EXPENSE_CATEGORIES, REVENUE_CATEGORIES } from "@/lib/financials";
import { SPECIAL_CATEGORIES, type AccountMap, type Direction, type ImportMapping, type PlannedRow, type QbRow } from "@/lib/ledgerImport";

type BankAcct = { id: string; name: string; mask: string | null; connectionLabel: string; kind: string; feedStarts: string | null };
type Preview = {
  import: { id: string; status: string; fileName: string; problems: string[] };
  mapping: ImportMapping; accountsInFile: string[]; typesInFile: string[]; bankAccounts: BankAcct[];
  rows: QbRow[]; plan: PlannedRow[];
  summary: { total: number; match: number; create: number; skip: number; categorised: number; inFeedUnmatched: number };
};
type PastImport = { id: string; fileName: string; status: string; createdAt: string; committedAt: string | null; summary: { match?: number; create?: number } | null };

const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[34px] disabled:opacity-50";
const sel = "min-h-[44px] w-full rounded-lg border border-app-border px-2 text-[13px] md:min-h-[34px]";
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CATS = [
  ...EXPENSE_CATEGORIES.map((c) => ({ key: c.key, label: `Expense · ${c.label}` })),
  ...REVENUE_CATEGORIES.map((c) => ({ key: c.key, label: `Income · ${c.label}` })),
  ...SPECIAL_CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
];
const encode = (m: AccountMap | undefined) => (!m ? "cat:" : m.kind === "BANK" ? `bank:${m.bankAccountId}` : m.kind === "SKIP" ? "skip" : `cat:${m.category ?? ""}`);
const decode = (v: string): AccountMap => (v === "skip" ? { kind: "SKIP" } : v.startsWith("bank:") ? { kind: "BANK", bankAccountId: v.slice(5) } : { kind: "CATEGORY", category: v.slice(4) || null });

export default function ImportTab({ canEdit }: { canEdit: boolean }) {
  const [past, setPast] = useState<PastImport[]>([]);
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [show, setShow] = useState<"ALL" | "MATCH" | "CREATE" | "SKIP">("ALL");
  const [confirm, setConfirm] = useState(false);

  const loadPast = useCallback(async () => {
    const r = await fetch("/api/financials/imports", { cache: "no-store" });
    if (r.ok) setPast((await r.json()).imports);
  }, []);
  useEffect(() => { loadPast(); }, [loadPast]);
  const open = useCallback(async (id: string) => {
    const r = await fetch(`/api/financials/imports/${id}`, { cache: "no-store" });
    if (r.ok) setPv(await r.json());
  }, []);

  async function upload(f: File | undefined) {
    if (!f) return;
    setBusy("upload"); setMsg(null);
    const fd = new FormData(); fd.append("file", f);
    const r = await fetch("/api/financials/imports", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: d.error || "That file couldn't be read." });
    await open(d.id); loadPast();
  }
  async function setMap(next: ImportMapping) {
    if (!pv) return;
    setPv({ ...pv, mapping: next });
    setBusy("map");
    const r = await fetch(`/api/financials/imports/${pv.import.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mapping: next }) });
    setBusy(null);
    if (!r.ok) { const d = await r.json().catch(() => ({})); setMsg({ ok: false, text: d.error || "Couldn't save the mapping." }); }
    await open(pv.import.id);
  }
  async function commit() {
    if (!pv) return;
    setBusy("commit"); setMsg(null);
    const r = await fetch(`/api/financials/imports/${pv.import.id}/commit`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy(null); setConfirm(false);
    if (!r.ok) return setMsg({ ok: false, text: d.error || "Import failed — nothing was changed." });
    setMsg({ ok: true, text: `Imported: ${d.summary.match} matched to your bank rows, ${d.summary.create} added as history. You can undo this import.` });
    await open(pv.import.id); loadPast();
  }
  async function undo(id: string) {
    setBusy("undo"); setMsg(null);
    const r = await fetch(`/api/financials/imports/${id}/undo`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: d.error || "Couldn't undo." });
    setMsg({ ok: true, text: `Undone: ${d.removed} added row(s) removed, ${d.restored} category change(s) put back.` });
    if (pv?.import.id === id) await open(id);
    loadPast();
  }

  const rowsShown = useMemo(() => {
    if (!pv) return [];
    const byIdx = new Map(pv.rows.map((r) => [r.idx, r]));
    return pv.plan.filter((p) => show === "ALL" || p.action === show).slice(0, 300).map((p) => ({ p, r: byIdx.get(p.idx)! }));
  }, [pv, show]);
  const draft = pv?.import.status === "DRAFT";
  const acctName = (id: string | null) => {
    const a = pv?.bankAccounts.find((b) => b.id === id);
    return a ? `${a.name}${a.mask ? ` ••${a.mask}` : ""}` : "—";
  };
  const catLabel = (k: string | null) => (k ? CATS.find((c) => c.key === k)?.label.replace(/^(Expense|Income) · /, "") ?? k : "Needs a category");

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-app-border p-4">
        <h3 className="text-[15px] font-semibold text-text-primary">Import from QuickBooks</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-text-muted">
          <li>In QuickBooks: <b>Reports → Transaction List by Date</b>, date range <b>This year</b> (or Jan 1 – today), then <b>Export → CSV</b> (Excel works too). One file per company if the Foundation has its own QuickBooks.</li>
          <li>Upload it here and say what each QuickBooks account is: one of your bank accounts, a category, or skip.</li>
          <li>Check the plan. Rows already in your bank feed are <b>matched</b> (their QuickBooks category is used only if you never categorised them here). Rows from before the feed begins are <b>added as history</b>. Nothing is ever counted twice.</li>
        </ol>
        {canEdit && (
          <label className={`${btn} mt-3 cursor-pointer bg-brand text-white`}>
            {busy === "upload" ? "Reading…" : "Upload QuickBooks export"}
            <input type="file" accept=".csv,.xlsx" className="hidden" disabled={busy === "upload"} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        )}
        {msg && (
          <p role="status" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={msg.ok ? { background: "var(--color-success-surface)", color: "var(--color-success-text)" } : { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>{msg.text}</p>
        )}
        {past.length > 0 && (
          <ul className="mt-3 divide-y divide-app-border rounded-lg border border-app-border">
            {past.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
                <span className="min-w-0 truncate">
                  <b className="font-medium text-text-primary">{p.fileName}</b>
                  <span className="ml-2 text-text-muted">{p.status === "DRAFT" ? "Not imported yet" : p.status === "COMMITTED" ? `Imported ${new Date(p.committedAt!).toLocaleDateString()}${p.summary ? ` · ${p.summary.match ?? 0} matched, ${p.summary.create ?? 0} added` : ""}` : "Undone"}</span>
                </span>
                <span className="flex gap-2">
                  <button type="button" onClick={() => open(p.id)} className="text-[12px] underline text-text-muted">Open</button>
                  {canEdit && p.status === "COMMITTED" && <button type="button" disabled={busy === "undo"} onClick={() => undo(p.id)} className="text-[12px] underline text-text-muted">Undo import</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pv && (
        <>
          {pv.import.problems.length > 0 && (
            <p className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)" }}>{pv.import.problems.join(" ")}</p>
          )}
          <section className="bg-white rounded-xl border border-app-border p-4">
            <h3 className="text-[15px] font-semibold text-text-primary">What each QuickBooks account is</h3>
            <p className="text-[12.5px] text-text-muted">Pick your bank account for each QuickBooks bank or card account. Money moving to a card “paid from Stripe” or similar should be <b>Stripe / card payout</b> — that money is already counted in AthletixOS.</p>
            {pv.bankAccounts.length === 0 && <p className="mt-2 text-[13px] text-text-muted">No bank accounts yet — connect one, or add an account kept by hand, in the Bank tab.</p>}
            <div className="mt-3 grid gap-2">
              {pv.accountsInFile.map((name) => (
                <div key={name} className="grid items-center gap-2 sm:grid-cols-[1fr_minmax(0,320px)]">
                  <span className="text-[13px] text-text-primary">{name}</span>
                  <select aria-label={`What “${name}” is`} disabled={!draft || !canEdit} value={encode(pv.mapping.accounts[name])} className={sel}
                    onChange={(e) => setMap({ ...pv.mapping, accounts: { ...pv.mapping.accounts, [name]: decode(e.target.value) } })}>
                    <optgroup label="Your bank accounts">
                      {pv.bankAccounts.map((b) => <option key={b.id} value={`bank:${b.id}`}>Bank: {b.name}{b.mask ? ` ••${b.mask}` : ""} ({b.connectionLabel})</option>)}
                    </optgroup>
                    <optgroup label="Category">
                      <option value="cat:">Needs a category (decide in the Bank tab)</option>
                      {CATS.map((c) => <option key={c.key} value={`cat:${c.key}`}>{c.label}</option>)}
                    </optgroup>
                    <option value="skip">Skip rows that use this</option>
                  </select>
                </div>
              ))}
            </div>
            {pv.typesInFile.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[13px] text-text-primary">Transaction types (usually leave on Automatic)</summary>
                <div className="mt-2 grid gap-2">
                  {pv.typesInFile.map((t) => (
                    <div key={t} className="grid items-center gap-2 sm:grid-cols-[1fr_200px]">
                      <span className="text-[13px] text-text-primary">{t}</span>
                      <select aria-label={`How to treat ${t}`} disabled={!draft || !canEdit} value={pv.mapping.types[t] ?? "AUTO"} className={sel}
                        onChange={(e) => setMap({ ...pv.mapping, types: { ...pv.mapping.types, [t]: e.target.value as Direction } })}>
                        <option value="AUTO">Automatic</option><option value="OUT">Money out</option><option value="IN">Money in</option>
                        <option value="TRANSFER">Transfer</option><option value="SKIP">Skip</option>
                      </select>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>

          <section className="bg-white rounded-xl border border-app-border p-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[["Matched to your bank rows", pv.summary.match], ["Added as history", pv.summary.create], ["Skipped", pv.summary.skip], ["In the feed but no match", pv.summary.inFeedUnmatched]].map(([l, n]) => (
                <div key={l as string} className="rounded-lg border border-app-border px-3 py-2"><p className="text-[12px] text-text-muted">{l}</p><p className="text-[18px] font-semibold text-text-primary">{n}</p></div>
              ))}
            </div>
            {pv.summary.inFeedUnmatched > 0 && (
              <p className="mt-2 text-[12.5px] text-text-muted">“In the feed but no match” rows are dated inside your bank feed&apos;s history but have no bank row with the same amount — they are NOT imported, so nothing is counted twice. Look them up in the Bank tab.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-1">
              {(["ALL", "MATCH", "CREATE", "SKIP"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setShow(k)} className={`min-h-[44px] rounded-full border px-3 text-[12px] md:min-h-[30px] ${show === k ? "border-brand bg-brand/10 text-brand" : "border-app-border"}`}>{k === "ALL" ? "All" : k === "MATCH" ? "Matched" : k === "CREATE" ? "Added" : "Skipped"}</button>
              ))}
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-left text-text-muted"><th className="py-1 pr-2">Date</th><th className="pr-2">QuickBooks</th><th className="pr-2">Amount</th><th className="pr-2">Account</th><th className="pr-2">Category</th><th>What happens</th></tr></thead>
                <tbody>
                  {rowsShown.map(({ p, r }) => (
                    <tr key={p.idx} className="border-t border-app-border align-top">
                      <td className="py-1.5 pr-2 whitespace-nowrap">{r.date}</td>
                      <td className="pr-2">{r.name || r.memo || "—"}<span className="block text-text-muted">{r.type}{r.num ? ` #${r.num}` : ""}</span></td>
                      <td className="pr-2 whitespace-nowrap">{p.bankAmount === null ? money(r.amount) : `${p.bankAmount > 0 ? "−" : "+"}${money(p.bankAmount)}`}</td>
                      <td className="pr-2">{acctName(p.bankAccountId)}</td>
                      <td className="pr-2">{p.action === "SKIP" ? "—" : catLabel(p.category)}</td>
                      <td><b className="font-medium">{p.action === "MATCH" ? "Matched" : p.action === "CREATE" ? "Added" : "Skipped"}</b> — {p.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pv.plan.filter((p) => show === "ALL" || p.action === show).length > 300 && <p className="mt-2 text-[12px] text-text-muted">Showing the first 300.</p>}
            </div>
            {canEdit && draft && (
              confirm ? (
                <div className="mt-3 rounded-lg border px-3 py-2.5" style={{ background: "var(--color-warn-surface)", borderColor: "var(--color-warn-border)", color: "var(--color-warn-text)" }}>
                  <p className="text-[13px]">Import now? {pv.summary.match} bank row(s) get their QuickBooks category where you hadn&apos;t set one, and {pv.summary.create} row(s) are added as history. You can undo the whole import afterwards.</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={busy === "commit"} onClick={commit} className={`${btn} bg-brand text-white`}>{busy === "commit" ? "Importing…" : "Yes, import"}</button>
                    <button type="button" onClick={() => setConfirm(false)} className={`${btn} border border-app-border`}>Not yet</button>
                  </div>
                </div>
              ) : (
                <button type="button" disabled={busy === "map" || pv.summary.match + pv.summary.create === 0} onClick={() => setConfirm(true)} className={`${btn} mt-3 bg-brand text-white`}>Import</button>
              )
            )}
          </section>
        </>
      )}
    </div>
  );
}
