"use client";

import { useEffect, useState } from "react";
import { Ticket } from "lucide-react";

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
  trialEnabled: boolean;
  trialDays: number | null;
  trialAppliesToReturning: boolean;
  createdAt: string;
  _count: { members: number };
};

type FreeTrialConfig = {
  name: string;
  days: number;
  membershipIds: string[];
  renewable: boolean;
  allowRepeatUse: boolean;
  active: boolean;
};
type FreeTrialInfo = {
  config: FreeTrialConfig | null;
  legacyTrialMemberships: { id: string; name: string; trialDays: number | null; trialAppliesToReturning: boolean }[];
  signupUrl: string;
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
  membershipIds: string[];
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
  const [clubSlug, setClubSlug] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [showAddDiscount, setShowAddDiscount] = useState(false);
  const [editingDiscount, setEditingDiscount] = useState<Discount | null>(null);
  const [freeTrial, setFreeTrial] = useState<FreeTrialInfo | null>(null);
  const [showFreeTrial, setShowFreeTrial] = useState(false);

  async function load() {
    setLoading(true);
    const [mRes, dRes, cRes, tRes] = await Promise.all([
      fetch("/api/memberships"),
      fetch("/api/discounts"),
      fetch("/api/club/info"),
      fetch("/api/club/free-trial"),
    ]);
    if (mRes.ok) setMemberships(await mRes.json());
    if (dRes.ok) setDiscounts(await dRes.json());
    if (cRes.ok) {
      const c = await cRes.json().catch(() => null);
      if (c?.slug) setClubSlug(c.slug);
    }
    if (tRes.ok) setFreeTrial(await tRes.json().catch(() => null));
    setLoading(false);
  }

  // The per-membership "include in free trial" toggle edits the ONE central
  // offer: attach/detach the plan (creating the offer with defaults on first
  // use). An offer with an empty membershipIds list applies to ALL plans, so
  // detaching from that state materializes the explicit list first.
  async function syncMembershipTrial(membershipId: string, include: boolean, seedDays: number) {
    const cfg = freeTrial?.config ?? null;
    const allIds = Array.from(new Set([...memberships.map((m) => m.id), membershipId]));
    let next: FreeTrialConfig;
    if (!cfg) {
      if (!include) return;
      next = {
        name: "Free trial",
        days: seedDays,
        membershipIds: [membershipId],
        renewable: true,
        allowRepeatUse: false,
        active: true,
      };
    } else {
      let ids = cfg.membershipIds;
      if (ids.length === 0 && cfg.active) {
        if (include) return; // already applies to every plan
        ids = allIds.filter((id) => id !== membershipId);
      } else {
        ids = include
          ? Array.from(new Set([...ids, membershipId]))
          : ids.filter((id) => id !== membershipId);
      }
      next = { ...cfg, membershipIds: ids, active: include ? true : cfg.active };
    }
    await fetch("/api/club/free-trial", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => {});
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this membership? Members on this plan won't be affected.")) return;
    const res = await fetch(`/api/memberships/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function handleDuplicate(id: string) {
    const res = await fetch(`/api/memberships/${id}/duplicate`, { method: "POST" });
    if (res.ok) load();
    else alert("Could not duplicate this membership.");
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

  // Copy the public registration link for a membership. Owners drop this on a
  // website / email / social post; it opens /join/[slug]?m=<id>, which shows the
  // plan with club branding and funnels into the existing signup/onboarding.
  function copyPublicLink(m: Membership) {
    if (!clubSlug) {
      alert("Set your club URL (slug) in Settings → Club first so the public link works.");
      return;
    }
    const url = `${window.location.origin}/join/${clubSlug}?m=${m.id}`;
    const done = () => {
      setCopiedId(m.id);
      setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1800);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () =>
        window.prompt("Copy this public registration link:", url),
      );
    } else {
      window.prompt("Copy this public registration link:", url);
    }
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Memberships</h1>
          <p className="text-sm text-text-muted">{memberships.length} plan{memberships.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFreeTrial(true)}
            className="px-4 py-2 border border-app-border rounded-lg text-sm font-medium text-text-primary hover:bg-app-bg"
          >
            Free trial
            {freeTrial?.config?.active && (
              <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-lime-accent/25 text-text-primary">
                {freeTrial.config.days}d
              </span>
            )}
          </button>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add membership
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : memberships.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Ticket className="h-7 w-7" strokeWidth={2} />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No memberships yet</h3>
          <p className="text-sm text-text-muted mb-4">Create your first plan — any name, any price, any time period.</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add membership
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  <div className="flex gap-1 flex-wrap justify-end">
                    {m.active && m.purchaseAccess !== "STAFF_ONLY" && (
                      <button
                        onClick={() => copyPublicLink(m)}
                        title="Copy a public registration link for this plan"
                        className="text-xs text-brand hover:bg-brand/10 px-2 py-1 rounded font-medium"
                      >
                        {copiedId === m.id ? "Copied!" : "Copy link"}
                      </button>
                    )}
                    <button onClick={() => handleToggleActive(m)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                      {m.active ? "Deactivate" : "Activate"}
                    </button>
                    <button onClick={() => setEditing(m)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                    <button onClick={() => handleDuplicate(m.id)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Duplicate</button>
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
                      <div className="text-xs text-text-muted">
                        {(() => {
                          const types = Array.isArray((d as { appliesTo?: unknown }).appliesTo)
                            ? ((d as unknown as { appliesTo: string[] }).appliesTo)
                            : [];
                          const plans = Array.isArray(d.membershipIds) ? d.membershipIds : [];
                          const parts: string[] = [];
                          if (types.length > 0) {
                            parts.push(
                              types
                                .map((t) => DISCOUNT_ITEM_TYPES.find((x) => x.key === t)?.label || t)
                                .join(", "),
                            );
                          }
                          if (plans.length > 0) {
                            parts.push(
                              `plans: ${plans.map((id) => memberships.find((m) => m.id === id)?.name || "(deleted plan)").join(", ")}`,
                            );
                          }
                          return parts.length > 0
                            ? `Applies to: ${parts.join(" · ")}`
                            : "Applies to all purchase options";
                        })()}
                      </div>
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
          trialConfig={freeTrial?.config ?? null}
          onSyncTrial={syncMembershipTrial}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {showFreeTrial && (
        <FreeTrialModal
          info={freeTrial}
          memberships={memberships}
          onClose={() => setShowFreeTrial(false)}
          onSaved={() => { setShowFreeTrial(false); load(); }}
        />
      )}

      {(showAddDiscount || editingDiscount) && (
        <DiscountModal
          discount={editingDiscount}
          memberships={memberships}
          onClose={() => { setShowAddDiscount(false); setEditingDiscount(null); }}
          onSaved={() => { setShowAddDiscount(false); setEditingDiscount(null); load(); }}
        />
      )}
    </div>
  );
}

function MembershipModal({ membership, trialConfig, onSyncTrial, onClose, onSaved }: {
  membership: Membership | null;
  trialConfig: FreeTrialConfig | null;
  onSyncTrial: (membershipId: string, include: boolean, seedDays: number) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
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
  // Whether the club's central Free Trial offer currently covers this plan
  // (legacy per-membership flag only for clubs that never configured it).
  const trialCurrentlyApplies = trialConfig
    ? trialConfig.active &&
      (trialConfig.membershipIds.length === 0 ||
        (membership ? trialConfig.membershipIds.includes(membership.id) : false))
    : membership?.trialEnabled ?? false;
  const [includeTrial, setIncludeTrial] = useState(trialCurrentlyApplies);
  const [trialDays, setTrialDays] = useState(membership?.trialDays ? String(membership.trialDays) : "14");
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

    if (!res.ok) { setSaving(false); const data = await res.json(); setError(data.error?.toString() || "Save failed"); return; }

    // Attach/detach this plan on the club's single Free Trial offer.
    const saved = await res.json().catch(() => null);
    const savedId: string | undefined = membership?.id ?? saved?.id;
    if (savedId && includeTrial !== trialCurrentlyApplies) {
      await onSyncTrial(savedId, includeTrial, parseInt(trialDays, 10) || 14);
    }
    setSaving(false);
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
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

          {/* Free trial — one club-wide offer; this just attaches the plan */}
          <div className="pt-2 border-t border-app-border space-y-3">
            <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Free trial</p>

            <div className="flex items-center justify-between gap-3">
              <div>
                <label className="text-sm text-text-primary block">Include this plan in the club&apos;s Free Trial offer</label>
                <p className="text-[11px] text-text-muted">
                  {trialConfig
                    ? `Uses “${trialConfig.name}” — ${trialConfig.days} day${trialConfig.days === 1 ? "" : "s"}. Configure the offer from the Free trial button on the Memberships page.`
                    : "Saving creates the club-wide Free Trial offer with this plan attached — configure it anytime from the Free trial button."}
                </p>
              </div>
              <button type="button" onClick={() => setIncludeTrial(!includeTrial)} className={`relative inline-flex h-5 w-9 rounded-full transition flex-shrink-0 ${includeTrial ? "bg-brand" : "bg-app-border"}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${includeTrial ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>

            {!trialConfig && includeTrial && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Trial length <span className="text-text-muted font-normal">(days)</span></label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                  className="w-32 px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
            )}
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

// ── Free Trial Modal ─────────────────────────────────────────────────────────
// The club's ONE free-trial offer (Club.freeTrialConfig): behaves like its own
// product — create, edit, disable, or stop offering it entirely.
function FreeTrialModal({ info, memberships, onClose, onSaved }: {
  info: FreeTrialInfo | null;
  memberships: Membership[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const cfg = info?.config ?? null;
  // First open on a club with legacy per-membership trials: preseed from them
  // so saving consolidates what the owner already had.
  const legacy = info?.legacyTrialMemberships ?? [];
  const [name, setName] = useState(cfg?.name ?? "Free trial");
  const [days, setDays] = useState(String(cfg?.days ?? (legacy[0]?.trialDays || 14)));
  const [membershipIds, setMembershipIds] = useState<string[]>(
    cfg?.membershipIds ?? legacy.map((m) => m.id),
  );
  const [renewable, setRenewable] = useState(cfg?.renewable ?? true);
  const [allowRepeatUse, setAllowRepeatUse] = useState(cfg?.allowRepeatUse ?? false);
  const [active, setActive] = useState(cfg?.active ?? true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  function toggleMembership(id: string) {
    setMembershipIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const res = await fetch("/api/club/free-trial", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim() || "Free trial",
        days: parseInt(days, 10) || 14,
        membershipIds,
        renewable,
        allowRepeatUse,
        active,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    onSaved();
  }

  async function handleRemove() {
    if (!confirm("Stop offering a free trial? New signups and subscriptions won't get one until you set it up again.")) return;
    setSaving(true);
    const res = await fetch("/api/club/free-trial", { method: "DELETE" });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not remove the offer");
      return;
    }
    onSaved();
  }

  async function copyLink() {
    if (!info?.signupUrl) return;
    try {
      await navigator.clipboard.writeText(info.signupUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy the free-trial signup link:", info.signupUrl);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">Free trial</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-4">
          <p className="text-xs text-text-muted">
            One offer for the whole club: trial members can book classes free for the trial
            period, and card subscriptions on the attached plans delay the first charge by the
            trial length.
          </p>

          {!cfg && legacy.length > 0 && (
            <div className="text-xs text-text-primary bg-lime-accent/15 border border-lime-accent/40 rounded-lg px-3 py-2">
              Saving consolidates the trials currently set on {legacy.map((m) => m.name).join(", ")} into this single offer.
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-text-primary block">Offer a free trial</label>
              <p className="text-[11px] text-text-muted">Off = no trial anywhere (signup link, subscriptions, trial check-ins).</p>
            </div>
            <button type="button" onClick={() => setActive(!active)} className={`relative inline-flex h-5 w-9 rounded-full transition flex-shrink-0 ${active ? "bg-brand" : "bg-app-border"}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${active ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Trial name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Length (days)</label>
              <input type="number" min="1" max="365" value={days} onChange={(e) => setDays(e.target.value)} required className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Applies to</label>
            <p className="text-xs text-text-muted mb-2">
              {membershipIds.length === 0
                ? "All memberships and purchase options (default)."
                : "Only the selected memberships get the subscription trial."}
            </p>
            <div className="max-h-36 overflow-y-auto border border-app-border rounded-lg divide-y divide-app-border">
              {memberships.map((m) => (
                <label key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary cursor-pointer hover:bg-app-bg">
                  <input type="checkbox" checked={membershipIds.includes(m.id)} onChange={() => toggleMembership(m.id)} className="rounded border-app-border" />
                  {m.name}
                </label>
              ))}
              {memberships.length === 0 && (
                <p className="px-3 py-2 text-xs text-text-muted">No membership plans yet — the trial will apply to all future plans.</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-text-primary block">Renewable</label>
              <p className="text-[11px] text-text-muted">Off = once a client&apos;s trial window expires, they can never get another one.</p>
            </div>
            <button type="button" onClick={() => setRenewable(!renewable)} className={`relative inline-flex h-5 w-9 rounded-full transition flex-shrink-0 ${renewable ? "bg-brand" : "bg-app-border"}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${renewable ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-text-primary block">Same client can use it multiple times</label>
              <p className="text-[11px] text-text-muted">Off = no subscription trial on a plan they already had before (abuse-proof default).</p>
            </div>
            <button type="button" onClick={() => setAllowRepeatUse(!allowRepeatUse)} className={`relative inline-flex h-5 w-9 rounded-full transition flex-shrink-0 ${allowRepeatUse ? "bg-brand" : "bg-app-border"}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${allowRepeatUse ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Public signup link</label>
            <div className="flex gap-2">
              <input readOnly value={info?.signupUrl ?? ""} className="flex-1 px-3 py-2 border border-app-border rounded-lg text-xs text-text-muted bg-app-bg" onFocus={(e) => e.target.select()} />
              <button type="button" onClick={copyLink} className="px-3 py-2 border border-app-border rounded-lg text-xs text-text-primary hover:bg-app-bg">
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-text-muted mt-1">New clients who sign up through this link start their trial immediately.</p>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {(cfg || legacy.length > 0) && (
            <button type="button" onClick={handleRemove} disabled={saving} className="w-full text-xs text-red-600 hover:bg-red-50 rounded-lg px-3 py-2">
              Stop offering a free trial
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

// ── Discount Modal ────────────────────────────────────────────────────────────
const DISCOUNT_ITEM_TYPES: { key: string; label: string }[] = [
  { key: "MEMBERSHIP", label: "Memberships" },
  { key: "EVENT", label: "Events" },
  { key: "CLASS", label: "Class drop-ins" },
  { key: "PRODUCT", label: "Products" },
  { key: "PRIVATE_PACK", label: "Lesson packs" },
];

function DiscountModal({ discount, memberships, onClose, onSaved }: { discount: Discount | null; memberships: Membership[]; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!discount;
  const [code, setCode] = useState(discount?.code || "");
  const [description, setDescription] = useState(discount?.description || "");
  const [type, setType] = useState<"PERCENT" | "FIXED">(discount?.type || "PERCENT");
  const [value, setValue] = useState(discount ? String(discount.value) : "");
  const [maxUses, setMaxUses] = useState(discount?.maxUses ? String(discount.maxUses) : "");
  const [expiresAt, setExpiresAt] = useState(discount?.expiresAt ? new Date(discount.expiresAt).toISOString().slice(0, 10) : "");
  const [scopedIds, setScopedIds] = useState<string[]>(Array.isArray(discount?.membershipIds) ? discount!.membershipIds : []);
  const [appliesTo, setAppliesTo] = useState<string[]>(
    Array.isArray((discount as { appliesTo?: unknown } | null)?.appliesTo)
      ? ((discount as unknown as { appliesTo: string[] }).appliesTo)
      : [],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleScope(id: string) {
    setScopedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleType(key: string) {
    setAppliesTo((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]));
  }

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
      membershipIds: scopedIds,
      appliesTo,
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Max uses (optional)</label>
              <input type="number" min="1" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="Unlimited" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Expires (optional)</label>
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Applies to</label>
            <p className="text-xs text-text-muted mb-2">
              {appliesTo.length === 0
                ? "Every purchase type (default). Check types to restrict the code."
                : "Only the checked purchase types."}
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {DISCOUNT_ITEM_TYPES.map((t) => {
                const active = appliesTo.includes(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => toggleType(t.key)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition ${
                      active
                        ? "bg-brand text-white border-transparent"
                        : "border-app-border text-text-muted hover:bg-app-bg"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            {(appliesTo.length === 0 || appliesTo.includes("MEMBERSHIP")) && (
              <>
                <p className="text-xs text-text-muted mb-2">
                  {scopedIds.length === 0
                    ? "Covers every membership plan. Check plans to narrow it."
                    : "Only the selected membership plans."}
                </p>
                <div className="max-h-36 overflow-y-auto border border-app-border rounded-lg divide-y divide-app-border">
                  {memberships.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary cursor-pointer hover:bg-app-bg">
                      <input
                        type="checkbox"
                        checked={scopedIds.includes(m.id)}
                        onChange={() => toggleScope(m.id)}
                        className="rounded border-app-border"
                      />
                      {m.name}
                    </label>
                  ))}
                  {memberships.length === 0 && (
                    <p className="px-3 py-2 text-xs text-text-muted">No membership plans yet — the code will apply to all future plans.</p>
                  )}
                </div>
              </>
            )}
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
