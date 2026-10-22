"use client";

// Financials → Books → 1099 (Accounting Phase 3, task 6).
//
// Who the club paid as a contractor this year, how much, and which of them
// crossed the reporting threshold. It FILES NOTHING — it is a report and a CSV.
//
// ⚠️  There is no tax identification number here, and none is stored anywhere
// in AthletixOS. The brief required a TIN to be encrypted at rest, masked,
// owner-only and never logged, and to stop and propose a design if the repo
// had no field-level encryption. It has none. The proposed design is written up
// in docs/accounting/plan.md under "1099 — the TIN question"; until it is
// approved and built, the TIN and the payee's address come off the W-9.
//
// Mobile: the table scrolls, the detail rows stack.
import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, Download, FileWarning, Loader2 } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { formatCents, parseDollarsToCents } from "@/lib/ledger";

type Payment = {
  id: string;
  source: string;
  date: string;
  amountCents: number;
  method: string | null;
  description: string | null;
};
type Row = {
  contractorId: string;
  contractorName: string;
  email: string | null;
  totalCents: number;
  paymentCount: number;
  unknownMethodCents: number;
  unknownMethodCount: number;
  overThreshold: boolean;
  missingW9: boolean;
  payments: Payment[];
};
type Report = {
  year: number;
  thresholdCents: number;
  thresholdNote: string;
  thresholdIsOverridden: boolean;
  rows: Row[];
  reportableCount: number;
  reportableTotalCents: number;
  excluded: (Payment & { contractorName: string; reason: string })[];
  excludedTotalCents: number;
  suspectedDuplicates: { a: Payment & { contractorName: string }; b: Payment; reason: string }[];
  unknownMethodTotalCents: number;
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

export default function Form1099Tab({ canEdit }: { canEdit: boolean }) {
  const [year, setYear] = useState<number | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/form1099${year ? `?year=${year}` : ""}`, {
        cache: "no-store",
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Couldn't load the 1099 report.");
        setReport(null);
      } else {
        setReport(d.report);
        setYears(d.years ?? []);
        if (year === null) setYear(d.report?.year ?? null);
      }
    } catch {
      setErr("Couldn't load the 1099 report.");
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveThreshold = async (clear = false) => {
    if (!report) return;
    const cents = clear ? null : parseDollarsToCents(thresholdInput);
    if (!clear && cents === null) {
      setErr("Type the threshold as a dollar amount.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/form1099", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: report.year, thresholdCents: cents }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || d.message || "Couldn't save that threshold.");
      else {
        setReport(d.report);
        setEditingThreshold(false);
        setThresholdInput("");
      }
    } catch {
      setErr("Couldn't save that threshold.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-text-primary">1099 contractors</h2>
          <p className="mt-0.5 max-w-2xl text-[12px] text-text-muted">
            Who you paid as a contractor and who crossed the reporting threshold. This is a report —
            AthletixOS does not file anything with the IRS.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={year ?? ""}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-app-border bg-surface px-3 py-2 text-sm"
            aria-label="Tax year"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <a
            href={`/api/financials/ledger/form1099?year=${report?.year ?? ""}&format=csv`}
            className="inline-flex items-center gap-1 rounded-lg border border-app-border px-3 py-2 text-xs text-text-primary hover:bg-app-bg"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} /> CSV
          </a>
        </div>
      </div>

      {/* The one thing a reader must not be left guessing about. */}
      <div className="flex items-start gap-2 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-[12px] text-text-muted">
        <FileWarning className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
        <span>
          <strong className="text-text-primary">No tax ID numbers are stored.</strong> AthletixOS has no
          encryption for a field that sensitive yet, so a TIN is not kept here — take it, and the payee&apos;s
          address, from their W-9 when you fill the form. A W-9 you&apos;ve uploaded against a contractor is
          flagged below.
        </span>
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

      {loading ? (
        <SkeletonList rows={6} />
      ) : !report ? null : (
        <>
          <div className="rounded-xl border border-app-border bg-surface px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <p className="text-sm text-text-primary">
                <strong>{report.reportableCount}</strong>{" "}
                {report.reportableCount === 1 ? "contractor needs" : "contractors need"} a 1099 for{" "}
                {report.year}, totalling {formatCents(report.reportableTotalCents)}.
              </p>
              <p className="text-[12px] text-text-muted">
                Threshold {formatCents(report.thresholdCents)}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingThreshold((v) => !v);
                      setThresholdInput((report.thresholdCents / 100).toFixed(2));
                    }}
                    className="ml-1 text-brand underline hover:no-underline"
                  >
                    change
                  </button>
                )}
              </p>
            </div>
            <p className="mt-1 text-[12px] text-text-muted">{report.thresholdNote}</p>

            {editingThreshold && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={thresholdInput}
                  onChange={(e) => setThresholdInput(e.target.value)}
                  inputMode="decimal"
                  className="w-32 rounded-lg border border-app-border bg-surface px-3 py-1.5 text-sm"
                  aria-label={`Threshold for ${report.year}`}
                />
                <button
                  type="button"
                  onClick={() => saveThreshold(false)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-3 py-1.5 text-xs text-white hover:bg-charcoal-hover disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />} Save for {report.year}
                </button>
                {report.thresholdIsOverridden && (
                  <button
                    type="button"
                    onClick={() => saveThreshold(true)}
                    disabled={busy}
                    className="rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg disabled:opacity-50"
                  >
                    Back to the statutory amount
                  </button>
                )}
              </div>
            )}
          </div>

          {report.suspectedDuplicates.length > 0 && (
            <div className="rounded-lg border border-orange-accent/40 bg-orange-accent/5 px-3 py-2 text-[12px]">
              <p className="flex items-start gap-2 text-text-primary">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-accent" strokeWidth={2} />
                <span>
                  <strong>
                    {report.suspectedDuplicates.length}{" "}
                    {report.suspectedDuplicates.length === 1 ? "payment" : "payments"} may be recorded twice.
                  </strong>{" "}
                  Contractor money lives both on the contractor&apos;s payment log and on the payouts page, and
                  nothing links the two. These are counted once each in the totals above, so if any pair is
                  really one payment the total is too high — check and remove the duplicate.
                </span>
              </p>
              <ul className="mt-1 space-y-0.5 pl-6 text-text-muted">
                {report.suspectedDuplicates.map((d) => (
                  <li key={`${d.a.id}-${d.b.id}`}>
                    {d.a.contractorName} · {formatCents(d.a.amountCents)} · {fmtDate(d.a.date)} and{" "}
                    {fmtDate(d.b.date)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.unknownMethodTotalCents > 0 && (
            <p className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-[12px] text-text-muted">
              {formatCents(report.unknownMethodTotalCents)} was paid with no payment method recorded. It is
              counted here, because leaving it out on a guess would under-report. If any of it was paid by
              card, the processor reports that money on a 1099-K and it should come off these totals.
            </p>
          )}

          {report.excluded.length > 0 && (
            <p className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-[12px] text-text-muted">
              {formatCents(report.excludedTotalCents)} across {report.excluded.length}{" "}
              {report.excluded.length === 1 ? "payment" : "payments"} was left out because it was paid by card
              or through a processor — that money is reported on a 1099-K by the processor, not by you.
            </p>
          )}

          {report.rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">
              No contractor payments recorded for {report.year}.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-app-bg text-xs uppercase tracking-wide text-text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">Contractor</th>
                      <th className="px-3 py-2 text-left">W-9</th>
                      <th className="px-3 py-2 text-right">Payments</th>
                      <th className="px-3 py-2 text-right">Total paid</th>
                      <th className="px-3 py-2 text-left">1099 needed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      // Fragment, not <>: a keyed list item needs a key, and
                      // the shorthand cannot carry one.
                      <Fragment key={r.contractorId}>
                        <tr className="border-t border-app-border">
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => setOpen(open === r.contractorId ? null : r.contractorId)}
                              className="inline-flex items-center gap-1 text-left text-text-primary hover:text-brand"
                            >
                              <ChevronRight
                                className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
                                  open === r.contractorId ? "rotate-90" : ""
                                }`}
                                strokeWidth={2}
                              />
                              {r.contractorName}
                            </button>
                            {r.email && <span className="block pl-5 text-[12px] text-text-muted">{r.email}</span>}
                          </td>
                          <td className="px-3 py-2 text-[12px]">
                            {r.missingW9 ? (
                              <span className="text-orange-accent">Not on file</span>
                            ) : (
                              <span className="text-text-muted">On file</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-text-muted">{r.paymentCount}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {formatCents(r.totalCents)}
                            {r.unknownMethodCents > 0 && (
                              <span className="block text-[12px] font-normal text-text-muted">
                                {formatCents(r.unknownMethodCents)} method unknown
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-[12px]">
                            {r.overThreshold ? (
                              <span className="rounded-md bg-lime-accent/25 px-2 py-0.5 text-charcoal">Yes</span>
                            ) : (
                              <span className="text-text-muted">Under the threshold</span>
                            )}
                          </td>
                        </tr>
                        {open === r.contractorId && (
                          <tr className="border-t border-app-border bg-app-bg/40">
                            <td colSpan={5} className="px-3 py-2">
                              <table className="w-full text-[12px]">
                                <tbody>
                                  {r.payments.map((p) => (
                                    <tr key={p.id}>
                                      <td className="py-1 pr-3 tabular-nums text-text-muted">{fmtDate(p.date)}</td>
                                      <td className="py-1 pr-3 text-text-primary">{p.description ?? ""}</td>
                                      <td className="py-1 pr-3 text-text-muted">
                                        {p.method ?? "method not recorded"}
                                      </td>
                                      <td className="py-1 pr-3 text-text-muted">
                                        {p.source === "PAYOUT" ? "Payouts page" : "Contractor log"}
                                      </td>
                                      <td className="py-1 text-right tabular-nums text-text-primary">
                                        {formatCents(p.amountCents)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
