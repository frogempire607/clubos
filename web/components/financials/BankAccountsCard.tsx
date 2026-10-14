"use client";

// Bank accounts, grouped by the entity whose books they belong to (2026-10-14).
// One entity can have many accounts (two banks for the LLC); each account
// belongs to one entity (the Foundation's account is never the LLC's). Moving
// an account moves its bank rows with it.
import { useCallback, useEffect, useState } from "react";

type Account = {
  id: string; connectionLabel: string; institution: string | null; kind: "PLAID" | "MANUAL"; name: string; mask: string | null;
  type: string | null; legalEntityId: string | null; rowCount: number; firstDate: string | null; lastDate: string | null;
};
type Entity = { id: string; name: string; entityType: string };

const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3 text-[13px] font-medium md:min-h-[34px] disabled:opacity-50";

export default function BankAccountsCard({ canEdit, onChanged }: { canEdit: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<{ accounts: Account[]; entities: Entity[]; unassigned: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMask, setNewMask] = useState("");
  const [newEntity, setNewEntity] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/financials/bank-accounts", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function move(a: Account, entityId: string) {
    setBusy(a.id); setMsg(null);
    const r = await fetch(`/api/financials/bank-accounts/${a.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalEntityId: entityId || null }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: d.error || "That didn't save." });
    const ent = data?.entities.find((e) => e.id === entityId);
    setMsg({ ok: true, text: `${a.name} is now on ${ent ? ent.name : "no entity"}'s books — ${d.moved ?? 0} bank transaction(s) moved with it.` });
    await load();
    onChanged?.();
  }

  async function addManual() {
    if (!newName.trim()) return setMsg({ ok: false, text: "Name the account (e.g. “Chase card ••4411”)." });
    setBusy("new"); setMsg(null);
    const r = await fetch("/api/financials/bank-accounts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), mask: newMask.trim() || null, legalEntityId: newEntity || null }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: d.error || "That didn't save." });
    setAdding(false); setNewName(""); setNewMask(""); setNewEntity("");
    setMsg({ ok: true, text: "Account added. Bring its history in with Import from QuickBooks." });
    await load();
    onChanged?.();
  }

  if (!data) return null;
  const groups: { key: string; title: string; sub: string | null; accounts: Account[] }[] = [
    ...data.entities.map((e) => ({ key: e.id, title: e.name, sub: e.entityType === "NONPROFIT" ? "Nonprofit — separate books" : e.entityType, accounts: data.accounts.filter((a) => a.legalEntityId === e.id) })),
    { key: "", title: "Not assigned to an entity yet", sub: "These rows count for no entity's books until you pick one.", accounts: data.accounts.filter((a) => !a.legalEntityId) },
  ].filter((g) => g.key !== "" || g.accounts.length > 0);

  return (
    <section aria-label="Bank accounts by entity" className="bg-white rounded-xl border border-app-border p-4 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold text-text-primary">Bank accounts by entity</h3>
          <p className="text-[12.5px] text-text-muted">Each account belongs to one entity&apos;s books. An entity can have several accounts.</p>
        </div>
        {canEdit && !adding && (
          <button type="button" onClick={() => setAdding(true)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>+ Account kept by hand</button>
        )}
      </div>
      {data.unassigned > 0 && (
        <p role="status" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)" }}>
          {data.unassigned} account{data.unassigned === 1 ? " isn't" : "s aren't"} on an entity&apos;s books yet — pick one below so the entity filter and Tax Summary are right.
        </p>
      )}
      {msg && (
        <p role="status" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={msg.ok ? { background: "var(--color-success-surface)", color: "var(--color-success-text)" } : { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>{msg.text}</p>
      )}
      {adding && (
        <div className="mt-3 rounded-lg border border-app-border p-3 space-y-2">
          <p className="text-[13px] text-text-primary">An account that isn&apos;t linked to the bank feed — a closed account, or a card you don&apos;t connect. Its history comes from a QuickBooks import.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <input aria-label="Account name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name, e.g. Chase card" className="min-h-[44px] rounded-lg border border-app-border px-2.5 text-[14px] md:min-h-[36px]" />
            <input aria-label="Last 4 digits" value={newMask} onChange={(e) => setNewMask(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Last 4 (optional)" className="min-h-[44px] rounded-lg border border-app-border px-2.5 text-[14px] md:min-h-[36px]" />
            <select aria-label="Entity" value={newEntity} onChange={(e) => setNewEntity(e.target.value)} className="min-h-[44px] rounded-lg border border-app-border px-2.5 text-[14px] md:min-h-[36px]">
              <option value="">Which entity&apos;s books?</option>
              {data.entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy === "new"} onClick={addManual} className={`${btn} bg-brand text-white`}>Add account</button>
            <button type="button" onClick={() => setAdding(false)} className={`${btn} border border-app-border`}>Cancel</button>
          </div>
        </div>
      )}
      <div className="mt-3 space-y-3">
        {groups.map((g) => (
          <div key={g.key || "none"} className="rounded-lg border border-app-border">
            <div className="flex items-baseline justify-between gap-2 border-b border-app-border bg-app-bg px-3 py-2">
              <p className="text-[14px] font-semibold text-text-primary">{g.title}</p>
              {g.sub && <p className="text-[12px] text-text-muted">{g.sub}</p>}
            </div>
            {g.accounts.length === 0 ? (
              <p className="px-3 py-2.5 text-[13px] text-text-muted">No accounts yet.</p>
            ) : (
              <ul className="divide-y divide-app-border">
                {g.accounts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[14px] text-text-primary">
                        {a.name}{a.mask ? ` ••${a.mask}` : ""}
                        <span className="ml-1.5 text-[12px] text-text-muted">{a.kind === "MANUAL" ? "kept by hand" : a.connectionLabel}{a.type ? ` · ${a.type}` : ""}</span>
                      </p>
                      <p className="text-[12px] text-text-muted">{a.rowCount} transaction{a.rowCount === 1 ? "" : "s"}{a.firstDate ? ` · ${fmt(a.firstDate)} – ${fmt(a.lastDate)}` : ""}</p>
                    </div>
                    {canEdit && (
                      <select aria-label={`Entity for ${a.name}`} value={a.legalEntityId ?? ""} disabled={busy === a.id} onChange={(e) => move(a, e.target.value)}
                        className="min-h-[44px] rounded-lg border border-app-border px-2.5 text-[13px] md:min-h-[34px]">
                        <option value="">No entity</option>
                        {data.entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
