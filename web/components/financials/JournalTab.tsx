"use client";

// Financials → Journal (Accounting Phase 1).
//
// The entry list, a create form with a LIVE BALANCE INDICATOR, file
// attachments, void-by-reversal, and the owner-only lock-date card.
//
// The balance indicator calls the same `entryTotals` the server validates with
// (lib/ledger.ts), so what the form says is balanced is exactly what the server
// will accept. That shared definition is the point — a client-side copy of the
// rule would eventually disagree with the server and the owner would be the one
// to find out.
//
// Mobile: tables become cards, the entry form's line rows stack. 12-hour times.
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Lock, Paperclip, Plus, Trash2, Undo2, X } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import BooksCard from "@/components/financials/BooksCard";
import { entryTotals, formatCents, parseDollarsToCents } from "@/lib/ledger";

type Entity = { id: string; name: string; entityType?: string };
type AccountOpt = { id: string; number: string; name: string; active: boolean; type: string };

type Line = {
  id: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  legalEntityId: string | null;
  entityName: string | null;
  program: string | null;
  memo: string | null;
  lineNumber: number;
};

type Entry = {
  id: string;
  entryDate: string;
  memo: string | null;
  reference: string | null;
  legalEntityId: string | null;
  entityName: string | null;
  sourceType: string;
  status: string;
  isIntercompany: boolean;
  reversesEntryId: string | null;
  voidedByEntryId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  debitCents: number;
  creditCents: number;
  lines: Line[];
  attachments: { id: string; fileId: string; fileName: string; mimeType: string; sizeBytes: number; url: string }[];
};

type LockDate = { legalEntityId: string; entityName: string; lockedThrough: string; note: string | null; updatedAt: string };

