"use client";

// Financials → Books → Moving in (Accounting Phase 3, tasks 7 and 9).
//
// Two jobs, both about arriving from QuickBooks:
//
//  1. The OPENING BALANCE. Upload the trial balance from the day before your
//     books start, map each account, check the preview, post it. One entry per
//     legal entity, dated that day. Income and expense balances roll into
//     retained earnings, because a mid-year trial balance carries year-to-date
//     trading and opening a revenue account with a balance would put last
//     year's trading into this year's first P&L.
//
//  2. HELD DUPLICATES. A QuickBooks-imported bank row and a live bank-feed row
//     with the same account, the same amount and dates within three days are
//     almost certainly one transaction. The imported one is held rather than
//     posted, because posting both would put the month out by the amount.
//
// The import REFUSES rather than plugging a difference. Every reason it can't
// post is listed at once, so the owner fixes everything in one pass instead of
// five round trips.
//
// Mobile: the mapping table scrolls, the uploader and blockers stack.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { formatCents } from "@/lib/ledger";

type Target = { id: string; number: string; name: string; type: string };
type TbRow = { idx: number; account: string; debitCents: number; creditCents: number };
type Parsed = {
  rows: TbRow[];
  accounts: string[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  problems: string[];
};
type Plan = {
  lines: { accountId: string; debitCents: number; creditCents: number; memo: string | null }[];
  retainedEarningsCents: number;
  skipped: { account: string; debitCents: number; creditCents: number }[];
  unmapped: string[];
  totalDebitCents: number;
  totalCreditCents: number;
  differenceCents: number;
  balanced: boolean;
};
type ImportView = {
  id: string;
  fileName: string;
  status: string;
  asOfDate: string | null;
  postedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  parsed: Parsed;
  mapping: Record<string, string | null>;
  accounts: Target[];
  plan: Plan | null;
  blockers: { code: string; message: string }[];
  booksStartDate: string | null;
  lockedThrough: string | null;
  legalEntityId: string | null;
  legalEntityName: string | null;
  hasClosedMonth: boolean;
};
type Held = {
  importedId: string;
  importedDate: string | null;
  importedName: string | null;
  amountCents: number;
  feedId: string | null;
  feedDate: string | null;
  feedName: string | null;
};
type Entity = { id: string; name: string };

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

export default function OnboardingTab({
  canEdit,
  entities,
  entity,
}: {
  canEdit: boolean;
  entities: Entity[];
  entity: string;
}) {
  const [list, setList] = useState<{ id: string; fileName: string; status: string; asOfDate: string | null }[]>([]);
  const [current, setCurrent] = useState<ImportView | null>(null);
  const [held, setHeld] = useState<Held[] | null>(null);
  const [entityId, setEntityId] = useState(() => (entity && entity !== "all" ? entity : entities[0]?.id ?? ""));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  const open = useCallback(
    async (id: string) => {
      const r = await fetch(
        `/api/financials/ledger/opening/${id}${entityId ? `?entity=${encodeURIComponent(entityId)}` : ""}`,
        { cache: "no-store" },
      );
      if (r.ok) setCurrent((await r.json()).import);
    },
    [entityId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const [lr, dr] = await Promise.all([
        fetch("/api/financials/ledger/opening", { cache: "no-store" }),
        fetch("/api/financials/ledger/duplicates", { cache: "no-store" }),
      ]);
      if (lr.ok) {
        const d = await lr.json();
        setList(d.imports ?? []);
        // The newest import that hasn't been voided is the one the owner is
        // working on; a club with only voided attempts still sees the latest.
        const latest = (d.imports ?? []).find((i: { status: string }) => i.status !== "VOIDED") ?? d.imports?.[0];
        if (latest) await open(latest.id);
        else setCurrent(null);
      } else {
        const d = await lr.json().catch(() => null);
        setErr(d?.error || "Couldn't load imports.");
      }
      if (dr.ok) setHeld((await dr.json()).held ?? []);
    } catch {
      setErr("Couldn't load imports.");
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setBusy("upload");
    setErr("");
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/financials/ledger/opening", { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "That file couldn't be read.");
      else await load();
    } catch {
      setErr("That file couldn't be read.");
    } finally {
      setBusy("");
    }
  };

  const patch = async (what: string, body: Record<string, unknown>) => {
    if (!current) return;
    setBusy(what);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/opening/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || d.message || "That didn't work.");
      else {
        setCurrent(d.import);
        setVoiding(false);
        setVoidReason("");
      }
    } catch {
      setErr("That didn't work.");
    } finally {
      setBusy("");
    }
  };

  const setMap = (qbName: string, target: string | null) => {
    if (!current) return;
    const next = { ...current.mapping, [qbName]: target };
    setCurrent({ ...current, mapping: next });
    void patch("mapping", { action: "mapping", mapping: next });
  };

  const dismissDuplicate = async (plaidTransactionId: string) => {
    setBusy(plaidTransactionId);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/duplicates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plaidTransactionId }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "Couldn't release that hold.");
      else setHeld(d.held ?? []);
    } catch {
      setErr("Couldn't release that hold.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-medium text-text-primary">Moving in from QuickBooks</h2>
        <p className="mt-0.5 max-w-2xl text-[12px] text-text-muted">
          Your opening balance is the trial balance from the day before your books start here. Everything
          after that date, AthletixOS posts itself.
        </p>
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

      {/* ── Held duplicates ──────────────────────────────────────────────── */}
      {held && held.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-orange-accent/40 bg-orange-accent/5">
          <div className="flex items-start gap-2 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-orange-accent" strokeWidth={2} />
            <div>
              <p className="text-sm font-medium text-text-primary">
                {held.length} imported bank {held.length === 1 ? "row is" : "rows are"} on hold
              </p>
              <p className="mt-0.5 text-[12px] text-text-muted">
                Each looks like the same transaction as a row your bank feed already delivered — same
                account, same amount, within three days. Neither is posted, because posting both would put
                the month out by the amount. If a pair really is two separate transactions, release the hold.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto border-t border-orange-accent/30">
            <table className="w-full min-w-[36rem] text-[12px]">
              <thead className="text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Imported row</th>
                  <th className="px-3 py-2 text-left">Bank feed row</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {held.map((h) => (
                  <tr key={h.importedId} className="border-t border-orange-accent/20">
                    <td className="px-3 py-2">
                      <span className="text-text-primary">{h.importedName ?? "—"}</span>
                      {h.importedDate && <span className="block text-text-muted">{fmtDate(h.importedDate)}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-text-primary">{h.feedName ?? "—"}</span>
                      {h.feedDate && <span className="block text-text-muted">{fmtDate(h.feedDate)}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                      {formatCents(Math.abs(h.amountCents))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => dismissDuplicate(h.importedId)}
                          disabled={busy !== ""}
                          className="inline-flex items-center gap-1 rounded-lg border border-app-border bg-surface px-2.5 py-1 text-text-primary hover:bg-app-bg disabled:opacity-50"
                        >
                          {busy === h.importedId && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />}
                          They&apos;re different
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Upload ───────────────────────────────────────────────────────── */}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-app-border bg-surface px-4 py-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover">
            {busy === "upload" ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <Upload className="h-4 w-4" strokeWidth={2} />
            )}
            Upload a trial balance
            <input
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
          <p className="text-[12px] text-text-muted">
            QuickBooks → Reports → Trial Balance, as of{" "}
            {current?.booksStartDate ? (
              <strong className="text-text-primary">{fmtDate(current.asOfDate ?? current.booksStartDate)}</strong>
            ) : (
              "the day before your books start"
            )}
            . CSV or Excel, under 8 MB.
          </p>
          {entities.length > 1 && (
            <select
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              className="ml-auto rounded-lg border border-app-border bg-surface px-3 py-2 text-sm"
              aria-label="Legal entity"
            >
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {loading ? (
        <SkeletonList rows={6} />
      ) : !current ? (
        <p className="py-6 text-center text-sm text-text-muted">
          No opening balance imported yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-muted">
            <span className="text-sm text-text-primary">{current.fileName}</span>
            <span>
              {current.parsed.rows.length} accounts · file totals{" "}
              {formatCents(current.parsed.totalDebitCents)} / {formatCents(current.parsed.totalCreditCents)}
            </span>
            {current.asOfDate && <span>Dated {fmtDate(current.asOfDate)}</span>}
            {current.legalEntityName && <span>{current.legalEntityName}</span>}
            <span
              className={
                current.status === "POSTED"
                  ? "rounded-md bg-lime-accent/25 px-2 py-0.5 text-charcoal"
                  : current.status === "VOIDED"
                    ? "text-orange-accent"
                    : ""
              }
            >
              {current.status === "POSTED" ? "Posted" : current.status === "VOIDED" ? "Voided" : "Draft"}
            </span>
            {list.length > 1 && (
              <select
                value={current.id}
                onChange={(e) => void open(e.target.value)}
                className="rounded-lg border border-app-border bg-surface px-2 py-1"
                aria-label="Which import"
              >
                {list.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.fileName} · {i.status.toLowerCase()}
                  </option>
                ))}
              </select>
            )}
          </div>

          {current.parsed.problems.map((p) => (
            <p key={p} className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-[12px] text-text-muted">
              {p}
            </p>
          ))}

          {current.status === "DRAFT" && current.blockers.length === 0 && current.plan?.balanced && (
            <div className="flex items-start gap-2 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-[12px] text-text-muted">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-lime-accent" strokeWidth={2} />
              <span>
                Everything is mapped and the entry balances at {formatCents(current.plan.totalDebitCents)}. Post
                it and your books open on {current.asOfDate ? fmtDate(current.asOfDate) : "the opening date"}.
              </span>
            </div>
          )}

          {current.blockers.map((b) => (
            <div
              key={b.code}
              className="flex items-start gap-2 rounded-lg border border-orange-accent/40 bg-orange-accent/5 px-3 py-2 text-[12px] text-text-primary"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-accent" strokeWidth={2} />
              <span>{b.message}</span>
            </div>
          ))}

          {/* ── Mapping ───────────────────────────────────────────────────── */}
          <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
            <div className="bg-app-bg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Map each QuickBooks account
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">QuickBooks account</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2 text-left">Goes to</th>
                  </tr>
                </thead>
                <tbody>
                  {current.parsed.rows.map((r) => {
                    const target = current.mapping[r.account];
                    const to = current.accounts.find((a) => a.id === target);
                    const isPnl = to?.type === "INCOME" || to?.type === "EXPENSE";
                    return (
                      <tr key={`${r.idx}-${r.account}`} className="border-t border-app-border">
                        <td className="px-3 py-2 text-text-primary">{r.account}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.debitCents ? formatCents(r.debitCents) : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.creditCents ? formatCents(r.creditCents) : ""}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={target === null ? "__skip__" : (target ?? "")}
                            onChange={(e) =>
                              setMap(r.account, e.target.value === "__skip__" ? null : e.target.value || null)
                            }
                            disabled={current.status !== "DRAFT" || !canEdit}
                            className="w-full max-w-[18rem] rounded-lg border border-app-border bg-surface px-2 py-1 text-[12px] disabled:opacity-60"
                            aria-label={`Map ${r.account}`}
                          >
                            <option value="">Choose an account…</option>
                            <option value="__skip__">Skip this account</option>
                            {current.accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.number} {a.name}
                              </option>
                            ))}
                          </select>
                          {isPnl && (
                            <span className="mt-0.5 block text-[12px] text-text-muted">
                              Income and expense balances roll into Retained Earnings — no revenue account is
                              opened with a balance.
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── The planned entry ─────────────────────────────────────────── */}
          {current.plan && current.plan.lines.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
              <div className="bg-app-bg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                The entry this will post
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {current.plan.lines.map((l) => {
                    const a = current.accounts.find((x) => x.id === l.accountId);
                    return (
                      <tr key={l.accountId} className="border-t border-app-border">
                        <td className="px-3 py-2 text-text-primary">
                          {a ? `${a.number} ${a.name}` : l.accountId}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {l.debitCents ? formatCents(l.debitCents) : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {l.creditCents ? formatCents(l.creditCents) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-app-border bg-app-bg">
                  <tr>
                    <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                      {current.plan.balanced ? "Balances" : `Out by ${formatCents(current.plan.differenceCents)}`}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCents(current.plan.totalDebitCents)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCents(current.plan.totalCreditCents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              {current.status === "DRAFT" && (
                <button
                  type="button"
                  onClick={() => patch("post", { action: "post", legalEntityId: entityId || null })}
                  disabled={current.blockers.length > 0 || busy !== "" || !current.plan?.balanced}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "post" && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
                  Post the opening balance
                </button>
              )}
              {current.status === "POSTED" && !current.hasClosedMonth && (
                <button
                  type="button"
                  onClick={() => setVoiding(true)}
                  className="rounded-lg border border-app-border px-4 py-2 text-sm text-text-primary hover:bg-app-bg"
                >
                  Void and start again
                </button>
              )}
              {current.status === "POSTED" && current.hasClosedMonth && (
                <p className="text-[12px] text-text-muted">
                  A month has been closed, so this can no longer be voided — post a correcting journal entry
                  instead.
                </p>
              )}
            </div>
          )}

          {voiding && (
            <div className="space-y-2 rounded-xl border border-orange-accent/40 bg-orange-accent/5 px-4 py-3">
              <p className="text-sm font-medium text-text-primary">Void this opening balance?</p>
              <p className="text-[12px] text-text-muted">
                The entry is reversed, not deleted — both stay on the ledger, which is the only kind of undo an
                auditor accepts. Then you can re-map and post again.
              </p>
              <input
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="Mapped two accounts to the wrong place"
                className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-sm"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => patch("void", { action: "void", reason: voidReason })}
                  disabled={voidReason.trim().length < 5 || busy !== ""}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-accent px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "void" && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
                  Void it
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVoiding(false);
                    setVoidReason("");
                  }}
                  className="rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-surface"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

