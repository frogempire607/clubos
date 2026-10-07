"use client";

// Add or edit ONE pay plan (Payroll → Pay plans, and a staff profile's Pay
// tab). A plan is: a name, the dates it is in force, a base rate, what that
// rate applies to (which classes, which roles — or which events), and optional
// bonuses. Saving edits the plan in place; paid pay lines never change.
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import Sheet from "@/components/Sheet";
import ScopePicker, { type CompOptions } from "@/components/staff/pay/ScopePicker";
import type { Scope } from "@/lib/staffCompensationDraft";
import { BONUS_LABELS, PLAN_BASE_LABELS, PLAN_BASE_TYPES, normalizePlanInput, type LedgerPlan, type PlanBaseType, type PlanBonusType } from "@/lib/payLedger";
import { emptyBonusRow, emptyPlanForm, planFormFromPlan, planInputFromForm, type BonusFormRow, type PlanForm } from "@/components/staff/pay/planDraft";

export type PlanOptions = CompOptions & {
  roles: string[];
  eventTypes: { id: string; name: string }[];
  today: string;
  /** The day a NEW plan starts by default: today, or the pay-ledger start date while that is still ahead. */
  newPlanStart?: string;
};

const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px]";
const input =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand md:min-h-[38px]";
const chip = (on: boolean) =>
  `min-h-[44px] rounded-md border px-2.5 text-[12.5px] md:min-h-[30px] ${on ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"}`;

const BONUS_SCOPES: Record<PlanBonusType, Scope["scopeType"][]> = {
  ATTENDANCE: ["CLASS", "EVENT"],
  SIGNUP: ["CLASS", "MEMBERSHIP"],
  REVENUE_SHARE: ["CLASS", "EVENT", "MEMBERSHIP", "PRIVATE_LESSON_TYPE"],
};
const BONUS_HELP: Record<PlanBonusType, { amountLabel: string; percent: boolean }> = {
  ATTENDANCE: { amountLabel: "Amount per member attending", percent: false },
  SIGNUP: { amountLabel: "Amount per signup", percent: false },
  REVENUE_SHARE: { amountLabel: "Percent of revenue", percent: true },
};

