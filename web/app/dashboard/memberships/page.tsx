"use client";

import { useEffect, useState } from "react";

type BillingPeriod = "WEEKLY" | "MONTHLY" | "QUADRIMESTRAL" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL" | "ONE_TIME";

type Option = {
  label: string;
  price: number;
  billingPeriod: BillingPeriod;
};

type Membership = {
  id: string;
  name: string;
  description: string | null;
  options: string;
  active: boolean;
  purchaseAccess: string;
  autoRenewDefault: boolean;
  allowManualRenewal: boolean;
  allowCustomDates: boolean;
  allowBillingDayOverride: boolean;
  defaultBillingDay: number | null;
  contractMonths: number | null;
  createdAt: string;
  _count: { members: number };
};

type Discount = {
  id: string;
  code: string;
  description: string | null;
  type: "PERCENT" | "FIXED";
  value: number;
  maxUses: number | null;
  usedCount: number;
  active: boolean;
  expiresAt: string | null;
};

const periodLabels: Record<BillingPeriod, string> = {
  WEEKLY: "per week",
  MONTHLY: "per month",
  QUADRIMESTRAL: "per 4 months",
  QUARTERLY: "per 3 months",
  SEMI_ANNUAL: "per 6 months",
  ANNUAL: "per year",
  ONE_TIME: "one-time",
};

