"use client";

// Financials → Books → Assets (Accounting Phase 3, task 5).
//
// The fixed-asset register: what the club owns, what it cost, how much has
// been depreciated, and what it is still worth on the books. Depreciation is
// straight-line, posted a month at a time, and safe to run twice — the entry's
// source id is `<assetId>:<YYYY-MM>` and the journal is unique on it, so a
// re-run posts nothing new.
//
// The schedule's months add up to exactly cost less salvage, with the
// remainder in the final month, so an asset never leaves a stray cent on the
// books forever. scripts/gl-close-tests.ts proves that over 793 parameter
// combinations.
//
// Mobile: the register becomes one card per asset; the form stacks.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, PackageOpen, Plus, Trash2, X } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { formatCents, parseDollarsToCents } from "@/lib/ledger";
import { monthLabel } from "@/lib/glClose";

type Account = { id: string; number: string; name: string; type: string; isContra: boolean; active: boolean };
type Asset = {
  id: string;
  name: string;
  description: string | null;
  costCents: number;
  inServiceDate: string;
  usefulLifeMonths: number;
  salvageValueCents: number;
  status: "ACTIVE" | "DISPOSED";
  disposedDate: string | null;
  disposalProceedsCents: number | null;
  legalEntityId: string | null;
  legalEntityName: string | null;
  assetAccount: { number: string; name: string };
  accumDepAccount: { number: string; name: string };
  depExpenseAccount: { number: string; name: string };
  accumulatedCents: number;
  bookValueCents: number;
  monthlyCents: number;
  firstMonth: string;
  lastMonth: string;
  postedMonths: string[];
};
type Entity = { id: string; name: string };

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function AssetsTab({
  canEdit,
  entities,
  entity,
}: {
  canEdit: boolean;
  entities: Entity[];
  entity: string;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [includeDisposed, setIncludeDisposed] = useState(false);
  const [through, setThrough] = useState(thisMonth);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [adding, setAdding] = useState(false);
  const [disposing, setDisposing] = useState<Asset | null>(null);

  const load = useCallback(async () => {
    setErr("");
    try {
      const [ar, cr] = await Promise.all([
        fetch(
          `/api/financials/ledger/assets?entity=${encodeURIComponent(entity)}&includeDisposed=${includeDisposed ? "1" : "0"}`,
          { cache: "no-store" },
        ),
        fetch("/api/financials/ledger/accounts", { cache: "no-store" }),
      ]);
      const ad = await ar.json();
      if (!ar.ok) {
        setErr(ad.error || "Couldn't load the register.");
        setAssets([]);
      } else setAssets(ad.assets ?? []);
      if (cr.ok) setAccounts(((await cr.json()).accounts ?? []) as Account[]);
    } catch {
      setErr("Couldn't load the register.");
      setAssets([]);
    }
  }, [entity, includeDisposed]);

  useEffect(() => {
    void load();
  }, [load]);

  // Which accounts belong in which picker. Narrowed so the common case needs
  // no thought, but every account of the right CLASS is offered — a club that
  // renamed or renumbered its chart must still be able to pick.
  const assetAccounts = useMemo(() => accounts.filter((a) => a.type === "ASSET" && !a.isContra && a.active), [accounts]);
  const accumDepAccounts = useMemo(() => accounts.filter((a) => a.type === "ASSET" && a.isContra && a.active), [accounts]);
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === "EXPENSE" && a.active), [accounts]);
  const cashAccounts = useMemo(() => accounts.filter((a) => a.type === "ASSET" && !a.isContra && a.active), [accounts]);

  const postDepreciation = async () => {
    setBusy("dep");
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/api/financials/ledger/assets/depreciation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          throughMonth: through,
          legalEntityId: entity && entity !== "all" ? entity : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "Couldn't post depreciation.");
      else {
        setMsg(
          d.posted === 0 && d.alreadyPosted === 0
            ? `Nothing was due through ${monthLabel(through)} — everything is already posted.`
            : `Posted ${d.posted} ${d.posted === 1 ? "month" : "months"}, ${formatCents(d.totalCents)} in total.` +
              (d.errors?.length ? ` ${d.errors.length} couldn't post: ${d.errors[0].error}` : ""),
        );
        await load();
      }
    } catch {
      setErr("Couldn't post depreciation.");
    } finally {
      setBusy("");
    }
  };

  const remove = async (a: Asset) => {
    setBusy(a.id);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/assets/${a.id}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setErr(d?.error || "Couldn't remove that asset.");
      } else await load();
    } catch {
      setErr("Couldn't remove that asset.");
    } finally {
      setBusy("");
    }
  };

  const totals = useMemo(() => {
    const live = (assets ?? []).filter((a) => a.status === "ACTIVE");
    return {
      cost: live.reduce((s, a) => s + a.costCents, 0),
      accumulated: live.reduce((s, a) => s + a.accumulatedCents, 0),
      book: live.reduce((s, a) => s + a.bookValueCents, 0),
      monthly: live.reduce((s, a) => s + a.monthlyCents, 0),
    };
  }, [assets]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-text-primary">Fixed assets</h2>
          <p className="mt-0.5 max-w-2xl text-[12px] text-text-muted">
            Straight-line depreciation, one month at a time. Depreciation for a month is dated that
            month&apos;s end, and a full month is taken in the month the asset went into service.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover sm:w-auto"
          >
            <Plus className="h-4 w-4" strokeWidth={2} /> Add an asset
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {canEdit && (
          <>
            <input
              type="month"
              value={through}
              onChange={(e) => setThrough(e.target.value)}
              className="rounded-lg border border-app-border bg-surface px-2 py-1.5 text-xs"
              aria-label="Post depreciation through"
            />
            <button
              type="button"
              onClick={postDepreciation}
              disabled={busy !== ""}
              className="inline-flex items-center gap-1.5 rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg disabled:opacity-50"
            >
              {busy === "dep" && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
              Post depreciation through {monthLabel(through)}
            </button>
          </>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-text-muted">
          <input
            type="checkbox"
            checked={includeDisposed}
            onChange={(e) => setIncludeDisposed(e.target.checked)}
          />
          Show disposed
        </label>
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-text-muted">{msg}</div>}

      {assets === null ? (
        <SkeletonList rows={4} />
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-app-border bg-surface px-4 py-10 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <PackageOpen className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-sm text-text-primary">No fixed assets yet</p>
          <p className="mt-1 text-[12px] text-text-muted">
            Mats, a van, a scoreboard — anything the club bought that lasts more than a year and is written
            off over time rather than expensed at once.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Cost", totals.cost],
              ["Depreciated", totals.accumulated],
              ["Book value", totals.book],
              ["Per month", totals.monthly],
            ].map(([label, cents]) => (
              <div key={label as string} className="rounded-xl border border-app-border bg-surface px-3 py-2">
                <p className="text-[12px] uppercase tracking-wide text-text-muted">{label as string}</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">
                  {formatCents(cents as number)}
                </p>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-app-border bg-surface">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="bg-app-bg text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Asset</th>
                  <th className="px-3 py-2 text-left">In service</th>
                  <th className="px-3 py-2 text-left">Life</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Per month</th>
                  <th className="px-3 py-2 text-right">Depreciated</th>
                  <th className="px-3 py-2 text-right">Book value</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-t border-app-border">
                    <td className="px-3 py-2">
                      <p className="text-text-primary">{a.name}</p>
                      <p className="text-[12px] text-text-muted">
                        {a.assetAccount.number} {a.assetAccount.name}
                        {a.legalEntityName ? ` · ${a.legalEntityName}` : ""}
                        {a.status === "DISPOSED" && a.disposedDate
                          ? ` · disposed ${fmtDate(a.disposedDate)}`
                          : ""}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-text-muted">{fmtDate(a.inServiceDate)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-text-muted">
                      {a.usefulLifeMonths} mo
                      <span className="block text-[12px]">
                        {a.postedMonths.length}/{a.usefulLifeMonths} posted
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(a.costCents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(a.monthlyCents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(a.accumulatedCents)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCents(a.bookValueCents)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && a.status === "ACTIVE" && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setDisposing(a)}
                            className="rounded-lg border border-app-border px-2 py-1 text-[12px] text-text-primary hover:bg-app-bg"
                          >
                            Dispose
                          </button>
                          {a.postedMonths.length === 0 && (
                            <button
                              type="button"
                              onClick={() => remove(a)}
                              disabled={busy === a.id}
                              aria-label={`Remove ${a.name}`}
                              className="rounded-lg p-1.5 text-text-muted hover:bg-app-bg disabled:opacity-50"
                              title="Nothing has posted for this asset yet, so it can be removed"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {adding && (
        <AssetForm
          entities={entities}
          entity={entity}
          assetAccounts={assetAccounts}
          accumDepAccounts={accumDepAccounts}
          expenseAccounts={expenseAccounts}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}

      {disposing && (
        <DisposeForm
          asset={disposing}
          cashAccounts={cashAccounts}
          onClose={() => setDisposing(null)}
          onSaved={async () => {
            setDisposing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

// ── Add ─────────────────────────────────────────────────────────────────────

function AssetForm({
  entities,
  entity,
  assetAccounts,
  accumDepAccounts,
  expenseAccounts,
  onClose,
  onSaved,
}: {
  entities: Entity[];
  entity: string;
  assetAccounts: Account[];
  accumDepAccounts: Account[];
  expenseAccounts: Account[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [inServiceDate, setInServiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [life, setLife] = useState("60");
  const [salvage, setSalvage] = useState("");
  const [legalEntityId, setLegalEntityId] = useState(entity && entity !== "all" ? entity : entities[0]?.id ?? "");
  // 1500 Training Equipment, 1590 Accumulated Depreciation and 6800
  // Depreciation Expense are the template's defaults; `find` falls back to the
  // first of the right class for a club that renumbered.
  const [assetAccountId, setAssetAccountId] = useState(
    () => assetAccounts.find((a) => a.number === "1500")?.id ?? assetAccounts[0]?.id ?? "",
  );
  const [accumDepAccountId, setAccumDepAccountId] = useState(
    () => accumDepAccounts.find((a) => a.number === "1590")?.id ?? accumDepAccounts[0]?.id ?? "",
  );
  const [depExpenseAccountId, setDepExpenseAccountId] = useState(
    () => expenseAccounts.find((a) => a.number === "6800")?.id ?? expenseAccounts[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const costCents = parseDollarsToCents(cost);
  const salvageCents = salvage.trim() ? parseDollarsToCents(salvage) : 0;
  const lifeMonths = Number(life);
  const monthly =
    costCents !== null && salvageCents !== null && lifeMonths > 0
      ? Math.floor((costCents - salvageCents) / lifeMonths)
      : null;

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/financials/ledger/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          costCents,
          inServiceDate,
          usefulLifeMonths: lifeMonths,
          salvageValueCents: salvageCents ?? 0,
          legalEntityId: legalEntityId || null,
          assetAccountId,
          accumDepAccountId,
          depExpenseAccountId,
        }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || d.message || "Couldn't save that asset.");
      else await onSaved();
    } catch {
      setErr("Couldn't save that asset.");
    } finally {
      setBusy(false);
    }
  };

  const ready = !!name.trim() && costCents !== null && costCents > 0 && lifeMonths > 0 && !!assetAccountId;

  return (
    <Sheet title="Add a fixed asset" onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Competition mats" />
        </Field>
        <Field label="Cost">
          <input value={cost} onChange={(e) => setCost(e.target.value)} className={inputCls} placeholder="12,000.00" inputMode="decimal" />
        </Field>
        <Field label="Placed in service">
          <input type="date" value={inServiceDate} onChange={(e) => setInServiceDate(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Useful life (months)">
          <input value={life} onChange={(e) => setLife(e.target.value)} className={inputCls} inputMode="numeric" />
        </Field>
        <Field label="Salvage value (optional)">
          <input value={salvage} onChange={(e) => setSalvage(e.target.value)} className={inputCls} placeholder="0.00" inputMode="decimal" />
        </Field>
        {entities.length > 1 && (
          <Field label="Entity">
            <select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)} className={inputCls}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Asset account">
          <select value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)} className={inputCls}>
            {assetAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.number} {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Accumulated depreciation">
          <select value={accumDepAccountId} onChange={(e) => setAccumDepAccountId(e.target.value)} className={inputCls}>
            {accumDepAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.number} {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Depreciation expense">
          <select value={depExpenseAccountId} onChange={(e) => setDepExpenseAccountId(e.target.value)} className={inputCls}>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.number} {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {monthly !== null && monthly > 0 && (
        <p className="mt-3 text-[12px] text-text-muted">
          {formatCents(monthly)} a month for {lifeMonths} months, starting {inServiceDate.slice(0, 7)}. The last
          month takes the rounding remainder, so the total is exactly cost less salvage.
        </p>
      )}
      {accumDepAccounts.length === 0 && (
        <p className="mt-3 text-[12px] text-orange-accent">
          This chart has no accumulated-depreciation account (a contra asset, normally 1590). Add one under
          Chart of Accounts first.
        </p>
      )}
      {err && <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!ready || busy || accumDepAccounts.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />} Save
        </button>
        <button type="button" onClick={onClose} className="rounded-lg border border-app-border px-4 py-2 text-sm text-text-primary hover:bg-app-bg">
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

// ── Dispose ─────────────────────────────────────────────────────────────────

function DisposeForm({
  asset,
  cashAccounts,
  onClose,
  onSaved,
}: {
  asset: Asset;
  cashAccounts: Account[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [disposedDate, setDisposedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [proceeds, setProceeds] = useState("");
  const [proceedsAccountId, setProceedsAccountId] = useState(
    () => cashAccounts.find((a) => a.number === "1000")?.id ?? cashAccounts[0]?.id ?? "",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const proceedsCents = proceeds.trim() ? (parseDollarsToCents(proceeds) ?? 0) : 0;
  const gainLoss = proceedsCents - asset.bookValueCents;

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/financials/ledger/assets/${asset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "dispose",
          disposedDate,
          proceedsCents,
          proceedsAccountId: proceedsCents > 0 ? proceedsAccountId : null,
          note: note.trim() || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || d.message || "Couldn't dispose of that asset.");
      else await onSaved();
    } catch {
      setErr("Couldn't dispose of that asset.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Dispose of ${asset.name}`} onClose={onClose}>
      <dl className="mb-3 grid grid-cols-3 gap-2 text-xs">
        {[
          ["Cost", asset.costCents],
          ["Depreciated", asset.accumulatedCents],
          ["Book value", asset.bookValueCents],
        ].map(([label, cents]) => (
          <div key={label as string} className="rounded-lg border border-app-border bg-app-bg px-2 py-1.5">
            <dt className="text-[12px] uppercase tracking-wide text-text-muted">{label as string}</dt>
            <dd className="tabular-nums text-text-primary">{formatCents(cents as number)}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Disposal date">
          <input type="date" value={disposedDate} onChange={(e) => setDisposedDate(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Proceeds (leave blank if scrapped)">
          <input value={proceeds} onChange={(e) => setProceeds(e.target.value)} className={inputCls} placeholder="0.00" inputMode="decimal" />
        </Field>
        {proceedsCents > 0 && (
          <Field label="Money went into">
            <select value={proceedsAccountId} onChange={(e) => setProceedsAccountId(e.target.value)} className={inputCls}>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Note (optional)" className="sm:col-span-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="Sold to the high school" />
        </Field>
      </div>

      <p className="mt-3 text-[12px] text-text-muted">
        {gainLoss === 0
          ? "Sold at exactly book value, so there is no gain or loss."
          : gainLoss > 0
            ? `A gain of ${formatCents(gainLoss)}, credited to 4950 Other Income.`
            : `A loss of ${formatCents(-gainLoss)}, charged to 6900 Miscellaneous.`}{" "}
        The entry takes the asset off at cost, removes its accumulated depreciation with it, and brings in
        whatever was received. Your accountant can reclassify the gain or loss with a journal entry.
      </p>
      {err && <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />} Post the disposal
        </button>
        <button type="button" onClick={onClose} className="rounded-lg border border-app-border px-4 py-2 text-sm text-text-primary hover:bg-app-bg">
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

// ── Small shared pieces ─────────────────────────────────────────────────────

const inputCls = "w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-sm";

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-[12px] text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-t-2xl bg-surface p-4 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-lg p-1.5 text-text-muted hover:bg-app-bg">
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
