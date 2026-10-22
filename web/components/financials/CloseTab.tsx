"use client";

// Financials → Books → Close (Accounting Phase 3, task 4).
//
// Pick an entity and a month, work the five checks, close it. Closing sets the
// lock date, so the ledger then refuses any entry dated on or before the end
// of that month — there is no separate "closed" flag, because two answers to
// "can I post to January?" would eventually disagree.
//
// The checklist shown here is the SAME one the server re-evaluates on close
// (lib/glClose.ts `evaluateChecklist`), so the button can never be enabled for
// something the server will refuse. The reverse matters too: a check that
// turns red between loading the page and pressing the button stops the close,
// and the error says which one.
//
// Reopening is owner-only and needs a reason — a reopened month means every
// statement already handed to an accountant may now change, and the only way
// anybody finds out why is if somebody wrote it down.
//
// Mobile: checks stack, history scrolls horizontally. 12-hour times.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, Lock, LockOpen } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { formatCents } from "@/lib/ledger";
import { monthLabel } from "@/lib/glClose";

type Check = { key: string; label: string; ok: boolean; detail: string; blocking: boolean };
type CloseView = {
  monthKey: string;
  monthLabel: string;
  periodStart: string;
  periodEnd: string;
  legalEntityId: string;
  legalEntityName: string;
  status: "OPEN" | "CLOSED";
  lockedThrough: string | null;
  lockedByDate: boolean;
  closedAt: string | null;
  closedByName: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  facts: {
    unreconciledAccounts: string[];
    reconcilableCount: number;
    waitingToPost: number;
    uncategorizedBankRows: number;
    undepositedCents: number;
    depreciationDue: number;
  };
  checklist: { items: Check[]; ready: boolean; blockers: string[] };
  lockUnchanged: boolean;
};
type HistoryRow = {
  id: string;
  monthKey: string;
  monthLabel: string;
  legalEntityName: string | null;
  status: string;
  closedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
};
type Entity = { id: string; name: string };

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

/// Last month, not this one — you close a month after it has finished.
const defaultMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

