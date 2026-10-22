"use client";

// Financials → Books → Reports (Accounting Phase 3, task 2).
//
// Five statements off the ledger — trial balance, general ledger, balance
// sheet, P&L, cash flow (indirect) — filtered by date range, entity, program
// and cash/accrual basis, with a column per month on the P&L.
//
// Every figure drills down. Clicking an amount opens the journal lines behind
// it, and from there "Open in Journal" deep-links to the existing Journal tab
// with the same account and dates — so a number is never a dead end.
//
// The statements say whether they tie, in words, at the top. A balance sheet
// that silently doesn't balance is worse than one that refuses, because the
// first one gets filed; so when it doesn't, this says so in red before the
// reader sees any of the numbers.
//
// Mobile: the filter bar and every table scroll horizontally, the statement
// picker wraps, and the drill-down is a sheet rather than a centred dialog.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { formatCents } from "@/lib/ledger";
import { STATEMENT_LABELS, STATEMENT_KEYS, type StatementKey } from "@/lib/glReportsExport";

type Options = {
  entities: { id: string; name: string }[];
  programs: string[];
  booksStartDate: string | null;
  earliestEntryDate: string | null;
};
type TbRow = {
  accountId: string;
  number: string;
  name: string;
  type: string;
  debitCents: number;
  creditCents: number;
};
type Tb = {
  rows: TbRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  differenceCents: number;
  balanced: boolean;
  basisNote: string;
};
type GlRow = {
  entryId: string;
  entryDate: string;
  reference: string | null;
  memo: string | null;
  lineMemo: string | null;
  sourceType: string;
  program: string | null;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};
