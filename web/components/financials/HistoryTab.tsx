"use client";

// Financials → Books → History (Accounting Phase 3, task 8).
//
// A searchable archive of what the club's books looked like in QuickBooks.
//
// ⚠️  THESE ROWS NEVER REACH THE BOOKS. They don't post, they don't appear in
// any statement, and no balance is derived from them. The guarantee is
// structural — qbo_history_rows has no relation to any gl_* table — and
// scripts/gl-opening-tests.ts §6 greps every reports and posting module on
// each build to prove none of them reads it.
//
// It exists so a club can still answer "what did we pay that vendor in 2024?"
// after it stops paying for QuickBooks.
//
// Mobile: the table scrolls, filters stack.
import { useCallback, useEffect, useState } from "react";
import { Archive, Loader2, Search, Trash2, Upload } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { formatCents } from "@/lib/ledger";

type FileRow = {
  id: string;
  fileName: string;
  kind: string;
  rowCount: number;
  notes: string | null;
  createdAt: string;
};
type Row = {
  id: string;
  txDate: string | null;
  txType: string | null;
  num: string | null;
  name: string | null;
  memo: string | null;
  account: string | null;
  split: string | null;
  amountCents: number | null;
  fileId: string;
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

const PAGE = 100;

export default function HistoryTab({ canEdit }: { canEdit: boolean }) {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [q, setQ] = useState("");
  const [account, setAccount] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [fileId, setFileId] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setErr("");
    const p = new URLSearchParams({ take: String(PAGE), skip: String(skip) });
    if (q.trim()) p.set("q", q.trim());
    if (account) p.set("account", account);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (fileId) p.set("file", fileId);
    try {
      const r = await fetch(`/api/financials/ledger/history?${p}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Couldn't search the archive.");
        setRows([]);
        return;
      }
      setFiles(d.files ?? []);
      setRows(d.rows ?? []);
      setAccounts(d.accounts ?? []);
      setTotal(d.total ?? 0);
    } catch {
      setErr("Couldn't search the archive.");
      setRows([]);
    }
  }, [q, account, from, to, fileId, skip]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File, kind: string) => {
    setBusy("upload");
    setErr("");
    setMsg("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      const r = await fetch("/api/financials/ledger/history", { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "That file couldn't be read.");
      else {
        setMsg(`Archived ${d.rowCount} rows from ${file.name}.`);
        setSkip(0);
        await load();
      }
    } catch {
      setErr("That file couldn't be read.");
    } finally {
      setBusy("");
    }
  };

  const removeFile = async (f: FileRow) => {
    setBusy(f.id);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/history?file=${encodeURIComponent(f.id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setErr(d?.error || "Couldn't remove that file.");
      } else {
        if (fileId === f.id) setFileId("");
        setMsg(`Removed ${f.fileName}.`);
        await load();
      }
    } catch {
      setErr("Couldn't remove that file.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-text-primary">QuickBooks history</h2>
          <p className="mt-0.5 max-w-2xl text-[12px] text-text-muted">
            A read-only copy of your old books, so you can still look things up after you stop paying for
            QuickBooks. <strong className="text-text-primary">Nothing here affects your books</strong> — these
            rows never post and never appear in a report.
          </p>
        </div>
        {canEdit && (
          <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover">
            {busy === "upload" ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <Upload className="h-4 w-4" strokeWidth={2} />
            )}
            Archive an export
            <input
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f, "GENERAL_LEDGER");
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-text-muted">{msg}</div>}

      {files.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
          <div className="bg-app-bg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Archived files
          </div>
          <ul>
            {files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 border-t border-app-border px-3 py-2 text-[12px]">
                <Archive className="h-3.5 w-3.5 shrink-0 text-text-muted" strokeWidth={2} />
                <button
                  type="button"
                  onClick={() => {
                    setFileId(fileId === f.id ? "" : f.id);
                    setSkip(0);
                  }}
                  className={`text-left ${fileId === f.id ? "font-medium text-brand" : "text-text-primary hover:text-brand"}`}
                >
                  {f.fileName}
                </button>
                <span className="text-text-muted">
                  {f.rowCount.toLocaleString()} rows · {fmtStamp(f.createdAt)}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => removeFile(f)}
                    disabled={busy !== ""}
                    aria-label={`Remove ${f.fileName}`}
                    className="ml-auto rounded-lg p-1.5 text-text-muted hover:bg-app-bg disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="-mx-1 overflow-x-auto px-1">
        <div className="flex min-w-max items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" strokeWidth={2} />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSkip(0);
              }}
              placeholder="Search name, memo, number, account"
              className="w-64 rounded-lg border border-app-border bg-surface py-2 pl-8 pr-3 text-sm"
            />
          </div>
          {accounts.length > 0 && (
            <select
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setSkip(0);
              }}
              className="rounded-lg border border-app-border bg-surface px-2 py-2 text-sm"
              aria-label="Account"
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setSkip(0);
            }}
            className="rounded-lg border border-app-border bg-surface px-2 py-2 text-sm"
            aria-label="From date"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setSkip(0);
            }}
            className="rounded-lg border border-app-border bg-surface px-2 py-2 text-sm"
            aria-label="To date"
          />
          {(q || account || from || to || fileId) && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                setAccount("");
                setFrom("");
                setTo("");
                setFileId("");
                setSkip(0);
              }}
              className="rounded-lg border border-app-border px-3 py-2 text-sm text-text-muted hover:bg-app-bg"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {rows === null ? (
        <SkeletonList rows={8} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-app-border bg-surface px-4 py-10 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Archive className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-sm text-text-primary">
            {files.length === 0 ? "Nothing archived yet" : "No rows match those filters"}
          </p>
          {files.length === 0 && (
            <p className="mt-1 text-[12px] text-text-muted">
              Export QuickBooks&apos; General Ledger or Transaction Detail by Account and archive it here
              before you close the account.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-[12px] text-text-muted">
            {total.toLocaleString()} {total === 1 ? "row" : "rows"}
            {total > PAGE ? ` · showing ${skip + 1}–${Math.min(skip + PAGE, total)}` : ""}
          </p>
          <div className="overflow-x-auto rounded-xl border border-app-border bg-surface">
            <table className="w-full min-w-[52rem] text-[12px]">
              <thead className="bg-app-bg uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Num</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Memo</th>
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-left">Split</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-app-border">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-muted">
                      {r.txDate ? fmtDate(r.txDate) : ""}
                    </td>
                    <td className="px-3 py-2 text-text-muted">{r.txType ?? ""}</td>
                    <td className="px-3 py-2 text-text-muted">{r.num ?? ""}</td>
                    <td className="px-3 py-2 text-text-primary">{r.name ?? ""}</td>
                    <td className="px-3 py-2 text-text-muted">{r.memo ?? ""}</td>
                    <td className="px-3 py-2 text-text-muted">{r.account ?? ""}</td>
                    <td className="px-3 py-2 text-text-muted">{r.split ?? ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                      {r.amountCents === null ? "" : formatCents(r.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE && (
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setSkip(Math.max(0, skip - PAGE))}
                disabled={skip === 0}
                className="rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setSkip(skip + PAGE)}
                disabled={skip + PAGE >= total}
                className="rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
