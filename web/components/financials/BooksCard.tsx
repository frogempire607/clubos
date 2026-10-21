"use client";

// Financials → Books → Journal: the automatic-posting controls.
//
// Three things that belong together because they are all about what reaches the
// ledger without anybody typing an entry:
//
//   1. the BOOKS START DATE (Phase 2 task 2) — owner-only. Nothing dated before
//      it ever posts automatically, and no date at all means automatic posting
//      does not run. That is the setting that stops Phase 2 double-counting
//      history a club already imported;
//   2. POST NOW — runs the sweep and reports what posted and what was held
//      back, with the reason. A skipped dollar has to be visible;
//   3. RECORD DEPOSIT — moves a batch of cash and cheques from 1020
//      Undeposited Funds into a bank account, which is the other half of the
//      1020 story Phase 1 started.
import { useCallback, useEffect, useState } from "react";
import { Banknote, CalendarClock, Loader2, PlayCircle, X } from "lucide-react";
import { formatCents } from "@/lib/ledger";

type Payment = { id: string; date: string; amountCents: number; who: string; method: string };
type Account = { id: string; number: string; name: string };
type Report = {
  posted: number;
  skipped: Record<string, number>;
  examples: { sourceType: string; sourceId: string; reason: string; detail?: string }[];
  errors: { sourceType: string; sourceId: string; error: string }[];
  booksStartDate: string | null;
  skipLabels: Record<string, string>;
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const today = () => new Date().toISOString().slice(0, 10);

export default function BooksCard({ canEdit, isOwner }: { canEdit: boolean; isOwner: boolean }) {
  const [booksStartDate, setBooksStartDate] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(today());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/financials/ledger/books-start", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setBooksStartDate(d.booksStartDate ?? null);
        if (d.booksStartDate) setDraft(d.booksStartDate);
      }
    } catch {
      /* the card just shows "not set" */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveStart(value: string | null) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/books-start", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booksStartDate: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't save that date.");
        return;
      }
      setBooksStartDate(d.booksStartDate ?? null);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  async function postNow() {
    setBusy(true);
    setErr("");
    setReport(null);
    try {
      const r = await fetch("/api/financials/ledger/post", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Posting didn't run.");
        return;
      }
      setReport(d as Report);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <section className="bg-surface rounded-xl border border-app-border overflow-hidden">
      <div className="px-4 py-3 border-b border-app-border">
        <h3 className="text-sm font-medium text-text-primary inline-flex items-center gap-1.5">
          <CalendarClock className="h-4 w-4" /> Automatic posting
        </h3>
        <p className="text-[12px] text-text-muted mt-0.5 max-w-xl">
          Payments, refunds, payouts, expenses and categorized bank rows post themselves to the journal. Nothing before
          your books start date is ever posted automatically.
        </p>
      </div>

      {/* Books start date */}
      <div className="px-4 py-3 border-b border-app-border">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm text-text-primary">Books start date</p>
            <p className="text-[12px] text-text-muted mt-0.5 max-w-xl">
              {booksStartDate ? (
                <>
                  Your books begin <span className="tabular-nums">{fmtDate(booksStartDate)}</span>. Anything earlier
                  stays out of the ledger unless you post it by hand.
                </>
              ) : (
                <>
                  <span className="text-orange-accent">Not set, so nothing posts automatically.</span> Pick the date
                  your books begin — usually the day after the last period your old system covers.
                </>
              )}
              {!isOwner && " Only an owner can change this."}
            </p>
          </div>
          {isOwner && !editing && (
            <button
              onClick={() => {
                setEditing(true);
                setErr("");
              }}
              className="text-[12px] px-2.5 py-1 rounded-md border border-app-border text-text-muted hover:text-text-primary shrink-0"
            >
              {booksStartDate ? "Change" : "Set the date"}
            </button>
          )}
        </div>

        {editing && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="date"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              />
              <button
                onClick={() => saveStart(draft)}
                disabled={busy || !draft}
                className="text-sm px-3 py-1.5 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              {booksStartDate && (
                <button onClick={() => saveStart(null)} disabled={busy} className="text-sm px-3 py-1.5 text-text-muted disabled:opacity-50">
                  Turn automatic posting off
                </button>
              )}
              <button onClick={() => setEditing(false)} className="text-sm px-3 py-1.5 text-text-muted">
                Cancel
              </button>
            </div>
            {booksStartDate && draft > booksStartDate && (
              <p className="text-[12px] text-orange-accent">
                This moves the date later, so records before {fmtDate(draft)} will stop posting.
              </p>
            )}
            {booksStartDate && draft < booksStartDate && (
              <p className="text-[12px] text-text-muted">
                This moves the date earlier, so older records can now post. Check you haven&apos;t already entered that
                period another way.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Post now + record deposit */}
      <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
        {canEdit && (
          <button
            onClick={postNow}
            disabled={busy || !booksStartDate}
            title={booksStartDate ? undefined : "Set a books start date first"}
            className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Post anything waiting
          </button>
        )}
        {canEdit && (
          <button
            onClick={() => setShowDeposit(true)}
            className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg inline-flex items-center gap-1.5"
          >
            <Banknote className="h-4 w-4" /> Record a deposit
          </button>
        )}
      </div>

      {err && <p className="px-4 pb-3 text-sm text-red-600">{err}</p>}

      {report && (
        <div className="px-4 pb-4">
          <div className="rounded-lg border border-app-border bg-app-bg px-3 py-2.5">
            <p className="text-sm text-text-primary">
              {report.posted > 0
                ? `Posted ${report.posted} ${report.posted === 1 ? "entry" : "entries"}.`
                : "Nothing new to post."}
            </p>
            {Object.keys(report.skipped).length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {Object.entries(report.skipped)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <li key={reason} className="text-[12px] text-text-muted">
                      <span className="tabular-nums">{count}</span> · {report.skipLabels?.[reason] ?? reason}
                    </li>
                  ))}
              </ul>
            )}
            {report.errors.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {report.errors.slice(0, 5).map((e, i) => (
                  <li key={i} className="text-[12px] text-red-600">
                    {e.sourceType} {e.sourceId}: {e.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {showDeposit && <DepositModal onClose={() => setShowDeposit(false)} onDone={() => setShowDeposit(false)} />}
    </section>
  );
}

/* ── Record a deposit ──────────────────────────────────────────────────────── */
function DepositModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/financials/ledger/deposits", { cache: "no-store" });
        const d = await r.json();
        if (!r.ok) {
          setErr(d.error || "Couldn't load undeposited payments.");
          setPayments([]);
          return;
        }
        setPayments(d.payments ?? []);
        setAccounts(d.accounts ?? []);
        if ((d.accounts ?? []).length > 0) setAccountId(d.accounts[0].id);
      } catch {
        setErr("Couldn't load undeposited payments.");
        setPayments([]);
      }
    })();
  }, []);

  // The client total is for display only — the server sums the chosen rows.
  const total = (payments ?? []).filter((p) => picked.has(p.id)).reduce((s, p) => s + p.amountCents, 0);

  async function save() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/deposits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankAccountGlId: accountId,
          depositDate: date,
          transactionIds: [...picked],
          memo: memo.trim() || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't record that deposit.");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <h3 className="text-sm font-medium text-text-primary">Record a deposit</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-[12px] text-text-muted">
            Cash and cheques sit in Undeposited Funds until you bank them. Tick what went to the bank and this moves it
            across.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] text-text-muted mb-1">Deposited into</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              >
                {accounts.length === 0 && <option value="">No bank accounts yet</option>}
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12px] text-text-muted mb-1">Deposit date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              />
            </div>
          </div>

          {payments === null ? (
            <p className="text-[12px] text-text-muted">Loading…</p>
          ) : payments.length === 0 ? (
            <p className="text-[12px] text-text-muted">Nothing is waiting to be deposited.</p>
          ) : (
            <div className="rounded-lg border border-app-border divide-y divide-app-border max-h-64 overflow-y-auto">
              {payments.map((p) => (
                <label key={p.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={picked.has(p.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        return next;
                      })
                    }
                    className="rounded border-app-border"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-sm text-text-primary block truncate">{p.who}</span>
                    <span className="text-[12px] text-text-muted">
                      {fmtDate(p.date)} · {p.method}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-text-primary shrink-0">{formatCents(p.amountCents)}</span>
                </label>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">{picked.size} selected</span>
            <span className="tabular-nums font-medium text-text-primary">{formatCents(total)}</span>
          </div>

          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Note (optional)"
            className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
          />

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border">
          <button onClick={onClose} className="text-sm px-3 py-2 text-text-muted">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || picked.size === 0 || !accountId}
            className="text-sm px-4 py-2 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white disabled:opacity-50"
          >
            {busy ? "Recording…" : `Deposit ${formatCents(total)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