export default function MembershipsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Membership | null>(null);

  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [showAddDiscount, setShowAddDiscount] = useState(false);
  const [editingDiscount, setEditingDiscount] = useState<Discount | null>(null);

  async function load() {
    setLoading(true);
    const [mRes, dRes] = await Promise.all([fetch("/api/memberships"), fetch("/api/discounts")]);
    if (mRes.ok) setMemberships(await mRes.json());
    if (dRes.ok) setDiscounts(await dRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this membership? Members on this plan won't be affected.")) return;
    const res = await fetch(`/api/memberships/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function handleDeleteDiscount(id: string) {
    if (!confirm("Delete this discount code?")) return;
    const res = await fetch(`/api/discounts/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function handleToggleDiscount(d: Discount) {
    await fetch(`/api/discounts/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !d.active }),
    });
    load();
  }

  async function handleToggleActive(m: Membership) {
    await fetch(`/api/memberships/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !m.active }),
    });
    load();
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Memberships</h1>
          <p className="text-sm text-text-muted">{memberships.length} plan{memberships.length === 1 ? "" : "s"}</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
          + Add membership
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : memberships.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="text-4xl mb-2">◇</div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No memberships yet</h3>
          <p className="text-sm text-text-muted mb-4">Create your first plan — any name, any price, any time period.</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add membership
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {memberships.map((m) => {
            let options: Option[] = [];
            try { options = JSON.parse(m.options || "[]"); } catch {}
            return (
              <div key={m.id} className="bg-white rounded-xl border border-app-border p-5">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-base font-semibold text-text-primary truncate">{m.name}</h3>
                      {!m.active && <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-app-bg text-text-muted">Inactive</span>}
                      {m.purchaseAccess === "STAFF_ONLY" && <span className="text-xs px-2 py-0.5 rounded-full font-medium border border-app-border text-text-muted">Staff assigns</span>}
                    </div>
                    {m.description && <p className="text-xs text-text-muted line-clamp-2">{m.description}</p>}
                  </div>
                </div>

                <div className="border-t border-app-border my-3" />

                <div className="space-y-1.5 mb-4">
                  {options.map((opt, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-text-primary">{opt.label}</span>
                      <span className="text-text-primary font-medium">
                        ${opt.price.toFixed(2)}{" "}
                        <span className="text-text-muted font-normal">{periodLabels[opt.billingPeriod] || opt.billingPeriod}</span>
                      </span>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-app-border">
                  <span className="text-xs text-text-muted">{m._count.members} member{m._count.members === 1 ? "" : "s"}</span>
                  <div className="flex gap-1">
                    <button onClick={() => handleToggleActive(m)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                      {m.active ? "Deactivate" : "Activate"}
                    </button>
                    <button onClick={() => setEditing(m)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                    <button onClick={() => handleDelete(m.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Discounts section */}
      <div className="mt-12">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Discount Codes</h2>
            <p className="text-sm text-text-muted">Promo codes applied at membership checkout</p>
          </div>
          <button onClick={() => setShowAddDiscount(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add code
          </button>
        </div>

        {discounts.length === 0 ? (
          <div className="bg-white rounded-xl border border-app-border p-8 text-center">
            <p className="text-sm text-text-muted">No discount codes yet. Create one to offer promotions.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-app-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-app-bg border-b border-app-border">
                <tr>
                  {["Code", "Type", "Value", "Uses", "Expires", "Status", ""].map((h) => (
                    <th key={h} className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-5 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {discounts.map((d) => (
                  <tr key={d.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                    <td className="px-5 py-3">
                      <span className="font-mono text-sm font-semibold text-text-primary">{d.code}</span>
                      {d.description && <div className="text-xs text-text-muted">{d.description}</div>}
                    </td>
                    <td className="px-5 py-3 text-sm text-text-muted">{d.type === "PERCENT" ? "Percent" : "Fixed"}</td>
                    <td className="px-5 py-3 text-sm font-medium text-text-primary">
                      {d.type === "PERCENT" ? `${d.value}%` : `$${Number(d.value).toFixed(2)}`}
                    </td>
                    <td className="px-5 py-3 text-sm text-text-muted">
                      {d.usedCount}{d.maxUses ? ` / ${d.maxUses}` : ""}
                    </td>
                    <td className="px-5 py-3 text-sm text-text-muted">
                      {d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${d.active ? "bg-lime-accent text-text-primary" : "bg-app-bg text-text-muted"}`}>
                        {d.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => handleToggleDiscount(d)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                          {d.active ? "Deactivate" : "Activate"}
                        </button>
                        <button onClick={() => setEditingDiscount(d)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                        <button onClick={() => handleDeleteDiscount(d.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(showAdd || editing) && (
        <MembershipModal
          membership={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {(showAddDiscount || editingDiscount) && (
        <DiscountModal
          discount={editingDiscount}
          onClose={() => { setShowAddDiscount(false); setEditingDiscount(null); }}
          onSaved={() => { setShowAddDiscount(false); setEditingDiscount(null); load(); }}
        />
      )}
    </div>
  );
}

function MembershipModal({ membership, onClose, onSaved }: { membership: Membership | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!membership;
  const initialOptions: Option[] = (() => {
    if (!membership) return [{ label: "Monthly", price: 0, billingPeriod: "MONTHLY" }];
    try {
      const parsed = JSON.parse(membership.options);
      return parsed.map((o: any) => ({ label: o.label, price: o.price, billingPeriod: o.billingPeriod || "MONTHLY" }));
    } catch { return [{ label: "Monthly", price: 0, billingPeriod: "MONTHLY" }]; }
  })();

  const [name, setName] = useState(membership?.name || "");
  const [description, setDescription] = useState(membership?.description || "");
  const [options, setOptions] = useState<Option[]>(initialOptions);
  const [purchaseAccess, setPurchaseAccess] = useState(membership?.purchaseAccess || "ANYONE");
  const [autoRenewDefault, setAutoRenewDefault] = useState(membership?.autoRenewDefault ?? true);
  const [allowManualRenewal, setAllowManualRenewal] = useState(membership?.allowManualRenewal ?? true);
  const [allowCustomDates, setAllowCustomDates] = useState(membership?.allowCustomDates ?? false);
  const [allowBillingDayOverride, setAllowBillingDayOverride] = useState(membership?.allowBillingDayOverride ?? false);
  const [defaultBillingDay, setDefaultBillingDay] = useState(membership?.defaultBillingDay ? String(membership.defaultBillingDay) : "");
  const [contractMonths, setContractMonths] = useState(membership?.contractMonths ? String(membership.contractMonths) : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function updateOption(i: number, key: keyof Option, value: any) {
    const copy = [...options];
    (copy[i] as any)[key] = value;
    setOptions(copy);
  }
  function addOption() { setOptions([...options, { label: "", price: 0, billingPeriod: "MONTHLY" }]); }
  function removeOption(i: number) { setOptions(options.filter((_, idx) => idx !== i)); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const cleanOptions = options.filter((o) => o.label.trim()).map((o) => ({ ...o, price: Number(o.price) || 0 }));
    if (cleanOptions.length === 0) { setError("Add at least one purchase option"); setSaving(false); return; }

    const url = isEdit ? `/api/memberships/${membership!.id}` : "/api/memberships";
    const method = isEdit ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, description, options: cleanOptions, purchaseAccess,
        autoRenewDefault, allowManualRenewal, allowCustomDates, allowBillingDayOverride,
        defaultBillingDay: defaultBillingDay ? parseInt(defaultBillingDay, 10) : null,
        contractMonths: contractMonths ? parseInt(contractMonths, 10) : null,
      }),
    });

    setSaving(false);
    if (!res.ok) { const data = await res.json(); setError(data.error?.toString() || "Save failed"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit membership" : "Create membership"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Plan name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Full Access, Kids 8-12, Summer Camp" required className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description (optional)" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          {/* Purchase access */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Who can purchase this membership?</label>
            <select value={purchaseAccess} onChange={(e) => setPurchaseAccess(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
              <option value="ANYONE">Members can self-purchase</option>
              <option value="STAFF_ONLY">Staff & owner assign only</option>
            </select>
          </div>

          {/* Billing behavior */}
          <div className="pt-2 border-t border-app-border space-y-3">
            <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Billing behavior</p>

            <div className="flex items-center justify-between">
              <label className="text-sm text-text-primary">Auto-renew by default</label>
              <button type="button" onClick={() => setAutoRenewDefault(!autoRenewDefault)} className={`relative inline-flex h-5 w-9 rounded-full transition ${autoRenewDefault ? "bg-brand" : "bg-app-border"}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${autoRenewDefault ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm text-text-primary">Allow manual renewal</label>
              <button type="button" onClick={() => setAllowManualRenewal(!allowManualRenewal)} className={`relative inline-flex h-5 w-9 rounded-full transition ${allowManualRenewal ? "bg-brand" : "bg-app-border"}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${allowManualRenewal ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm text-text-primary">Allow custom start/end dates per member</label>
              <button type="button" onClick={() => setAllowCustomDates(!allowCustomDates)} className={`relative inline-flex h-5 w-9 rounded-full transition ${allowCustomDates ? "bg-brand" : "bg-app-border"}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${allowCustomDates ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm text-text-primary">Allow billing day override per member</label>
              <button type="button" onClick={() => setAllowBillingDayOverride(!allowBillingDayOverride)} className={`relative inline-flex h-5 w-9 rounded-full transition ${allowBillingDayOverride ? "bg-brand" : "bg-app-border"}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${allowBillingDayOverride ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Default billing day <span className="text-text-muted font-normal">(1-28)</span></label>
                <input type="number" min="1" max="28" value={defaultBillingDay} onChange={(e) => setDefaultBillingDay(e.target.value)} placeholder="Signup date" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                <p className="text-xs text-text-muted mt-0.5">Blank = anchor to signup date</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Min. contract <span className="text-text-muted font-normal">(months)</span></label>
                <input type="number" min="1" value={contractMonths} onChange={(e) => setContractMonths(e.target.value)} placeholder="None" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
              </div>
            </div>
          </div>

          {/* Purchase options */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">Purchase options</label>
            <p className="text-xs text-text-muted mb-3">Custom label is what members see. Billing period determines the charge schedule.</p>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="border border-app-border rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <input type="text" value={opt.label} onChange={(e) => updateOption(i, "label", e.target.value)} placeholder="Display label (e.g. Monthly, 3-Month, Annual)" className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                    {options.length > 1 && (
                      <button type="button" onClick={() => removeOption(i)} className="text-text-muted hover:text-red-600 text-lg leading-none w-6">×</button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-text-muted text-sm">$</span>
                    <input type="number" step="0.01" value={opt.price} onChange={(e) => updateOption(i, "price", parseFloat(e.target.value) || 0)} className="w-24 px-2 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                    <select value={opt.billingPeriod} onChange={(e) => updateOption(i, "billingPeriod", e.target.value)} className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                      <option value="WEEKLY">Charged weekly</option>
                      <option value="MONTHLY">Charged monthly</option>
                      <option value="QUADRIMESTRAL">Charged every 4 months</option>
                      <option value="QUARTERLY">Charged every 3 months</option>
                      <option value="SEMI_ANNUAL">Charged every 6 months</option>
                      <option value="ANNUAL">Charged annually</option>
                      <option value="ONE_TIME">One-time payment</option>
                    </select>
                  </div>
                </div>
              ))}
              <button type="button" onClick={addOption} className="text-xs text-text-muted hover:text-text-primary">+ Add another option</button>
            </div>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Discount Modal ────────────────────────────────────────────────────────────
function DiscountModal({ discount, onClose, onSaved }: { discount: Discount | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!discount;
  const [code, setCode] = useState(discount?.code || "");
  const [description, setDescription] = useState(discount?.description || "");
  const [type, setType] = useState<"PERCENT" | "FIXED">(discount?.type || "PERCENT");
  const [value, setValue] = useState(discount ? String(discount.value) : "");
  const [maxUses, setMaxUses] = useState(discount?.maxUses ? String(discount.maxUses) : "");
  const [expiresAt, setExpiresAt] = useState(discount?.expiresAt ? new Date(discount.expiresAt).toISOString().slice(0, 10) : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      code: code.toUpperCase(),
      description: description || null,
      type,
      value: parseFloat(value),
      maxUses: maxUses ? parseInt(maxUses, 10) : null,
      expiresAt: expiresAt || null,
    };

    const url = isEdit ? `/api/discounts/${discount!.id}` : "/api/discounts";
    const method = isEdit ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSaving(false);
    if (!res.ok) { const data = await res.json(); setError(data.error?.toString() || "Save failed"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit discount" : "Create discount code"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
              placeholder="SUMMER20"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description (optional)</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Summer promotion" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Discount type</label>
              <select value={type} onChange={(e) => setType(e.target.value as "PERCENT" | "FIXED")} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                <option value="PERCENT">Percent off (%)</option>
                <option value="FIXED">Fixed amount ($)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Value</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">{type === "PERCENT" ? "%" : "$"}</span>
                <input type="number" step="0.01" min="0" value={value} onChange={(e) => setValue(e.target.value)} required placeholder="20" className="w-full pl-7 pr-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Max uses (optional)</label>
              <input type="number" min="1" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="Unlimited" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Expires (optional)</label>
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
