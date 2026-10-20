"use client";

// Financials → Chart of Accounts (Accounting Phase 1).
//
// The club's account list, grouped the way a balance sheet and a P&L read:
// assets, liabilities, equity, income, cost of sales, expenses. Rename, add,
// deactivate. Deleting is offered only on an account that has never been
// posted to — the server refuses the rest with a message pointing at
// deactivation, and the RESTRICT foreign key is the backstop.
//
// Mobile: the table becomes one card per account. No horizontal page scroll.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { ACCOUNT_TYPE_LABELS, COST_OF_SALES, formatCents, increasesWithDebit, type AccountType } from "@/lib/ledger";

type Account = {
  id: string;
  number: string;
  name: string;
  type: string;
  subtype: string | null;
  normalBalance: string;
  isContra: boolean;
  parentId: string | null;
  active: boolean;
  isSystem: boolean;
  systemKey: string | null;
  description: string | null;
  sortOrder: number;
  postingCount: number;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};

/// Display sections. Cost of sales is pulled out of EXPENSE by subtype so the
/// list reads like a P&L — it is still an expense account everywhere else.
type SectionKey = AccountType | "COST_OF_SALES";
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "ASSET", label: ACCOUNT_TYPE_LABELS.ASSET },
  { key: "LIABILITY", label: ACCOUNT_TYPE_LABELS.LIABILITY },
  { key: "EQUITY", label: ACCOUNT_TYPE_LABELS.EQUITY },
  { key: "INCOME", label: ACCOUNT_TYPE_LABELS.INCOME },
  { key: "COST_OF_SALES", label: "Cost of sales" },
  { key: "EXPENSE", label: ACCOUNT_TYPE_LABELS.EXPENSE },
];

function sectionOf(a: Account): SectionKey {
  if (a.type === "EXPENSE" && a.subtype === COST_OF_SALES) return "COST_OF_SALES";
  return a.type as SectionKey;
}