type GlAcct = {
  accountId: string;
  number: string;
  name: string;
  openingCents: number;
  rows: GlRow[];
  debitCents: number;
  creditCents: number;
  closingCents: number;
};
type Gl = { accounts: GlAcct[]; basisNote: string };
type StmtLine = { accountId: string; number: string; name: string; cells: number[]; totalCents: number };
type StmtSection = { key: string; label: string; lines: StmtLine[]; cells: number[]; totalCents: number };
type Bs = {
  asOf: string;
  assets: StmtSection;
  liabilities: StmtSection;
  equity: StmtSection;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
  differenceCents: number;
  balanced: boolean;
  basisNote: string;
  fiscalYearStart: string;
};
type Pnl = {
  columns: { key: string; label: string }[];
  income: StmtSection;
  costOfSales: StmtSection;
  grossProfit: { cells: number[]; totalCents: number };
  expenses: StmtSection;
  netIncome: { cells: number[]; totalCents: number };
  basisNote: string;
};
type CfLine = { label: string; accountId: string | null; amountCents: number };
type CfSection = { key: string; label: string; lines: CfLine[]; totalCents: number };
type Cf = {
  from: string;
  to: string;
  netIncomeCents: number;
  depreciationCents: number;
  operating: CfSection;
  investing: CfSection;
  financing: CfSection;
  netChangeCents: number;
  openingCashCents: number;
  closingCashCents: number;
  actualChangeCents: number;
  differenceCents: number;
  ties: boolean;
  basisNote: string;
  noBankAccountsMapped: boolean;
};
type Drill = {
  account: { id: string; number: string; name: string } | null;
  rows: GlRow[];
  debitCents: number;
  creditCents: number;
  from: string | null;
  to: string | null;
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/// A figure that drills down. Rendered as a button rather than styled text so
/// it is reachable by keyboard and announced as an action.
function Amount({
  cents,
  onClick,
  bold,
}: {
  cents: number;
  onClick?: () => void;
  bold?: boolean;
}) {
  const text = formatCents(cents);
  const cls = `tabular-nums ${bold ? "font-semibold" : ""} ${cents < 0 ? "text-orange-accent" : ""}`;
  if (!onClick) return <span className={cls}>{text}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${cls} underline decoration-dotted underline-offset-2 hover:text-brand`}
      title="Show the journal entries behind this figure"
    >
      {text}
    </button>
  );
}

function TieBanner({ ok, label, differenceCents }: { ok: boolean; label: string; differenceCents: number }) {
  if (ok) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-xs text-text-muted">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-lime-accent" strokeWidth={2} />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
      <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2} />
      <span>
        <strong>{label}</strong> Off by {formatCents(differenceCents)}. Don&apos;t file this — tell whoever
        maintains the books, because a statement this far out usually means an entry was posted outside
        the ledger service.
      </span>
    </div>
  );
}

export default function ReportsTab({
  entity,
  from,
  to,
  onOpenJournal,
}: {
  entity: string;
  from: string;
  to: string;
  onOpenJournal: (q: { account: string; from: string; to: string }) => void;
}) {
  const [statement, setStatement] = useState<StatementKey>("trial-balance");
  const [basis, setBasis] = useState<"accrual" | "cash">("accrual");
  const [program, setProgram] = useState("all");
  const [byMonth, setByMonth] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [data, setData] = useState<Tb | Gl | Bs | Pnl | Cf | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (entity && entity !== "all") p.set("entity", entity);
    if (program !== "all") p.set("program", program);
    p.set("basis", basis);
    return p.toString();
  }, [from, to, entity, program, basis]);

  useEffect(() => {
    fetch("/api/financials/ledger/reports?statement=options")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setOptions(d))
      .catch(() => setOptions(null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const extra = statement === "pnl" && byMonth ? "&byMonth=1" : "";
      const r = await fetch(`/api/financials/ledger/reports?statement=${statement}&${qs}${extra}`);
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        setErr(body?.error || body?.message || "Couldn't load this statement.");
        setData(null);
      } else {
        setData(await r.json());
      }
    } catch {
      setErr("Couldn't load this statement.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [statement, qs, byMonth]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDrill = useCallback(
    async (accountId: string, range?: { from: string; to: string }) => {
      setDrillLoading(true);
      setDrill(null);
      const p = new URLSearchParams(qs);
      if (range) {
        p.set("from", range.from);
        p.set("to", range.to);
      }
      // A balance sheet is cumulative, so its drill-down must be too or the
      // lines shown won't add up to the figure that was clicked.
      if (statement === "balance-sheet") p.delete("from");
      try {
        const r = await fetch(
          `/api/financials/ledger/reports?statement=drilldown&account=${encodeURIComponent(accountId)}&${p.toString()}`,
        );
        setDrill(r.ok ? await r.json() : null);
      } catch {
        setDrill(null);
      } finally {
        setDrillLoading(false);
      }
    },
    [qs, statement],
  );

  const exportHref = (format: "csv" | "xlsx") =>
    `/api/financials/ledger/reports/export?statement=${statement}&format=${format}&${qs}${
      statement === "pnl" && byMonth ? "&byMonth=1" : ""
    }`;
  const packageYear = (to || from || new Date().toISOString()).slice(0, 4);

  return (
    <div className="space-y-4">
      {/* Statement picker + exports */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-app-bg p-1">
          {STATEMENT_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setStatement(k);
                setExpanded(new Set());
              }}
              className={`rounded-md px-3 py-1 text-xs ${
                statement === k ? "bg-surface shadow-sm font-medium text-text-primary" : "text-text-muted"
              }`}
            >
              {STATEMENT_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <a
            href={exportHref("csv")}
            className="inline-flex items-center gap-1 rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} /> CSV
          </a>
          <a
            href={exportHref("xlsx")}
            className="inline-flex items-center gap-1 rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} /> Excel
          </a>
          <a
            href={`/api/financials/ledger/reports/export?package=cpa&year=${packageYear}&${qs}`}
            className="inline-flex items-center gap-1 rounded-lg bg-charcoal px-3 py-1.5 text-xs text-white hover:bg-charcoal-hover"
            title={`Trial balance, general ledger, balance sheet and P&L for ${packageYear}, as one Excel workbook`}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} /> CPA package {packageYear}
          </a>
        </div>
      </div>

      {/* Filters */}
      <div className="-mx-1 overflow-x-auto px-1">
        <div className="flex min-w-max items-center gap-2 text-xs">
          <div className="flex gap-1 rounded-lg bg-app-bg p-1">
            {(["accrual", "cash"] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBasis(b)}
                className={`rounded-md px-3 py-1 capitalize ${
                  basis === b ? "bg-surface shadow-sm font-medium text-text-primary" : "text-text-muted"
                }`}
              >
                {b}
              </button>
            ))}
          </div>
          {options && options.programs.length > 0 && (
            <select
              value={program}
              onChange={(e) => setProgram(e.target.value)}
              className="rounded-lg border border-app-border bg-surface px-2 py-1.5 text-xs text-text-primary"
            >
              <option value="all">All programs</option>
              {options.programs.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          {statement === "pnl" && (
            <label className="flex items-center gap-1.5 text-text-muted">
              <input type="checkbox" checked={byMonth} onChange={(e) => setByMonth(e.target.checked)} />
              A column per month
            </label>
          )}
          {options?.booksStartDate && (
            <span className="text-text-muted">Books start {fmtDate(options.booksStartDate)}</span>
          )}
        </div>
      </div>

      {data && "basisNote" in data && (
        <p className="text-xs text-text-muted">{(data as { basisNote: string }).basisNote}</p>
      )}

      {err && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{err}</div>
      )}

      {loading ? (
        <SkeletonList rows={8} />
      ) : !data ? null : statement === "trial-balance" ? (
        <TrialBalanceView tb={data as Tb} onDrill={openDrill} />
      ) : statement === "general-ledger" ? (
        <GeneralLedgerView
          gl={data as Gl}
          expanded={expanded}
          onToggle={(id) =>
            setExpanded((s) => {
              const next = new Set(s);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onOpenJournal={(accountId) => onOpenJournal({ account: accountId, from, to })}
        />
      ) : statement === "balance-sheet" ? (
        <BalanceSheetView bs={data as Bs} onDrill={openDrill} />
      ) : statement === "pnl" ? (
        <PnlView pnl={data as Pnl} onDrill={openDrill} />
      ) : (
        <CashFlowView cf={data as Cf} onDrill={openDrill} />
      )}

      {(drill || drillLoading) && (
        <DrillSheet
          drill={drill}
          loading={drillLoading}
          onClose={() => setDrill(null)}
          onOpenJournal={() => {
            if (drill?.account) onOpenJournal({ account: drill.account.id, from, to });
            setDrill(null);
          }}
        />
      )}
    </div>
  );
}

// ── Trial balance ───────────────────────────────────────────────────────────

function TrialBalanceView({ tb, onDrill }: { tb: Tb; onDrill: (id: string) => void }) {
  return (
    <div className="space-y-3">
      <TieBanner
        ok={tb.balanced}
        label={tb.balanced ? "Debits equal credits." : "This trial balance is out of balance."}
        differenceCents={tb.differenceCents}
      />
      <div className="overflow-x-auto rounded-xl border border-app-border bg-surface">
        <table className="w-full min-w-[32rem] text-sm">
          <thead className="bg-app-bg text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-3 py-2 text-left">Account</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => (
              <tr key={r.accountId} className="border-t border-app-border">
                <td className="px-3 py-2">
                  <span className="tabular-nums text-text-muted">{r.number}</span>{" "}
                  <span className="text-text-primary">{r.name}</span>
                </td>
                <td className="px-3 py-2 text-right">
                  {r.debitCents ? <Amount cents={r.debitCents} onClick={() => onDrill(r.accountId)} /> : null}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.creditCents ? <Amount cents={r.creditCents} onClick={() => onDrill(r.accountId)} /> : null}
                </td>
              </tr>
            ))}
            {tb.rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-sm text-text-muted">
                  Nothing posted in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t-2 border-app-border bg-app-bg">
            <tr>
              <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Total</td>
              <td className="px-3 py-2 text-right">
                <Amount cents={tb.totalDebitCents} bold />
              </td>
              <td className="px-3 py-2 text-right">
                <Amount cents={tb.totalCreditCents} bold />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── General ledger ──────────────────────────────────────────────────────────

function GeneralLedgerView({
  gl,
  expanded,
  onToggle,
  onOpenJournal,
}: {
  gl: Gl;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onOpenJournal: (accountId: string) => void;
}) {
  if (gl.accounts.length === 0) {
    return <p className="py-6 text-center text-sm text-text-muted">Nothing posted in this period.</p>;
  }
  return (
    <div className="space-y-2">
      {gl.accounts.map((a) => {
        const open = expanded.has(a.accountId);
        return (
          <div key={a.accountId} className="overflow-hidden rounded-xl border border-app-border bg-surface">
            <button
              type="button"
              onClick={() => onToggle(a.accountId)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-app-bg"
            >
              <ChevronRight
                className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${open ? "rotate-90" : ""}`}
                strokeWidth={2}
              />
              <span className="tabular-nums text-xs text-text-muted">{a.number}</span>
              <span className="truncate text-sm text-text-primary">{a.name}</span>
              <span className="ml-auto shrink-0 text-xs text-text-muted">
                {a.rows.length} {a.rows.length === 1 ? "entry" : "entries"}
              </span>
              <span className="shrink-0 text-sm">
                <Amount cents={a.closingCents} bold />
              </span>
            </button>
            {open && (
              <div className="overflow-x-auto border-t border-app-border">
                <table className="w-full min-w-[44rem] text-xs">
                  <thead className="bg-app-bg uppercase tracking-wide text-text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Memo</th>
                      <th className="px-3 py-2 text-left">Reference</th>
                      <th className="px-3 py-2 text-right">Debit</th>
                      <th className="px-3 py-2 text-right">Credit</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-app-border bg-app-bg/50">
                      <td className="px-3 py-2 text-text-muted" colSpan={3}>
                        Opening balance
                      </td>
                      <td /> <td />
                      <td className="px-3 py-2 text-right">
                        <Amount cents={a.openingCents} />
                      </td>
                    </tr>
                    {a.rows.map((r) => (
                      <tr key={`${r.entryId}-${r.entryDate}-${r.debitCents}-${r.creditCents}`} className="border-t border-app-border">
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-muted">
                          {fmtDate(r.entryDate)}
                        </td>
                        <td className="px-3 py-2 text-text-primary">
                          {[r.memo, r.lineMemo].filter(Boolean).join(" · ") || (
                            <span className="text-text-muted">{r.sourceType}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-text-muted">{r.reference ?? ""}</td>
                        <td className="px-3 py-2 text-right">{r.debitCents ? formatCents(r.debitCents) : ""}</td>
                        <td className="px-3 py-2 text-right">{r.creditCents ? formatCents(r.creditCents) : ""}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCents(r.balanceCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-app-border bg-app-bg">
                    <tr>
                      <td className="px-3 py-2 font-semibold uppercase tracking-wide text-text-muted" colSpan={3}>
                        Closing balance
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCents(a.debitCents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCents(a.creditCents)}</td>
                      <td className="px-3 py-2 text-right">
                        <Amount cents={a.closingCents} bold />
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <div className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onOpenJournal(a.accountId)}
                    className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                  >
                    Open in Journal <ExternalLink className="h-3 w-3" strokeWidth={2} />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Balance sheet ───────────────────────────────────────────────────────────

function BalanceSheetView({ bs, onDrill }: { bs: Bs; onDrill: (id: string) => void }) {
  const section = (s: StmtSection, total: number) => (
    <div key={s.key} className="overflow-hidden rounded-xl border border-app-border bg-surface">
      <div className="bg-app-bg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        {s.label}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {s.lines.map((l) => (
            <tr key={l.accountId} className="border-t border-app-border">
              <td className="px-3 py-2">
                {l.number && <span className="tabular-nums text-text-muted">{l.number} </span>}
                <span className="text-text-primary">{l.name}</span>
              </td>
              <td className="px-3 py-2 text-right">
                {/* The derived equity lines have no account to drill into. */}
                {l.accountId.startsWith("__") ? (
                  <Amount cents={l.totalCents} />
                ) : (
                  <Amount cents={l.totalCents} onClick={() => onDrill(l.accountId)} />
                )}
              </td>
            </tr>
          ))}
          {s.lines.length === 0 && (
            <tr>
              <td className="px-3 py-3 text-sm text-text-muted" colSpan={2}>
                Nothing here.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className="border-t-2 border-app-border bg-app-bg">
          <tr>
            <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Total {s.label.toLowerCase()}
            </td>
            <td className="px-3 py-2 text-right">
              <Amount cents={total} bold />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );

  return (
    <div className="space-y-3">
      <TieBanner
        ok={bs.balanced}
        label={
          bs.balanced
            ? `Assets equal liabilities plus equity, as of ${fmtDate(bs.asOf)}.`
            : "This balance sheet does not balance."
        }
        differenceCents={bs.differenceCents}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {section(bs.assets, bs.totalAssetsCents)}
        <div className="space-y-3">
          {section(bs.liabilities, bs.totalLiabilitiesCents)}
          {section(bs.equity, bs.totalEquityCents)}
        </div>
      </div>
      <p className="text-xs text-text-muted">
        Current-year earnings appear as their own equity line. The ledger posts no year-end closing
        entry, so income and expense accounts keep their balances and the balance sheet folds them into
        equity itself — that is what makes it balance. The current year here runs from{" "}
        {fmtDate(bs.fiscalYearStart)} (AthletixOS treats the fiscal year as the calendar year).
      </p>
    </div>
  );
}

// ── Profit & loss ───────────────────────────────────────────────────────────

function PnlView({ pnl, onDrill }: { pnl: Pnl; onDrill: (id: string) => void }) {
  const multi = pnl.columns.length > 1;
  const cols = pnl.columns;

  const row = (l: StmtLine, drillable: boolean) => (
    <tr key={l.accountId} className="border-t border-app-border">
      <td className="px-3 py-2">
        <span className="tabular-nums text-text-muted">{l.number}</span>{" "}
        <span className="text-text-primary">{l.name}</span>
      </td>
      {multi &&
        l.cells.map((c, i) => (
          <td key={cols[i]?.key ?? i} className="px-3 py-2 text-right">
            {c ? <Amount cents={c} /> : <span className="text-text-muted">—</span>}
          </td>
        ))}
      <td className="px-3 py-2 text-right">
        {drillable ? <Amount cents={l.totalCents} onClick={() => onDrill(l.accountId)} /> : <Amount cents={l.totalCents} />}
      </td>
    </tr>
  );

  const totalRow = (label: string, cells: number[], total: number, strong = false) => (
    <tr className={`border-t-2 border-app-border ${strong ? "bg-app-bg" : "bg-app-bg/50"}`}>
      <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</td>
      {multi &&
        cells.map((c, i) => (
          <td key={cols[i]?.key ?? i} className="px-3 py-2 text-right">
            <Amount cents={c} bold={strong} />
          </td>
        ))}
      <td className="px-3 py-2 text-right">
        <Amount cents={total} bold />
      </td>
    </tr>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-app-border bg-surface">
      <table className="w-full min-w-[32rem] text-sm">
        <thead className="bg-app-bg text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Account</th>
            {multi && cols.map((c) => <th key={c.key} className="whitespace-nowrap px-3 py-2 text-right">{c.label}</th>)}
            <th className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {pnl.income.lines.map((l) => row(l, true))}
          {totalRow("Total income", pnl.income.cells, pnl.income.totalCents)}
          {pnl.costOfSales.lines.length > 0 && (
            <>
              {pnl.costOfSales.lines.map((l) => row(l, true))}
              {totalRow("Total cost of sales", pnl.costOfSales.cells, pnl.costOfSales.totalCents)}
              {totalRow("Gross profit", pnl.grossProfit.cells, pnl.grossProfit.totalCents)}
            </>
          )}
          {pnl.expenses.lines.map((l) => row(l, true))}
          {totalRow("Total operating expenses", pnl.expenses.cells, pnl.expenses.totalCents)}
          {totalRow("Net income", pnl.netIncome.cells, pnl.netIncome.totalCents, true)}
        </tbody>
      </table>
    </div>
  );
}

// ── Cash flow ───────────────────────────────────────────────────────────────

function CashFlowView({ cf, onDrill }: { cf: Cf; onDrill: (id: string) => void }) {
  const section = (s: CfSection) => (
    <tbody key={s.key}>
      <tr className="border-t border-app-border bg-app-bg">
        <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted" colSpan={2}>
          {s.label}
        </td>
      </tr>
      {s.lines.map((l) => (
        <tr key={l.label} className="border-t border-app-border">
          <td className="px-3 py-2 text-text-primary">{l.label}</td>
          <td className="px-3 py-2 text-right">
            {l.accountId ? (
              <Amount cents={l.amountCents} onClick={() => onDrill(l.accountId as string)} />
            ) : (
              <Amount cents={l.amountCents} />
            )}
          </td>
        </tr>
      ))}
      {s.lines.length === 0 && (
        <tr className="border-t border-app-border">
          <td className="px-3 py-2 text-text-muted" colSpan={2}>
            Nothing in this period.
          </td>
        </tr>
      )}
      <tr className="border-t border-app-border">
        <td className="px-3 py-2 text-xs font-semibold text-text-muted">
          Net cash from {s.label.toLowerCase()}
        </td>
        <td className="px-3 py-2 text-right">
          <Amount cents={s.totalCents} bold />
        </td>
      </tr>
    </tbody>
  );

  return (
    <div className="space-y-3">
      <TieBanner
        ok={cf.ties}
        label={
          cf.ties
            ? "The change this statement computes equals the change in the cash accounts."
            : "This statement does not tie to the movement in the cash accounts."
        }
        differenceCents={cf.differenceCents}
      />
      {cf.noBankAccountsMapped && (
        <p className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-xs text-text-muted">
          No bank account is linked to a ledger account yet, so &ldquo;cash&rdquo; here is only Undeposited
          Funds and Stripe Clearing. Link your accounts under Connections → Bank to see the full picture.
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-app-border bg-surface">
        <table className="w-full min-w-[28rem] text-sm">
          <tbody>
            <tr>
              <td className="px-3 py-2 text-text-primary">Net income</td>
              <td className="px-3 py-2 text-right">
                <Amount cents={cf.netIncomeCents} />
              </td>
            </tr>
          </tbody>
          {section(cf.operating)}
          {section(cf.investing)}
          {section(cf.financing)}
          <tfoot className="border-t-2 border-app-border bg-app-bg">
            <tr>
              <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                Net change in cash
              </td>
              <td className="px-3 py-2 text-right">
                <Amount cents={cf.netChangeCents} bold />
              </td>
            </tr>
            <tr className="border-t border-app-border">
              <td className="px-3 py-2 text-text-muted">Cash at start of {fmtDate(cf.from)}</td>
              <td className="px-3 py-2 text-right">
                <Amount cents={cf.openingCashCents} />
              </td>
            </tr>
            <tr className="border-t border-app-border">
              <td className="px-3 py-2 text-text-muted">Cash at {fmtDate(cf.to)}</td>
              <td className="px-3 py-2 text-right">
                <Amount cents={cf.closingCashCents} bold />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-text-muted">
        Indirect method. Depreciation is added back in operating activities as the movement in
        accumulated depreciation — it is the same figure as the depreciation expense ({formatCents(cf.depreciationCents)}
        ), counted once.
      </p>
    </div>
  );
}

// ── Drill-down ──────────────────────────────────────────────────────────────

function DrillSheet({
  drill,
  loading,
  onClose,
  onOpenJournal,
}: {
  drill: Drill | null;
  loading: boolean;
  onClose: () => void;
  onOpenJournal: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-t-2xl bg-surface sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-app-border px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">
              {drill?.account ? `${drill.account.number} ${drill.account.name}` : "Journal entries"}
            </p>
            {drill && (
              <p className="text-xs text-text-muted">
                {drill.rows.length} {drill.rows.length === 1 ? "line" : "lines"}
                {drill.from ? ` · ${fmtDate(drill.from)}` : ""}
                {drill.to ? ` – ${fmtDate(drill.to)}` : ""}
              </p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {drill?.account && (
              <button
                type="button"
                onClick={onOpenJournal}
                className="inline-flex items-center gap-1 rounded-lg border border-app-border px-2.5 py-1.5 text-xs text-text-primary hover:bg-app-bg"
              >
                Open in Journal <ExternalLink className="h-3 w-3" strokeWidth={2} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-text-muted hover:bg-app-bg"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="max-h-[70vh] overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> Loading
            </div>
          ) : !drill || drill.rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-muted">No entries behind this figure.</p>
          ) : (
            <table className="w-full min-w-[32rem] text-xs">
              <thead className="sticky top-0 bg-app-bg uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Memo</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {drill.rows.map((r, i) => (
                  <tr key={`${r.entryId}-${i}`} className="border-t border-app-border">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-muted">
                      {fmtDate(r.entryDate)}
                    </td>
                    <td className="px-3 py-2 text-text-primary">
                      {[r.memo, r.lineMemo].filter(Boolean).join(" · ") || (
                        <span className="text-text-muted">{r.sourceType}</span>
                      )}
                      {r.reference ? <span className="text-text-muted"> · {r.reference}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.debitCents ? formatCents(r.debitCents) : ""}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.creditCents ? formatCents(r.creditCents) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-app-border bg-app-bg">
                <tr>
                  <td className="px-3 py-2 font-semibold uppercase tracking-wide text-text-muted" colSpan={2}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Amount cents={drill.debitCents} bold />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Amount cents={drill.creditCents} bold />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