export default function PlanEditorSheet({
  open, staffId, staffName, plan, options, onClose, onSaved,
}: {
  open: boolean;
  staffId: string;
  staffName: string;
  /** null = a new plan */
  plan: LedgerPlan | null;
  options: PlanOptions;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const startDefault = options.newPlanStart ?? options.today;
  const [form, setForm] = useState<PlanForm>(() => emptyPlanForm(startDefault));
  const [roleText, setRoleText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(plan ? planFormFromPlan(plan) : emptyPlanForm(startDefault));
    setRoleText("");
    setError(null);
  }, [open, plan, startDefault]);

  const set = (patch: Partial<PlanForm>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (key: "classIds" | "roles" | "eventTypes" | "eventIds", id: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id] }));
  const setBonus = (i: number, patch: Partial<BonusFormRow>) =>
    setForm((f) => ({ ...f, bonuses: f.bonuses.map((b, n) => (n === i ? { ...b, ...patch } : b)) }));

  const base = PLAN_BASE_LABELS[form.baseType];
  const perClass = form.baseType === "PER_CLASS" || form.baseType === "HOURLY";
  const roleChoices = Array.from(new Set([...options.roles, ...form.roles]));

  function addRole() {
    const r = roleText.trim().slice(0, 60);
    if (!r) return;
    if (!form.roles.some((x) => x.toLowerCase() === r.toLowerCase())) set({ roles: [...form.roles, r] });
    setRoleText("");
  }

  async function save() {
    const { plan: clean, error: problem } = normalizePlanInput(planInputFromForm(form));
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const r = await fetch(plan ? `/api/staff/${staffId}/pay-plans/${plan.id}` : `/api/staff/${staffId}/pay-plans`, {
      method: plan ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clean),
    });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "The pay plan didn't save. Your edits are still here.");
      return;
    }
    onSaved(plan ? `Saved "${clean.name}".` : `Added "${clean.name}" for ${staffName}.`);
  }

  return (
    <Sheet
      open={open}
      onClose={() => (saving ? undefined : onClose())}
      title={plan ? `Edit pay plan` : `New pay plan for ${staffName}`}
      description={plan ? `${staffName} · ${plan.name}` : "A coach can have several plans — one per class, role or kind of work."}
      width={620}
      footer={
        <>
          <button type="button" disabled={saving} onClick={onClose} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`}>
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={save} className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}>
            {saving ? "Saving…" : plan ? "Save pay plan" : "Add pay plan"}
          </button>
        </>
      }
    >
      <div className="space-y-5 pt-1">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-text-primary">Plan name</span>
          <input className={input} value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Jr Frogs Assistant" />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block min-w-0">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Starts</span>
            <input type="date" className={input} value={form.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Ends (optional)</span>
            <input type="date" className={input} value={form.effectiveTo} min={form.effectiveFrom} onChange={(e) => set({ effectiveTo: e.target.value })} />
          </label>
        </div>

        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-text-primary">How it pays</legend>
          <div role="radiogroup" aria-label="How it pays" className="grid grid-cols-2 gap-2">
            {PLAN_BASE_TYPES.map((t) => {
              const on = form.baseType === t;
              return (
                <button key={t} type="button" role="radio" aria-checked={on} onClick={() => set({ baseType: t as PlanBaseType })}
                  className={`min-h-[44px] rounded-lg border px-3 py-2 text-left ${on ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"}`}>
                  <span className={`block text-[13.5px] font-medium ${on ? "text-brand" : "text-text-primary"}`}>{PLAN_BASE_LABELS[t].label}</span>
                  <span className="mt-0.5 block text-[12px] text-text-muted">{PLAN_BASE_LABELS[t].desc}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-text-primary">{base.amountLabel}</span>
          <div className="relative max-w-[220px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">$</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" className={`${input} pl-7`} value={form.baseAmount}
              onChange={(e) => set({ baseAmount: e.target.value })} placeholder="0.00" />
          </div>
          {form.baseType === "SALARY" && (
            <span className="mt-1 block text-[12px] text-text-muted">
              Paid once every pay period on {staffName}&apos;s pay schedule (weekly, every 2 weeks, …). Never prorated.
            </span>
          )}
        </label>

        {perClass && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-[13px] font-medium text-text-primary">Which classes</p>
              {options.classes.length === 0 ? (
                <p className="text-[12.5px] text-text-muted">No classes yet — this plan covers any class.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {options.classes.map((c) => (
                    <button key={c.id} type="button" aria-pressed={form.classIds.includes(c.id)} onClick={() => toggle("classIds", c.id)} className={chip(form.classIds.includes(c.id))}>
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[12px] text-text-muted">None selected = any class.</p>
            </div>
            <div>
              <p className="mb-1 text-[13px] font-medium text-text-primary">Which roles</p>
              <div className="flex flex-wrap gap-1.5">
                {roleChoices.map((r) => (
                  <button key={r} type="button" aria-pressed={form.roles.includes(r)} onClick={() => toggle("roles", r)} className={chip(form.roles.includes(r))}>
                    {r}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex max-w-[320px] gap-2">
                <input className={input} value={roleText} maxLength={60} onChange={(e) => setRoleText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRole(); } }} placeholder="Another role name" aria-label="Another role name" />
                <button type="button" onClick={addRole} className={`${btn} shrink-0 border border-app-border text-text-primary hover:bg-app-bg`}>Add</button>
              </div>
              <p className="mt-1 text-[12px] text-text-muted">
                None selected = any role. When two plans could pay the same class day, the more specific one wins (class and role, then class, then role).
              </p>
            </div>
          </div>
        )}

        {form.baseType === "PER_EVENT" && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-[13px] font-medium text-text-primary">Which kinds of event</p>
              <div className="flex flex-wrap gap-1.5">
                {options.eventTypes.map((t) => (
                  <button key={t.id} type="button" aria-pressed={form.eventTypes.includes(t.id)} onClick={() => toggle("eventTypes", t.id)} className={chip(form.eventTypes.includes(t.id))}>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
            {options.events.length > 0 && (
              <div>
                <p className="mb-1 text-[13px] font-medium text-text-primary">Or specific events</p>
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {options.events.map((ev) => (
                    <button key={ev.id} type="button" aria-pressed={form.eventIds.includes(ev.id)} onClick={() => toggle("eventIds", ev.id)} className={chip(form.eventIds.includes(ev.id))}>
                      {ev.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="text-[12px] text-text-muted">
              None selected = any event {staffName} is assigned to. An event that has its own pay set for them (Events → Pay) is paid there, not here.
            </p>
          </div>
        )}

        <div>
          <p className="text-[13px] font-medium text-text-primary">Bonuses (optional)</p>
          <div className="mt-2 space-y-3">
            {form.bonuses.map((b, i) => {
              const help = BONUS_HELP[b.bonusType];
              return (
                <div key={i} className="rounded-lg border border-app-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13.5px] font-medium text-text-primary">{BONUS_LABELS[b.bonusType]}</p>
                    <button type="button" onClick={() => set({ bonuses: form.bonuses.filter((_, n) => n !== i) })} aria-label={`Remove this ${BONUS_LABELS[b.bonusType].toLowerCase()}`}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-app-bg hover:text-text-primary md:h-8 md:w-8">
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                  <label className="mt-1 block">
                    <span className="mb-1 block text-[12px] text-text-muted">{help.amountLabel}</span>
                    <div className="relative max-w-[200px]">
                      {!help.percent && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">$</span>}
                      <input type="number" inputMode="decimal" min="0" step="0.01" className={`${input} ${help.percent ? "pr-8" : "pl-7"}`} value={b.amount}
                        onChange={(e) => setBonus(i, { amount: e.target.value })} placeholder="0.00" />
                      {help.percent && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">%</span>}
                    </div>
                  </label>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <label className="block min-w-0">
                      <span className="mb-1 block text-[12px] text-text-muted">Starts after</span>
                      <input type="number" inputMode="numeric" min="0" step="1" className={input} value={b.minThreshold} onChange={(e) => setBonus(i, { minThreshold: e.target.value })} placeholder="e.g. 10" />
                    </label>
                    <label className="block min-w-0">
                      <span className="mb-1 block text-[12px] text-text-muted">Caps at</span>
                      <input type="number" inputMode="numeric" min="0" step="1" className={input} value={b.maxThreshold} onChange={(e) => setBonus(i, { maxThreshold: e.target.value })} placeholder="e.g. 25" />
                    </label>
                  </div>
                  {b.bonusType === "ATTENDANCE" ? (
                    <div className="mt-3">
                      <p className="mb-1 text-[12px] text-text-muted">Count the attendance</p>
                      <div role="radiogroup" aria-label="Count the attendance" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {([["CLASS_DAY", "Each class day", "e.g. $5 for every member past 15 in that day's class"], ["PERIOD", "Over the pay period", "all attendance in the period added together"]] as const).map(([v, label, d]) => {
                          const on = b.countPer === v;
                          return (
                            <button key={v} type="button" role="radio" aria-checked={on} onClick={() => setBonus(i, { countPer: v })}
                              className={`min-h-[44px] rounded-lg border px-3 py-2 text-left ${on ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"}`}>
                              <span className={`block text-[13px] font-medium ${on ? "text-brand" : "text-text-primary"}`}>{label}</span>
                              <span className="block text-[12px] text-text-muted">{d}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-[12px] text-text-muted">Counted over the pay period, so it needs a pay schedule.</p>
                  )}
                  <div className="mt-3">
                    <ScopePicker allowed={BONUS_SCOPES[b.bonusType]} opts={options} scopes={b.scopes as Scope[]} onChange={(s) => setBonus(i, { scopes: s })} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0">
            {(["ATTENDANCE", "SIGNUP", "REVENUE_SHARE"] as PlanBonusType[]).map((t) => (
              <button key={t} type="button" onClick={() => set({ bonuses: [...form.bonuses, emptyBonusRow(t)] })}
                className="inline-flex min-h-[44px] items-center gap-1 text-[13px] font-medium text-brand hover:underline md:min-h-[32px]">
                <Plus className="h-3.5 w-3.5" aria-hidden /> {BONUS_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {plan && (
          <p className="rounded-lg border border-dashed border-app-border px-3 py-2 text-[12.5px] text-text-muted">
            Saving re-prices {staffName}&apos;s <strong>unpaid</strong> pay lines that this plan covers. Lines already paid never change. To change the rate
            from a date instead, set an end date here and add a new plan that starts the next day.
          </p>
        )}
        {error && <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>{error}</p>}
      </div>
    </Sheet>
  );
}