export default function ChartOfAccountsTab({ canEdit, entityQuery }: { canEdit: boolean; entityQuery: string }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [err, setErr] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState<SectionKey | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/accounts?${entityQuery}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || "Couldn't load the chart of accounts.");
        setAccounts([]);
        return;
      }
      setAccounts(d.accounts ?? []);
    } catch {
      setErr("Couldn't load the chart of accounts.");
      setAccounts([]);
    }
  }, [entityQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const out = new Map<SectionKey, Account[]>();
    for (const s of SECTIONS) out.set(s.key, []);
    for (const a of accounts ?? []) {
      if (!a.active && !showInactive) continue;
      out.get(sectionOf(a))?.push(a);
    }
    // Parents first, each followed by its children — so indentation reads as a
    // tree without a recursive renderer.
    for (const [k, list] of out) {
      const parents = list.filter((a) => !a.parentId).sort((x, y) => x.number.localeCompare(y.number));
      const kids = list.filter((a) => a.parentId);
      const ordered: Account[] = [];
      for (const p of parents) {
        ordered.push(p);
        ordered.push(...kids.filter((c) => c.parentId === p.id).sort((x, y) => x.number.localeCompare(y.number)));
      }
      // An orphan (its parent is inactive and hidden) still has to appear.
      ordered.push(...kids.filter((c) => !parents.some((p) => p.id === c.parentId)).sort((x, y) => x.number.localeCompare(y.number)));
      out.set(k, ordered);
    }
    return out;
  }, [accounts, showInactive]);

  const inactiveCount = (accounts ?? []).filter((a) => !a.active).length;

  function toggle(k: SectionKey) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  if (accounts === null) return <SkeletonList rows={8} />;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-text-primary">Chart of accounts</h2>
          <p className="text-[12px] text-text-muted mt-0.5 max-w-xl">
            The accounts every entry posts to. Rename them to match how you talk about your money. Balances cover the
            date range selected above.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-text-muted shrink-0">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-app-border"
          />
          Show inactive{inactiveCount > 0 ? ` (${inactiveCount})` : ""}
        </label>
      </div>

      {err && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>
      )}

      <div className="space-y-4">
        {SECTIONS.map((s) => {
          const list = grouped.get(s.key) ?? [];
          const isCollapsed = collapsed.has(s.key);
          return (
            <section key={s.key} className="bg-surface rounded-xl border border-app-border overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-app-border">
                <button
                  onClick={() => toggle(s.key)}
                  className="flex items-center gap-2 text-sm font-medium text-text-primary min-w-0"
                >
                  {isCollapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                  <span className="truncate">{s.label}</span>
                  <span className="text-[12px] text-text-muted font-normal shrink-0">({list.length})</span>
                </button>
                {canEdit && (
                  <button
                    onClick={() => setAdding(s.key)}
                    className="text-[12px] px-2.5 py-1 rounded-md border border-app-border text-text-muted hover:text-text-primary inline-flex items-center gap-1 shrink-0"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                )}
              </div>

              {!isCollapsed && (
                <>
                  {list.length === 0 ? (
                    <p className="px-4 py-6 text-[12px] text-text-muted">No accounts in this section yet.</p>
                  ) : (
                    <>
                      {/* Desktop */}
                      <table className="w-full hidden sm:table">
                        <thead>
                          <tr className="text-left text-[12px] text-text-muted border-b border-app-border">
                            <th className="px-4 py-2 font-medium w-20">#</th>
                            <th className="px-4 py-2 font-medium">Account</th>
                            <th className="px-4 py-2 font-medium w-28">Increases with</th>
                            <th className="px-4 py-2 font-medium w-24 text-right">Entries</th>
                            <th className="px-4 py-2 font-medium w-32 text-right">Balance</th>
                            <th className="px-4 py-2 font-medium w-20" />
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((a) => (
                            <tr key={a.id} className="border-b border-app-border last:border-0 text-sm">
                              <td className="px-4 py-2.5 tabular-nums text-text-muted">{a.number}</td>
                              <td className="px-4 py-2.5">
                                <div className={`flex items-center gap-1.5 ${a.parentId ? "pl-4" : ""}`}>
                                  <span className={a.active ? "text-text-primary" : "text-text-muted line-through"}>
                                    {a.name}
                                  </span>
                                  {a.isSystem && (
                                    <span
                                      title="Automatic posting needs this account. You can rename it, but not turn it off."
                                      className="inline-flex items-center gap-0.5 text-[12px] text-brand"
                                    >
                                      <Lock className="h-3 w-3" /> System
                                    </span>
                                  )}
                                  {a.isContra && <span className="text-[12px] text-text-muted">contra</span>}
                                  {!a.active && <span className="text-[12px] text-text-muted">inactive</span>}
                                </div>
                                {a.description && (
                                  <p className="text-[12px] text-text-muted mt-0.5 max-w-lg">{a.description}</p>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-[12px] text-text-muted">
                                {increasesWithDebit(a.type, a.isContra) ? "Debit" : "Credit"}
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-text-muted">{a.postingCount}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-text-primary">
                                {formatCents(a.balanceCents)}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {canEdit && (
                                  <button
                                    onClick={() => setEditing(a)}
                                    className="text-text-muted hover:text-text-primary"
                                    aria-label={`Edit ${a.name}`}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {/* Mobile */}
                      <ul className="sm:hidden divide-y divide-app-border">
                        {list.map((a) => (
                          <li key={a.id} className="px-4 py-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-[12px] tabular-nums text-text-muted">{a.number}</span>
                                  <span className={`text-sm ${a.active ? "text-text-primary" : "text-text-muted line-through"}`}>
                                    {a.name}
                                  </span>
                                  {a.isSystem && (
                                    <span className="inline-flex items-center gap-0.5 text-[12px] text-brand">
                                      <Lock className="h-3 w-3" /> System
                                    </span>
                                  )}
                                </div>
                                <p className="text-[12px] text-text-muted mt-1">
                                  {increasesWithDebit(a.type, a.isContra) ? "Debit" : "Credit"} increases ·{" "}
                                  {a.postingCount} {a.postingCount === 1 ? "entry" : "entries"}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm tabular-nums text-text-primary">{formatCents(a.balanceCents)}</p>
                                {canEdit && (
                                  <button
                                    onClick={() => setEditing(a)}
                                    className="text-[12px] text-text-muted mt-1 inline-flex items-center gap-1"
                                  >
                                    <Pencil className="h-3 w-3" /> Edit
                                  </button>
                                )}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>

      {adding && (
        <AccountModal
          mode="create"
          section={adding}
          accounts={accounts}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      )}
      {editing && (
        <AccountModal
          mode="edit"
          account={editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ── Add / edit one account ───────────────────────────────────────────────── */
// Bottom-sheet on mobile, centred dialog on desktop — the house modal pattern.
function AccountModal({
  mode,
  section,
  account,
  accounts,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  section?: SectionKey;
  account?: Account;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const type: AccountType = (account?.type as AccountType) ?? (section === "COST_OF_SALES" ? "EXPENSE" : (section as AccountType)) ?? "EXPENSE";
  const isCos = section === "COST_OF_SALES" || account?.subtype === COST_OF_SALES;

  const [number, setNumber] = useState(account?.number ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [description, setDescription] = useState(account?.description ?? "");
  const [active, setActive] = useState(account?.active ?? true);
  const [parentId, setParentId] = useState(account?.parentId ?? "");
  const [isContra, setIsContra] = useState(account?.isContra ?? false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Only same-type, top-level, active accounts can be a parent — one level of
  // nesting, which is what the server enforces too.
  const parentOptions = accounts.filter(
    (a) => a.type === type && !a.parentId && a.active && a.id !== account?.id && sectionOf(a) === (section ?? sectionOf(account!)),
  );

  async function save() {
    setSaving(true);
    setErr("");
    try {
      const r =
        mode === "create"
          ? await fetch("/api/financials/ledger/accounts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                number: number.trim(),
                name: name.trim(),
                type,
                subtype: isCos ? COST_OF_SALES : null,
                isContra,
                parentId: parentId || null,
                description: description.trim() || null,
              }),
            })
          : await fetch(`/api/financials/ledger/accounts/${account!.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: name.trim(),
                description: description.trim() || null,
                active,
                parentId: parentId || null,
              }),
            });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't save that account.");
        return;
      }
      onSaved();
    } catch {
      setErr("Couldn't save that account.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!account) return;
    setSaving(true);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/accounts/${account.id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Couldn't delete that account.");
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const canDelete = mode === "edit" && account && !account.isSystem && account.postingCount === 0;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <h3 className="text-sm font-medium text-text-primary">
            {mode === "create" ? `Add an account` : `Edit ${account!.number} ${account!.name}`}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {mode === "create" ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[12px] text-text-muted mb-1">Number</label>
                <input
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  inputMode="numeric"
                  placeholder="6310"
                  className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white tabular-nums"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] text-text-muted mb-1">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Cleaning"
                  className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-[12px] text-text-muted mb-1">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              />
              <p className="text-[12px] text-text-muted mt-1">
                The number and type can&apos;t change — past entries and reports refer to them. To renumber, add a new
                account and make this one inactive.
              </p>
            </div>
          )}

          <div>
            <label className="block text-[12px] text-text-muted mb-1">Note (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What belongs in this account"
              className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
            />
          </div>

          {parentOptions.length > 0 && (
            <div>
              <label className="block text-[12px] text-text-muted mb-1">Sits under (optional)</label>
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                className="w-full text-sm px-3 py-2 border border-app-border rounded-lg bg-white"
              >
                <option value="">Top level</option>
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number} {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {mode === "create" && (
            <label className="flex items-start gap-2 text-[12px] text-text-muted">
              <input
                type="checkbox"
                checked={isContra}
                onChange={(e) => setIsContra(e.target.checked)}
                className="rounded border-app-border mt-0.5"
              />
              <span>
                This account reduces its section rather than adding to it (like accumulated depreciation, or refunds
                against income).
              </span>
            </label>
          )}

          {mode === "edit" && (
            <div>
              <label className="flex items-start gap-2 text-[12px] text-text-muted">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  disabled={account!.isSystem}
                  className="rounded border-app-border mt-0.5 disabled:opacity-50"
                />
                <span>
                  Available on new entries.
                  {account!.isSystem && " Automatic posting needs this account, so it can't be turned off."}
                  {!account!.isSystem && account!.postingCount > 0 && (
                    <>
                      {" "}
                      Turning it off hides it from new entries; its {account!.postingCount}{" "}
                      {account!.postingCount === 1 ? "entry stays" : "entries stay"} on your reports.
                    </>
                  )}
                </span>
              </label>
            </div>
          )}

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-app-border">
          {canDelete ? (
            <button
              onClick={remove}
              disabled={saving}
              className="text-[12px] text-red-600 inline-flex items-center gap-1 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          ) : (
            <span className="text-[12px] text-text-muted">
              {mode === "edit" && account!.postingCount > 0 ? "Used by entries — can't be deleted" : ""}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-sm px-3 py-2 text-text-muted">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !name.trim() || (mode === "create" && !number.trim())}
              className="text-sm px-4 py-2 rounded-lg bg-charcoal hover:bg-charcoal-hover text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