export default function CloseTab({
  canEdit,
  isOwner,
  entities,
  entity,
}: {
  canEdit: boolean;
  isOwner: boolean;
  entities: Entity[];
  entity: string;
}) {
  const [entityId, setEntityId] = useState(() => (entity && entity !== "all" ? entity : entities[0]?.id ?? ""));
  const [month, setMonth] = useState(defaultMonth);
  const [ack, setAck] = useState(false);
  const [view, setView] = useState<CloseView | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    if (!entityId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(
        `/api/financials/ledger/close?entity=${encodeURIComponent(entityId)}&month=${month}&ack=${ack ? "1" : "0"}`,
        { cache: "no-store" },
      );
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Couldn't load the checklist.");
        setView(null);
      } else {
        setView(d.close ?? null);
        setHistory(d.history ?? []);
      }
    } catch {
      setErr("Couldn't load the checklist.");
    } finally {
      setLoading(false);
    }
  }, [entityId, month, ack]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (
    what: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ) => {
    setBusy(what);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/close", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legalEntityId: entityId, month, ...body }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || d.message || "That didn't work.");
      else {
        setView(d.close ?? null);
        setReopening(false);
        setReason("");
        await load();
      }
    } catch {
      setErr("That didn't work.");
    } finally {
      setBusy("");
    }
  };

  const postWaiting = async () => {
    setBusy("post");
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/post", { method: "POST" });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setErr(d?.error || "Couldn't post what was waiting.");
      } else await load();
    } catch {
      setErr("Couldn't post what was waiting.");
    } finally {
      setBusy("");
    }
  };

  const postDepreciation = async () => {
    setBusy("dep");
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/assets/depreciation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ throughMonth: month, legalEntityId: entityId }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "Couldn't post depreciation.");
      else if (d.errors?.length) {
        setErr(`Posted ${d.posted}. ${d.errors.length} couldn't post: ${d.errors[0].error}`);
        await load();
      } else await load();
    } catch {
      setErr("Couldn't post depreciation.");
    } finally {
      setBusy("");
    }
  };

  if (entities.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-text-muted">
        Add a legal entity under Settings before closing a month — a close locks one entity&apos;s books.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-medium text-text-primary">Close a month</h2>
        <p className="mt-0.5 max-w-2xl text-[12px] text-text-muted">
          Closing a month sets the lock date, so nothing can be posted into it afterwards. Work the five
          checks first — they are what makes the closed month something an accountant can rely on.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          className="rounded-lg border border-app-border bg-surface px-3 py-2 text-sm"
          aria-label="Legal entity"
        >
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-app-border bg-surface px-3 py-2 text-sm"
          aria-label="Month"
        />
        {view?.lockedThrough && (
          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
            <Lock className="h-3.5 w-3.5" strokeWidth={2} /> Locked through {view.lockedThrough}
          </span>
        )}
      </div>

      {err && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      )}

      {loading ? (
        <SkeletonList rows={6} />
      ) : !view ? null : (
        <>
          {view.status === "CLOSED" ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-app-border bg-app-bg px-4 py-3">
              <Lock className="h-5 w-5 text-lime-accent" strokeWidth={2} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{view.monthLabel} is closed</p>
                <p className="text-xs text-text-muted">
                  {view.closedAt ? `Closed ${fmtStamp(view.closedAt)}` : "Closed"}
                  {view.closedByName ? ` by ${view.closedByName}` : ""}
                  {view.lockedThrough ? ` · locked through ${view.lockedThrough}` : ""}
                </p>
              </div>
              {isOwner && (
                <button
                  type="button"
                  onClick={() => setReopening(true)}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-surface"
                >
                  <LockOpen className="h-3.5 w-3.5" strokeWidth={2} /> Reopen
                </button>
              )}
            </div>
          ) : (
            <>
              {view.lockedByDate && (
                <div className="flex items-start gap-2 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-xs text-text-muted">
                  <Lock className="h-4 w-4 shrink-0" strokeWidth={2} />
                  <span>
                    The lock date already covers {view.monthLabel}, so nothing can be posted into it — but it
                    has no close on record. Closing it now writes down what was checked.
                  </span>
                </div>
              )}

              <ul className="space-y-2">
                {view.checklist.items.map((c) => (
                  <li
                    key={c.key}
                    className="flex items-start gap-3 rounded-xl border border-app-border bg-surface px-4 py-3"
                  >
                    {c.ok ? (
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-lime-accent" strokeWidth={2} />
                    ) : (
                      <Circle className="mt-0.5 h-5 w-5 shrink-0 text-orange-accent" strokeWidth={2} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text-primary">{c.label}</p>
                      <p className="mt-0.5 text-[12px] text-text-muted">{c.detail}</p>

                      {/* The one check only a human can answer. */}
                      {c.key === "undepositedReviewed" && view.facts.undepositedCents !== 0 && (
                        <label className="mt-2 flex items-center gap-2 text-[12px] text-text-primary">
                          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                          I&apos;ve reviewed the {formatCents(view.facts.undepositedCents)} in Undeposited Funds
                        </label>
                      )}

                      {c.key === "nothingWaiting" && !c.ok && canEdit && (
                        <button
                          type="button"
                          onClick={postWaiting}
                          disabled={busy !== ""}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1 text-[12px] text-text-primary hover:bg-app-bg disabled:opacity-50"
                        >
                          {busy === "post" && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />}
                          Post anything waiting
                        </button>
                      )}

                      {c.key === "depreciationPosted" && !c.ok && canEdit && (
                        <button
                          type="button"
                          onClick={postDepreciation}
                          disabled={busy !== ""}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1 text-[12px] text-text-primary hover:bg-app-bg disabled:opacity-50"
                        >
                          {busy === "dep" && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />}
                          Post depreciation through {monthLabel(month)}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              {view.lockUnchanged && (
                <div className="flex items-start gap-2 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-xs text-text-muted">
                  <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2} />
                  <span>
                    A later month is already closed, so closing {view.monthLabel} records the month but leaves
                    the lock date where it is — moving it back would silently reopen everything after it.
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => act("close", "POST", { undepositedAcknowledged: ack })}
                  disabled={!canEdit || !view.checklist.ready || busy !== ""}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "close" && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
                  <Lock className="h-4 w-4" strokeWidth={2} /> Close {view.monthLabel}
                </button>
                {!view.checklist.ready && (
                  <span className="text-xs text-text-muted">
                    {view.checklist.blockers.length}{" "}
                    {view.checklist.blockers.length === 1 ? "check is" : "checks are"} still outstanding.
                  </span>
                )}
                {!canEdit && <span className="text-xs text-text-muted">You need full finance access to close a month.</span>}
              </div>
            </>
          )}

          {reopening && (
            <div className="space-y-2 rounded-xl border border-orange-accent/40 bg-orange-accent/5 px-4 py-3">
              <p className="text-sm font-medium text-text-primary">Reopen {view.monthLabel}?</p>
              <p className="text-[12px] text-text-muted">
                The lock date goes back to what it was before this month was closed. Every statement already
                handed to your accountant may now change, so say what happened — it goes in the audit trail.
              </p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="The CPA found a misposted rent payment in January."
                className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => act("reopen", "PATCH", { reason })}
                  disabled={reason.trim().length < 10 || busy !== ""}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-accent px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "reopen" && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
                  Reopen the month
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReopening(false);
                    setReason("");
                  }}
                  className="rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-surface"
                >
                  Cancel
                </button>
                {reason.trim().length > 0 && reason.trim().length < 10 && (
                  <span className="text-xs text-text-muted">A sentence, please.</span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {history.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
          <div className="bg-app-bg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Closed months
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-xs">
              <thead className="text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Month</th>
                  <th className="px-3 py-2 text-left">Entity</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-app-border">
                    <td className="whitespace-nowrap px-3 py-2 text-text-primary">{h.monthLabel}</td>
                    <td className="px-3 py-2 text-text-muted">{h.legalEntityName ?? ""}</td>
                    <td className="px-3 py-2">
                      {h.status === "CLOSED" ? (
                        <span className="inline-flex items-center gap-1 text-text-primary">
                          <Lock className="h-3 w-3" strokeWidth={2} /> Closed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-orange-accent">
                          <LockOpen className="h-3 w-3" strokeWidth={2} /> Reopened
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-text-muted">
                      {h.reopenedAt
                        ? `${fmtStamp(h.reopenedAt)}${h.reopenReason ? ` · ${h.reopenReason}` : ""}`
                        : h.closedAt
                          ? fmtStamp(h.closedAt)
                          : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
