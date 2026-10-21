"use client";

// Financials → Books → Reconcile (Accounting Phase 2, task 7).
//
// Pick an account and a statement month, type the statement's ending balance,
// tick off what cleared, and finish only at exactly $0.00. Save the finished
// workpaper as a PDF.
//
// The difference shown here is computed from the same numbers the server
// recomputes on finish (lib/glReconcile.ts `summarise`), so the figure on
// screen is the figure the gate uses — the Finish button can never be enabled
// for something the server will refuse.
//
// Mobile: the line table becomes one row per card, both toolbars scroll
// horizontally. 12-hour times.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileDown, Loader2, Lock, RotateCcw, X } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { formatCents, parseDollarsToCents } from "@/lib/ledger";
import { finishBlockedReason, monthEnd, monthStart, summarise } from "@/lib/glReconcile";

type Account = { id: string; number: string; name: string; normalBalance: string; isCard: boolean };
type Line = {
  lineId: string;
  entryId: string;
  entryDate: string;
  memo: string | null;
  reference: string | null;
  debitCents: number;
  creditCents: number;
  signedCents: number;
  cleared: boolean;
  lockedElsewhere: boolean;
};
type Reconciliation = {
  id: string | null;
  accountId: string;
  accountNumber: string;
  accountName: string;
  normalBalance: string;
  periodStart: string;
  periodEnd: string;
  statementEndingCents: number;
  status: string;
  notes: string | null;
  clearedBalanceCents: number;
  differenceCents: number;
  lines: Line[];
  finishedAt: string | null;
  undoneAt: string | null;
  openingClearedCents: number;
};

/// Date-only values are stored at 00:00 UTC, so they must be formatted in UTC
/// or they render as the day before west of Greenwich.
const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/// Timestamps are true instants, so they render in the viewer's zone — 12-hour.
const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

const thisMonth = () => new Date().toISOString().slice(0, 10);