/// Date-only values are stored at 00:00 UTC (the app's convention — see
/// lib/datetime.ts), so they must be formatted in UTC or a date renders as the
/// day before for anyone west of Greenwich.
function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/// Audit/created timestamps are true instants, so they render in the viewer's
/// own zone — 12-hour, per the house convention.
function fmtStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function JournalTab({
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
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [lockDates, setLockDates] = useState<LockDate[]>([]);
  const [status, setStatus] = useState("POSTED");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    setErr("");
    const p = new URLSearchParams({ status, take: "100" });
    if (entity && entity !== "all") p.set("entity", entity);
    if (q.trim()) p.set("q", q.trim());
    try {
      const [er, ar, lr] = await Promise.all([
        fetch(`/api/financials/ledger/entries?${p}`, { cache: "no-store" }),
        fetch(`/api/financials/ledger/accounts`, { cache: "no-store" }),
        fetch(`/api/financials/ledger/lock-dates`, { cache: "no-store" }),
      ]);
      const ed = await er.json();
      if (!er.ok) {
        setErr(ed.error || "Couldn't load the journal.");
        setEntries([]);
        return;
      }
      setEntries(ed.entries ?? []);
      if (ar.ok) {
        const ad = await ar.json();
        setAccounts(
          (ad.accounts ?? []).map((a: AccountOpt) => ({
            id: a.id,
            number: a.number,
            name: a.name,
            active: a.active,
            type: a.type,
          })),
        );
      }
      if (lr.ok) setLockDates(((await lr.json()).lockDates ?? []) as LockDate[]);
    } catch {
      setErr("Couldn't load the journal.");
      setEntries([]);
    }
  }, [status, entity, q]);

  useEffect(() => {
    void load();
  }, [load]);

  if (entries === null) return <SkeletonList rows={8} />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-text-primary">Journal</h2>
          <p className="text-[12px] text-text-muted mt-0.5 max-w-xl">
            Every entry posted to your books. Each one balances — what goes in one account comes out of another.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setCreating(true)}
            className="w-full sm:w-auto text-sm px-4 py-2 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white inline-flex items-center justify-center gap-1.5 shrink-0"
          >
            <Plus className="h-4 w-4" /> New entry
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search memo or reference"
          className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white flex-1 min-w-[180px]"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
        >
          <option value="POSTED">Posted</option>
          <option value="VOID">Voided</option>
          <option value="ALL">All</option>
        </select>
      </div>

      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}

      {entries.length === 0 ? (
        <div className="bg-surface rounded-xl border border-app-border px-4 py-10 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <FileText className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-sm text-text-primary">No entries yet</p>
          <p className="text-[12px] text-text-muted mt-1">
            {canEdit ? "Post one by hand, or let billing post them for you once that's switched on." : "Nothing has been posted to the books yet."}
          </p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
          {/* Desktop */}
          <table className="w-full hidden sm:table">
            <thead>
              <tr className="text-left text-[12px] text-text-muted border-b border-app-border">
                <th className="px-4 py-2 font-medium w-28">Date</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 font-medium w-40">Entity</th>
                <th className="px-4 py-2 font-medium w-28 text-right">Amount</th>
                <th className="px-4 py-2 font-medium w-24" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-app-border last:border-0 text-sm">
                  <td className="px-4 py-2.5 tabular-nums text-text-muted whitespace-nowrap">{fmtDate(e.entryDate)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-text-primary">{e.memo || "Journal entry"}</span>
                      {e.status === "VOID" && <span className="text-[12px] text-red-600">Voided</span>}
                      {e.reversesEntryId && <span className="text-[12px] text-text-muted">reversal</span>}
                      {e.isIntercompany && <span className="text-[12px] text-brand">two entities</span>}
                      {e.attachments.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[12px] text-text-muted">
                          <Paperclip className="h-3 w-3" />
                          {e.attachments.length}
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-text-muted mt-0.5">
                      {e.lines.length} lines
                      {e.reference ? ` · ${e.reference}` : ""}
                      {e.sourceType !== "MANUAL" ? ` · ${e.sourceType.toLowerCase().replace(/_/g, " ")}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-text-muted truncate">{e.entityName || "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-text-primary">{formatCents(e.debitCents)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => setOpen(e)} className="text-[12px] text-text-muted hover:text-text-primary">
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile */}
          <ul className="sm:hidden divide-y divide-app-border">
            {entries.map((e) => (
              <li key={e.id}>
                <button onClick={() => setOpen(e)} className="w-full text-left px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary truncate">{e.memo || "Journal entry"}</p>
                      <p className="text-[12px] text-text-muted mt-0.5">
                        {fmtDate(e.entryDate)} · {e.lines.length} lines
                        {e.entityName ? ` · ${e.entityName}` : ""}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {e.status === "VOID" && <span className="text-[12px] text-red-600">Voided</span>}
                        {e.isIntercompany && <span className="text-[12px] text-brand">two entities</span>}
                        {e.attachments.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[12px] text-text-muted">
                            <Paperclip className="h-3 w-3" />
                            {e.attachments.length}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-sm tabular-nums text-text-primary shrink-0">{formatCents(e.debitCents)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Phase 2: the automatic-posting controls — books start date, post now,
          record a deposit. */}
      <BooksCard canEdit={canEdit} isOwner={isOwner} />

      <LockDateCard
        isOwner={isOwner}
        entities={entities}
        lockDates={lockDates}
        onChanged={(next) => {
          setLockDates(next);
          void load();
        }}
      />

      {creating && (
        <EntryForm
          accounts={accounts}
          entities={entities}
          lockDates={lockDates}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
      {open && (
        <EntryDetail
          entryId={open.id}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
          onChanged={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ── Lock date ────────────────────────────────────────────────────────────── */
function LockDateCard({
  isOwner,
  entities,
  lockDates,
  onChanged,
}: {
  isOwner: boolean;
  entities: Entity[];
  lockDates: LockDate[];
  onChanged: (next: LockDate[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const byEntity = new Map(lockDates.map((l) => [l.legalEntityId, l]));

  async function save(entityId: string, lockedThrough: string | null) {
    setSaving(true);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/lock-dates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legalEntityId: entityId, lockedThrough, note: note.trim() || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't save the lock date.");
        return;
      }
      setEditing(null);
      setNote("");
      onChanged(d.lockDates ?? []);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-surface rounded-xl border border-app-border overflow-hidden">
      <div className="px-4 py-3 border-b border-app-border">
        <h3 className="text-sm font-medium text-text-primary inline-flex items-center gap-1.5">
          <Lock className="h-4 w-4" /> Closed periods
        </h3>
        <p className="text-[12px] text-text-muted mt-0.5 max-w-xl">
          Nothing can be posted, changed or voided on or before an entity&apos;s lock date. Set it once you&apos;ve
          finished a month so the numbers you reported stay put.
          {!isOwner && " Only an owner can change this."}
        </p>
      </div>

      {entities.length === 0 ? (
        <p className="px-4 py-6 text-[12px] text-text-muted">
          Add a legal entity in Settings first — lock dates are set per entity.
        </p>
      ) : (
        <ul className="divide-y divide-app-border">
          {entities.map((en) => {
            const lock = byEntity.get(en.id);
            const isEditing = editing === en.id;
            return (
              <li key={en.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary">{en.name}</p>
                    <p className="text-[12px] text-text-muted mt-0.5">
                      {lock ? (
                        <>
                          Closed through <span className="tabular-nums">{fmtDate(lock.lockedThrough)}</span>
                          {lock.note ? ` · ${lock.note}` : ""}
                        </>
                      ) : (
                        "Open — anything can be posted"
                      )}
                    </p>
                  </div>
                  {isOwner && !isEditing && (
                    <button
                      onClick={() => {
                        setEditing(en.id);
                        setValue(lock?.lockedThrough ?? todayStr());
                        setNote(lock?.note ?? "");
                        setErr("");
                      }}
                      className="text-[12px] px-2.5 py-1 rounded-md border border-app-border text-text-muted hover:text-text-primary shrink-0"
                    >
                      {lock ? "Change" : "Set lock date"}
                    </button>
                  )}
                </div>

                {isEditing && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="date"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                      />
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Note (optional)"
                        className="text-sm px-3 py-2 border border-app-border rounded-lg bg-white flex-1 min-w-[140px]"
                      />
                    </div>
                    {lock && value < lock.lockedThrough && (
                      <p className="text-[12px] text-orange-accent">
                        This moves the lock date backwards, which reopens a period you had closed. It&apos;s recorded in
                        the history either way.
                      </p>
                    )}
                    {err && <p className="text-sm text-red-600">{err}</p>}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => save(en.id, value)}
                        disabled={saving || !value}
                        className="text-sm px-3 py-1.5 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white disabled:opacity-50"
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                      {lock && (
                        <button
                          onClick={() => save(en.id, null)}
                          disabled={saving}
                          className="text-sm px-3 py-1.5 text-text-muted disabled:opacity-50"
                        >
                          Remove the lock
                        </button>
                      )}
                      <button onClick={() => setEditing(null)} className="text-sm px-3 py-1.5 text-text-muted">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ── New entry, with the live balance indicator ───────────────────────────── */
type DraftRow = { key: string; accountId: string; debit: string; credit: string; legalEntityId: string; program: string; memo: string };

let rowSeq = 0;
const newRow = (): DraftRow => ({
  key: `r${++rowSeq}`,
  accountId: "",
  debit: "",
  credit: "",
  legalEntityId: "",
  program: "",
  memo: "",
});

function EntryForm({
  accounts,
  entities,
  lockDates,
  onClose,
  onSaved,
}: {
  accounts: AccountOpt[];
  entities: Entity[];
  lockDates: LockDate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [entryDate, setEntryDate] = useState(todayStr());
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [legalEntityId, setLegalEntityId] = useState(entities.length === 1 ? entities[0].id : "");
  const [rows, setRows] = useState<DraftRow[]>([newRow(), newRow()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [details, setDetails] = useState<string[]>([]);

  const active = accounts.filter((a) => a.active);

  // THE LIVE BALANCE. Computed with the same entryTotals the server validates
  // with, so "balanced" here means the server will accept it.
  const lines = useMemo(
    () =>
      rows.map((r) => ({
        debitCents: parseDollarsToCents(r.debit) ?? 0,
        creditCents: parseDollarsToCents(r.credit) ?? 0,
      })),
    [rows],
  );
  const totals = entryTotals(lines);
  const bothSides = rows.some((r) => (parseDollarsToCents(r.debit) ?? 0) > 0 && (parseDollarsToCents(r.credit) ?? 0) > 0);
  const anyAmount = totals.debitCents > 0 || totals.creditCents > 0;
  const allAccounts = rows.every((r) => r.accountId);

  // Which entities this draft touches, so the form can warn about a lock date
  // before the owner fills the whole thing in.
  const touched = new Set(rows.map((r) => r.legalEntityId || legalEntityId).filter(Boolean));
  const lockHit = [...touched]
    .map((id) => lockDates.find((l) => l.legalEntityId === id))
    .find((l) => l && entryDate <= l.lockedThrough);

  const spansTwo = touched.size > 1;
  const canSave = allAccounts && anyAmount && totals.balanced && !bothSides && !lockHit && !saving;

  function update(key: string, patch: Partial<DraftRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function save() {
    setSaving(true);
    setErr("");
    setDetails([]);
    try {
      const r = await fetch("/api/financials/ledger/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryDate,
          memo: memo.trim() || null,
          reference: reference.trim() || null,
          legalEntityId: legalEntityId || null,
          lines: rows.map((row) => ({
            accountId: row.accountId,
            debitCents: parseDollarsToCents(row.debit) ?? 0,
            creditCents: parseDollarsToCents(row.credit) ?? 0,
            legalEntityId: row.legalEntityId || legalEntityId || null,
            program: row.program.trim() || null,
            memo: row.memo.trim() || null,
          })),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't post that entry.");
        setDetails(Array.isArray(d.details) ? d.details.slice(1) : []);
        return;
      }
      onSaved();
    } catch {
      setErr("Couldn't post that entry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border sticky top-0 bg-surface z-10">
          <h3 className="text-sm font-medium text-text-primary">New journal entry</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[12px] text-text-muted mb-1">Date</label>
              <input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[12px] text-text-muted mb-1">What is this for?</label>
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="October rent"
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {entities.length > 0 && (
              <div className="sm:col-span-2">
                <label className="block text-[12px] text-text-muted mb-1">Entity</label>
                <select
                  value={legalEntityId}
                  onChange={(e) => setLegalEntityId(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                >
                  <option value="">No entity</option>
                  {entities.map((en) => (
                    <option key={en.id} value={en.id}>
                      {en.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-[12px] text-text-muted mb-1">Reference (optional)</label>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Check 1042"
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              />
            </div>
          </div>

          {lockHit && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {lockHit.entityName}&apos;s books are closed through {fmtDate(lockHit.lockedThrough)}. Pick a later date,
              or an owner can move the lock date.
            </div>
          )}

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[12px] text-text-muted">Lines</label>
              <button
                onClick={() => setRows((p) => [...p, newRow()])}
                className="text-[12px] text-text-muted hover:text-text-primary inline-flex items-center gap-1"
              >
                <Plus className="h-3.5 w-3.5" /> Add a line
              </button>
            </div>

            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={row.key} className="rounded-lg border border-app-border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-text-muted">Line {i + 1}</span>
                    {rows.length > 2 && (
                      <button
                        onClick={() => setRows((p) => p.filter((r) => r.key !== row.key))}
                        className="text-text-muted hover:text-red-600"
                        aria-label={`Remove line ${i + 1}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <select
                    value={row.accountId}
                    onChange={(e) => update(row.key, { accountId: e.target.value })}
                    className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                  >
                    <option value="">Choose an account…</option>
                    {active.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.number} {a.name}
                      </option>
                    ))}
                  </select>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[12px] text-text-muted mb-1">Debit</label>
                      <input
                        value={row.debit}
                        onChange={(e) => update(row.key, { debit: e.target.value, credit: "" })}
                        inputMode="decimal"
                        placeholder="0.00"
                        className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[12px] text-text-muted mb-1">Credit</label>
                      <input
                        value={row.credit}
                        onChange={(e) => update(row.key, { credit: e.target.value, debit: "" })}
                        inputMode="decimal"
                        placeholder="0.00"
                        className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {entities.length > 1 && (
                      <select
                        value={row.legalEntityId}
                        onChange={(e) => update(row.key, { legalEntityId: e.target.value })}
                        className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                      >
                        <option value="">Entity: same as above</option>
                        {entities.map((en) => (
                          <option key={en.id} value={en.id}>
                            {en.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <input
                      value={row.program}
                      onChange={(e) => update(row.key, { program: e.target.value })}
                      placeholder="Program (optional)"
                      className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                    />
                    <input
                      value={row.memo}
                      onChange={(e) => update(row.key, { memo: e.target.value })}
                      placeholder="Line note (optional)"
                      className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {spansTwo && (
            <p className="text-[12px] text-brand">
              This entry covers more than one entity, so matching &ldquo;due to&rdquo; and &ldquo;due from&rdquo; lines
              will be added automatically to keep each entity&apos;s books balanced on their own.
            </p>
          )}

          {/* LIVE BALANCE INDICATOR */}
          <div
            className={`rounded-lg border px-3 py-2.5 ${
              !anyAmount
                ? "border-app-border bg-app-bg"
                : totals.balanced && !bothSides
                  ? "border-lime-accent bg-lime-accent/10"
                  : "border-orange-accent bg-orange-accent/10"
            }`}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap text-sm">
              <span className="text-text-muted">
                Debits <span className="tabular-nums text-text-primary">{formatCents(totals.debitCents)}</span>
                <span className="mx-2 text-text-muted">·</span>
                Credits <span className="tabular-nums text-text-primary">{formatCents(totals.creditCents)}</span>
              </span>
              <span className="font-medium">
                {!anyAmount ? (
                  <span className="text-text-muted">Enter the amounts</span>
                ) : bothSides ? (
                  <span className="text-orange-accent">A line has both a debit and a credit — split it in two</span>
                ) : totals.balanced ? (
                  <span className="text-charcoal">Balanced</span>
                ) : (
                  <span className="text-orange-accent tabular-nums">
                    Off by {formatCents(Math.abs(totals.differenceCents))}
                  </span>
                )}
              </span>
            </div>
          </div>

          {err && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <p>{err}</p>
              {details.length > 0 && (
                <ul className="mt-1 list-disc list-inside text-[12px]">
                  {details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border sticky bottom-0 bg-surface">
          <button onClick={onClose} className="text-sm px-3 py-2 text-text-muted">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="text-sm px-4 py-2 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white disabled:opacity-50"
          >
            {saving ? "Posting…" : "Post entry"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── One entry: lines, attachments, void, history ─────────────────────────── */
function EntryDetail({
  entryId,
  canEdit,
  onClose,
  onChanged,
}: {
  entryId: string;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [audit, setAudit] = useState<{ id: string; action: string; actorName: string | null; note: string | null; createdAt: string }[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/financials/ledger/entries/${entryId}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || "Couldn't load that entry.");
      return;
    }
    setEntry(d.entry);
    setAudit(d.audit ?? []);
  }, [entryId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doVoid() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/entries/${entryId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't void that entry.");
        return;
      }
      setConfirmVoid(false);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      const r = await fetch(`/api/financials/ledger/entries/${entryId}/attachments`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't attach that file.");
        return;
      }
      setEntry(d.entry);
      onChanged();
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  async function detach(attachmentId: string) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/entries/${entryId}/attachments/${attachmentId}`, {
        method: "DELETE",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't remove that file.");
        return;
      }
      setEntry(d.entry);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border sticky top-0 bg-surface z-10">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary truncate">{entry?.memo || "Journal entry"}</h3>
            {entry && (
              <p className="text-[12px] text-text-muted">
                {fmtDate(entry.entryDate)}
                {entry.entityName ? ` · ${entry.entityName}` : ""}
                {entry.reference ? ` · ${entry.reference}` : ""}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary shrink-0" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!entry ? (
          <div className="p-4">
            <SkeletonList rows={4} />
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {entry.status === "VOID" && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                Voided{entry.voidedAt ? ` on ${fmtStamp(entry.voidedAt)}` : ""}
                {entry.voidReason ? ` — ${entry.voidReason}` : ""}. A reversing entry cancels it out; both are kept.
              </div>
            )}
            {entry.reversesEntryId && (
              <div className="text-[12px] text-text-muted bg-app-bg border border-app-border rounded-lg px-3 py-2">
                This entry reverses another one. It exists so the original stays on the record instead of being deleted.
              </div>
            )}

            {/* Lines */}
            <div className="rounded-lg border border-app-border overflow-hidden">
              <table className="w-full hidden sm:table">
                <thead>
                  <tr className="text-left text-[12px] text-text-muted border-b border-app-border bg-app-bg">
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 font-medium w-32">Entity</th>
                    <th className="px-3 py-2 font-medium w-24 text-right">Debit</th>
                    <th className="px-3 py-2 font-medium w-24 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((l) => (
                    <tr key={l.id} className="border-b border-app-border last:border-0 text-sm">
                      <td className="px-3 py-2">
                        <span className="tabular-nums text-text-muted mr-1.5">{l.accountNumber}</span>
                        <span className="text-text-primary">{l.accountName}</span>
                        {(l.memo || l.program) && (
                          <p className="text-[12px] text-text-muted mt-0.5">
                            {l.memo}
                            {l.memo && l.program ? " · " : ""}
                            {l.program ? `Program: ${l.program}` : ""}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-text-muted truncate">{l.entityName || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                        {l.debitCents ? formatCents(l.debitCents) : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                        {l.creditCents ? formatCents(l.creditCents) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="text-sm border-t border-app-border bg-app-bg font-medium">
                    <td className="px-3 py-2 text-text-muted" colSpan={2}>
                      Total
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(entry.debitCents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(entry.creditCents)}</td>
                  </tr>
                </tfoot>
              </table>

              <ul className="sm:hidden divide-y divide-app-border">
                {entry.lines.map((l) => (
                  <li key={l.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-text-primary">
                          <span className="tabular-nums text-text-muted mr-1.5">{l.accountNumber}</span>
                          {l.accountName}
                        </p>
                        {(l.memo || l.entityName) && (
                          <p className="text-[12px] text-text-muted mt-0.5">
                            {l.entityName || ""}
                            {l.entityName && l.memo ? " · " : ""}
                            {l.memo || ""}
                          </p>
                        )}
                      </div>
                      <span className="text-sm tabular-nums shrink-0">
                        {l.debitCents ? formatCents(l.debitCents) : `(${formatCents(l.creditCents)})`}
                      </span>
                    </div>
                  </li>
                ))}
                <li className="px-3 py-2.5 bg-app-bg flex items-center justify-between text-sm font-medium">
                  <span className="text-text-muted">Total</span>
                  <span className="tabular-nums">{formatCents(entry.debitCents)}</span>
                </li>
              </ul>
            </div>

            {/* Attachments */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[12px] text-text-muted">Attachments</h4>
                {canEdit && entry.status !== "VOID" && (
                  <label className="text-[12px] text-text-muted hover:text-text-primary inline-flex items-center gap-1 cursor-pointer">
                    <Paperclip className="h-3.5 w-3.5" /> Attach
                    <input
                      type="file"
                      multiple
                      accept="application/pdf,image/jpeg,image/png,image/heic,image/webp,text/csv"
                      onChange={upload}
                      disabled={busy}
                      className="hidden"
                    />
                  </label>
                )}
              </div>
              {entry.attachments.length === 0 ? (
                <p className="text-[12px] text-text-muted">
                  Nothing attached. PDFs, photos and CSVs up to 10 MB — invoices, statements, a photo of a receipt.
                </p>
              ) : (
                <ul className="space-y-1">
                  {entry.attachments.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand hover:underline truncate inline-flex items-center gap-1.5 min-w-0"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{a.fileName}</span>
                      </a>
                      {canEdit && (
                        <button
                          onClick={() => detach(a.id)}
                          disabled={busy}
                          className="text-text-muted hover:text-red-600 shrink-0 disabled:opacity-50"
                          aria-label={`Remove ${a.fileName}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* History */}
            {audit.length > 0 && (
              <div>
                <h4 className="text-[12px] text-text-muted mb-2">History</h4>
                <ul className="space-y-1.5">
                  {audit.map((a) => (
                    <li key={a.id} className="text-[12px] text-text-muted">
                      <span className="text-text-primary">{a.note || a.action}</span>
                      {" · "}
                      {a.actorName || "Someone"} · {fmtStamp(a.createdAt)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}

            {/* Void */}
            {canEdit && entry.status === "POSTED" && !entry.reversesEntryId && (
              <div className="border-t border-app-border pt-4">
                {!confirmVoid ? (
                  <button
                    onClick={() => setConfirmVoid(true)}
                    className="text-sm text-red-600 inline-flex items-center gap-1.5"
                  >
                    <Undo2 className="h-4 w-4" /> Void this entry
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-text-primary">Void this entry?</p>
                    <p className="text-[12px] text-text-muted">
                      Nothing is deleted. A second, opposite entry is posted so the two cancel out — which is what keeps
                      the reports you&apos;ve already sent out true. It posts on{" "}
                      <span className="tabular-nums">{fmtDate(entry.entryDate)}</span>, or today if that month is
                      already closed.
                    </p>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why? (optional, saved in the history)"
                      className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={doVoid}
                        disabled={busy}
                        className="text-sm px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
                      >
                        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {busy ? "Voiding…" : "Yes, void it"}
                      </button>
                      <button onClick={() => setConfirmVoid(false)} className="text-sm px-3 py-1.5 text-text-muted">
                        Keep it
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