export default function ReconcileTab({ canEdit }: { canEdit: boolean }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState("");
  const [month, setMonth] = useState(() => thisMonth().slice(0, 7));
  const [rec, setRec] = useState<Reconciliation | null>(null);
  const [statement, setStatement] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoReason, setUndoReason] = useState("");

  const periodStart = monthStart(`${month}-01`);
  const periodEnd = monthEnd(`${month}-01`);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (accountId) {
        p.set("account", accountId);
        p.set("start", periodStart);
        p.set("end", periodEnd);
      }
      const r = await fetch(`/api/financials/ledger/reconcile?${p}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Couldn't load reconciliation.");
        return;
      }
      setAccounts(d.accounts ?? []);
      if (!accountId && (d.accounts ?? []).length > 0) setAccountId(d.accounts[0].id);
      setRec(d.reconciliation ?? null);
      if (d.reconciliation) {
        setStatement(
          d.reconciliation.statementEndingCents ? (d.reconciliation.statementEndingCents / 100).toFixed(2) : "",
        );
      }
    } catch {
      setErr("Couldn't load reconciliation.");
    } finally {
      setLoading(false);
    }
  }, [accountId, periodStart, periodEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  // The live figures, from the same pure helper the server finishes against.
  const typedCents = parseDollarsToCents(statement) ?? 0;
  const live = useMemo(
    () => (rec ? summarise(rec.lines, rec.openingClearedCents, typedCents) : null),
    [rec, typedCents],
  );
  const blocked = rec && live ? finishBlockedReason(rec.status, live.differenceCents) : null;
  const finished = rec?.status === "FINISHED";

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "That didn't work.");
        return null;
      }
      setRec(d.reconciliation);
      return d.reconciliation as Reconciliation;
    } finally {
      setBusy(false);
    }
  }

  /// Save the statement balance, creating the reconciliation if it doesn't
  /// exist yet. RETURNS the row rather than relying on state, because a tick
  /// made before the first save needs the new id immediately and a React state
  /// update is not visible until the next render.
  async function saveStatement(): Promise<Reconciliation | null> {
    if (!accountId) return null;
    return act({
      action: "upsert",
      accountId,
      periodStart,
      periodEnd,
      statementEndingCents: typedCents,
      notes: rec?.notes ?? null,
    });
  }

  async function toggle(line: Line) {
    if (finished || !canEdit || line.lockedElsewhere) return;
    // Ticking is allowed before the balance is typed — the reconciliation just
    // has to exist for the tick to attach to, so create it on the fly.
    const id = rec?.id ?? (await saveStatement())?.id ?? null;
    if (!id) {
      setErr("Couldn't start this reconciliation. Check the account and month.");
      return;
    }
    await act({ action: "clear", reconciliationId: id, lineIds: [line.lineId], cleared: !line.cleared });
  }

  async function exportPdf() {
    if (!rec || !live) return;
    // Dynamic import so jspdf stays out of the initial bundle — the same
    // pattern the migration roster PDF uses.
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

    doc.setFontSize(16);
    doc.text("Bank reconciliation", 40, 48);
    doc.setFontSize(10);
    doc.text(`${rec.accountNumber} ${rec.accountName}`, 40, 68);
    doc.text(`Statement period ${fmtDate(rec.periodStart)} – ${fmtDate(rec.periodEnd)}`, 40, 84);
    doc.text(
      `${rec.status === "FINISHED" ? `Reconciled${rec.finishedAt ? ` ${fmtStamp(rec.finishedAt)}` : ""}` : "In progress"}`,
      40,
      100,
    );

    autoTable(doc, {
      startY: 120,
      head: [["", "Amount"]],
      body: [
        ["Opening cleared balance", formatCents(live.openingClearedCents)],
        [`Cleared this period (${live.clearedCount})`, formatCents(live.clearedBalanceCents - live.openingClearedCents)],
        ["Ledger cleared balance", formatCents(live.clearedBalanceCents)],
        ["Statement ending balance", formatCents(live.statementEndingCents)],
        ["Difference", formatCents(live.differenceCents)],
        [`Still uncleared (${live.unclearedCount})`, ""],
      ],
      theme: "plain",
      styles: { fontSize: 10 },
      columnStyles: { 1: { halign: "right" } },
    });

    const afterSummary = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 240;
    autoTable(doc, {
      startY: afterSummary + 24,
      head: [["Date", "Description", "Debit", "Credit", "Cleared"]],
      body: rec.lines.map((l) => [
        fmtDate(l.entryDate),
        (l.memo ?? "").slice(0, 60),
        l.debitCents ? formatCents(l.debitCents) : "",
        l.creditCents ? formatCents(l.creditCents) : "",
        l.cleared ? "Yes" : "",
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [31, 31, 35] },
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "center" } },
    });

    doc.save(`reconciliation-${rec.accountNumber}-${rec.periodEnd}.pdf`);
  }

  if (accounts === null) return <SkeletonList rows={6} />;

  if (accounts.length === 0) {
    return (
      <div className="bg-surface rounded-xl border border-app-border px-4 py-10 text-center">
        <p className="text-sm text-text-primary">No accounts to reconcile yet</p>
        <p className="text-[12px] text-text-muted mt-1 max-w-md mx-auto">
          Connect a bank or card, or add one by hand, and each gets its own account in the chart of accounts to reconcile
          against.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h2 className="text-base font-medium text-text-primary">Reconcile</h2>
        <p className="text-[12px] text-text-muted mt-0.5 max-w-xl">
          Tick off what appears on the statement. When the difference reaches $0.00 the month ties out and you can
          finish it.
        </p>
      </div>

      {/* Account + month */}
      <div className="flex items-end gap-2 flex-wrap">
        <div>
          <label className="block text-[12px] text-text-muted mb-1">Account</label>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.number} {a.name}
                {a.isCard ? " (card)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[12px] text-text-muted mb-1">Statement month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
          />
        </div>
        <div>
          <label className="block text-[12px] text-text-muted mb-1">Statement ending balance</label>
          <input
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            onBlur={() => canEdit && !finished && void saveStatement()}
            inputMode="decimal"
            placeholder="0.00"
            disabled={finished || !canEdit}
            className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white tabular-nums disabled:opacity-60 w-40"
          />
        </div>
        {rec && (
          <button
            onClick={exportPdf}
            className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-muted hover:text-text-primary inline-flex items-center gap-1.5"
          >
            <FileDown className="h-4 w-4" /> PDF
          </button>
        )}
      </div>

      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}

      {loading ? (
        <SkeletonList rows={6} />
      ) : !rec ? (
        <p className="text-[12px] text-text-muted">Pick an account and month to begin.</p>
      ) : (
        <>
          {/* The difference — the number the whole screen is about */}
          <div
            className={`rounded-xl border px-4 py-3 ${
              live?.balanced ? "border-lime-accent bg-lime-accent/10" : "border-orange-accent bg-orange-accent/10"
            }`}
          >
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-[12px] text-text-muted">Opening cleared</p>
                <p className="tabular-nums text-text-primary">{formatCents(live!.openingClearedCents)}</p>
              </div>
              <div>
                <p className="text-[12px] text-text-muted">Cleared balance</p>
                <p className="tabular-nums text-text-primary">{formatCents(live!.clearedBalanceCents)}</p>
              </div>
              <div>
                <p className="text-[12px] text-text-muted">Statement says</p>
                <p className="tabular-nums text-text-primary">{formatCents(live!.statementEndingCents)}</p>
              </div>
              <div>
                <p className="text-[12px] text-text-muted">Difference</p>
                <p className={`tabular-nums font-medium ${live!.balanced ? "text-charcoal" : "text-orange-accent"}`}>
                  {formatCents(live!.differenceCents)}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-app-border/60 flex-wrap">
              <p className="text-[12px] text-text-muted">
                {live!.clearedCount} cleared · {live!.unclearedCount} still outstanding
                {finished && rec.finishedAt ? ` · reconciled ${fmtStamp(rec.finishedAt)}` : ""}
              </p>
              {finished ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-charcoal inline-flex items-center gap-1.5">
                    <Lock className="h-4 w-4" /> Reconciled
                  </span>
                  {canEdit && !confirmUndo && (
                    <button onClick={() => setConfirmUndo(true)} className="text-[12px] text-text-muted hover:text-text-primary inline-flex items-center gap-1">
                      <RotateCcw className="h-3.5 w-3.5" /> Undo
                    </button>
                  )}
                </div>
              ) : (
                canEdit && (
                  <button
                    onClick={() => rec.id && act({ action: "finish", reconciliationId: rec.id })}
                    disabled={busy || !live!.balanced || !rec.id}
                    title={blocked ?? undefined}
                    className="text-sm px-4 py-2 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <CheckCircle2 className="h-4 w-4" /> Finish at $0.00
                  </button>
                )
              )}
            </div>
            {!finished && blocked && <p className="text-[12px] text-orange-accent mt-2">{blocked}</p>}
          </div>

          {confirmUndo && (
            <div className="rounded-xl border border-app-border bg-surface px-4 py-3 space-y-2">
              <p className="text-sm text-text-primary">Reopen this reconciliation?</p>
              <p className="text-[12px] text-text-muted">
                The ticks are kept. Reopening unfreezes these lines so their entries can be voided again, and it&apos;s
                recorded in the history with your name.
              </p>
              <input
                value={undoReason}
                onChange={(e) => setUndoReason(e.target.value)}
                placeholder="Why? (optional, saved in the history)"
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    if (!rec.id) return;
                    await act({ action: "undo", reconciliationId: rec.id, reason: undoReason || null });
                    setConfirmUndo(false);
                    setUndoReason("");
                  }}
                  disabled={busy}
                  className="text-sm px-3 py-1.5 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white disabled:opacity-50"
                >
                  Reopen it
                </button>
                <button onClick={() => setConfirmUndo(false)} className="text-sm px-3 py-1.5 text-text-muted">
                  Keep it reconciled
                </button>
              </div>
            </div>
          )}

          {/* Lines */}
          <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
            {rec.lines.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12px] text-text-muted">
                Nothing posted to this account in that period yet.
              </p>
            ) : (
              <>
                <table className="w-full hidden sm:table">
                  <thead>
                    <tr className="text-left text-[12px] text-text-muted border-b border-app-border">
                      <th className="px-4 py-2 font-medium w-16">Clear</th>
                      <th className="px-4 py-2 font-medium w-28">Date</th>
                      <th className="px-4 py-2 font-medium">Description</th>
                      <th className="px-4 py-2 font-medium w-28 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rec.lines.map((l) => (
                      <tr key={l.lineId} className="border-b border-app-border last:border-0 text-sm">
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={l.cleared}
                            disabled={finished || !canEdit || l.lockedElsewhere || busy}
                            onChange={() => void toggle(l)}
                            className="rounded border-app-border disabled:opacity-50"
                            aria-label={`Mark ${l.memo ?? "line"} cleared`}
                          />
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-text-muted whitespace-nowrap">{fmtDate(l.entryDate)}</td>
                        <td className="px-4 py-2.5">
                          <span className="text-text-primary">{l.memo || "Journal entry"}</span>
                          {l.lockedElsewhere && (
                            <span className="ml-2 text-[12px] text-text-muted inline-flex items-center gap-0.5">
                              <Lock className="h-3 w-3" /> reconciled elsewhere
                            </span>
                          )}
                          {l.reference && <p className="text-[12px] text-text-muted mt-0.5">{l.reference}</p>}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-text-primary">
                          {formatCents(l.signedCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <ul className="sm:hidden divide-y divide-app-border">
                  {rec.lines.map((l) => (
                    <li key={l.lineId} className="px-4 py-3 flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={l.cleared}
                        disabled={finished || !canEdit || l.lockedElsewhere || busy}
                        onChange={() => void toggle(l)}
                        className="rounded border-app-border mt-0.5 disabled:opacity-50"
                        aria-label={`Mark ${l.memo ?? "line"} cleared`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-primary truncate">{l.memo || "Journal entry"}</p>
                        <p className="text-[12px] text-text-muted mt-0.5">
                          {fmtDate(l.entryDate)}
                          {l.lockedElsewhere ? " · reconciled elsewhere" : ""}
                        </p>
                      </div>
                      <span className="text-sm tabular-nums text-text-primary shrink-0">{formatCents(l.signedCents)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
