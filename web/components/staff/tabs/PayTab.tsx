"use client";

// B21 — Pay tab: the compensation plan that used to sit inside the Edit Staff
// modal (same model, same GET/PUT /api/staff/[id]/compensation). Base type
// + amount, then each bonus type as a switch whose fields reveal in place.
// One sticky "Save pay plan". Staff can see their own plan but never change
// it — the server refuses, and this tab is read-only for them.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Lock, Plus, X } from "lucide-react";
import Reveal from "@/components/staff/access/Reveal";
import Switch from "@/components/staff/access/Switch";
import ScopePicker, { type CompOptions } from "@/components/staff/pay/ScopePicker";
import PayScheduleCard from "@/components/staff/pay/PayScheduleCard";
import {
  BASE_META,
  BONUS_META,
  BONUS_SCOPES,
  BONUS_TYPES,
  bonusIndexes,
  emptyBonus,
  payChangeCount,
  planSummaryLines,
  setBonusTypeOn,
} from "@/components/staff/pay/payModel";
import { compDraftFromPlan, compIsDirty, compPayload, type BonusDraft, type CompDraft } from "@/lib/staffCompensationDraft";
import type { StaffTabProps } from "@/components/staff/types";

const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px]";
const input =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-70 md:min-h-[38px]";
const EMPTY_OPTS: CompOptions = { classes: [], events: [], memberships: [], lessonTypes: [] };

export default function PayTab({ data, reload, setDirty }: StaffTabProps) {
  const { staff, viewer } = data;
  const first = staff.firstName || "this staff member";

  const [saved, setSaved] = useState<CompDraft | null>(null);
  const [draft, setDraft] = useState<CompDraft | null>(null);
  const [opts, setOpts] = useState<CompOptions>(EMPTY_OPTS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [scheduleDirty, setScheduleDirty] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/${staff.id}/compensation`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setLoadError(typeof d.error === "string" ? d.error : "Couldn't load the pay plan.");
      return;
    }
    if (d?.options) setOpts(d.options);
    const plan = compDraftFromPlan(d?.plan ?? null);
    setSaved(plan);
    setDraft(plan);
    setLoadError(null);
  }, [staff.id]);

  useEffect(() => {
    if (viewer.canViewPay) load();
  }, [viewer.canViewPay, load]);

  const readOnly = !viewer.canEditPay || viewer.isSelf;
  const snapshot = saved ? JSON.stringify(saved) : "";
  const dirty = !readOnly && compIsDirty(snapshot, draft);
  const changeCount = dirty && saved && draft ? payChangeCount(saved, draft) : 0;

  useEffect(() => {
    setDirty(dirty || scheduleDirty);
  }, [dirty, scheduleDirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  if (!viewer.canViewPay) {
    return (
      <LockedCard>
        Pay is visible to the owner and staff with Financials &amp; payroll: view.
      </LockedCard>
    );
  }
  if (loadError) {
    return (
      <div className="rounded-xl border border-app-border bg-surface p-5 text-[13px]" style={{ color: "var(--color-danger-text)" }}>
        {loadError}
      </div>
    );
  }
  if (!draft || !saved) {
    return <div className="rounded-xl border border-app-border bg-surface p-5 text-[13px] text-text-muted">Loading pay plan…</div>;
  }

  const set = (next: CompDraft) => {
    setFlash(null);
    setDraft(next);
  };
  const updateBonus = (i: number, patch: Partial<BonusDraft>) =>
    set({ ...draft, bonuses: draft.bonuses.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });
  const removeBonus = (i: number) => set({ ...draft, bonuses: draft.bonuses.filter((_, idx) => idx !== i) });

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const r = await fetch(`/api/staff/${staff.id}/compensation`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compPayload(draft)),
    });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "The pay plan didn't save. Your edits are still here.");
      return;
    }
    setDirty(false);
    await load();
    setFlash("Pay plan saved.");
    await reload();
  }

  const base = BASE_META[draft.baseType];
  return (
    <div className="pb-4">
      {readOnly && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-dashed border-app-border px-4 py-3 text-[13px] text-text-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {viewer.isSelf
              ? "Your pay is set by the owner."
              : `Only the owner and staff with Financials & payroll: full can change ${first}'s pay.`}
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[1.55fr_1fr]">
        <section className="min-w-0 rounded-xl border border-app-border bg-surface p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold text-text-primary">Compensation plan</h2>
          <p className="mt-0.5 text-[12.5px] text-text-muted">Base pay plus optional bonuses. Bonuses stack.</p>

          <fieldset disabled={readOnly} className="min-w-0">
            <legend className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-text-muted">Base compensation</legend>
            <div role="radiogroup" aria-label="Base compensation" className="mt-2 grid gap-2 sm:grid-cols-3">
              {(Object.keys(BASE_META) as CompDraft["baseType"][]).map((t) => {
                const on = draft.baseType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ ...draft, baseType: t })}
                    className={`min-h-[44px] rounded-lg border px-3 py-2.5 text-left disabled:cursor-not-allowed ${
                      on ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"
                    }`}
                  >
                    <span className={`block text-[13.5px] font-medium ${on ? "text-brand" : "text-text-primary"}`}>
                      {BASE_META[t].label}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-text-muted">{BASE_META[t].desc}</span>
                  </button>
                );
              })}
            </div>

            <label htmlFor="pay-base-amount" className="mt-3 block text-[13px] font-medium text-text-primary">
              {base.amountLabel}
            </label>
            <MoneyInput
              id="pay-base-amount"
              value={draft.baseAmount}
              onChange={(v) => set({ ...draft, baseAmount: v })}
              prefix="$"
            />

            <Reveal open={draft.baseType === "PER_CLASS" || draft.baseType === "HOURLY"}>
              <div className="pt-3">
                <p className="mb-1 text-[13px] font-medium text-text-primary">Assigned classes (optional)</p>
                <ScopePicker
                  allowed={["CLASS"]}
                  opts={opts}
                  scopes={draft.baseScopes}
                  disabled={readOnly}
                  onChange={(s) => set({ ...draft, baseScopes: s })}
                />
              </div>
            </Reveal>

            <p className="mt-6 text-[12px] font-semibold uppercase tracking-wide text-text-muted">Bonuses</p>
            <ul className="mt-1">
              {BONUS_TYPES.map((type) => {
                const meta = BONUS_META[type];
                const idx = bonusIndexes(draft, type);
                const on = idx.length > 0;
                const changed =
                  JSON.stringify(saved.bonuses.filter((b) => b.bonusType === type)) !==
                  JSON.stringify(draft.bonuses.filter((b) => b.bonusType === type));
                return (
                  <li key={type} className="border-b border-[var(--color-hairline)] py-2 last:border-b-0">
                    <div className="flex items-start gap-2">
                      <Switch
                        checked={on}
                        disabled={readOnly}
                        label={meta.label}
                        onChange={(v) => set(setBonusTypeOn(draft, type, v))}
                      />
                      <div className="min-w-0 flex-1 pt-2.5 md:pt-0.5">
                        <p className="text-[14px] font-medium text-text-primary">
                          {meta.label}
                          {!readOnly && changed && (
                            <span className="ml-1.5 rounded-full bg-brand/10 px-1.5 py-0.5 text-[12px] font-medium text-brand">
                              Changed
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[12.5px] text-text-muted">{meta.desc}</p>
                      </div>
                    </div>
                    <Reveal open={on}>
                      <div className="space-y-3 pb-1 pl-0 pt-2 md:pl-[46px]">
                        {idx.map((i, n) => (
                          <BonusFields
                            key={i}
                            bonus={draft.bonuses[i]}
                            opts={opts}
                            readOnly={readOnly}
                            numbered={idx.length > 1 ? n + 1 : null}
                            onChange={(patch) => updateBonus(i, patch)}
                            onRemove={idx.length > 1 ? () => removeBonus(i) : null}
                          />
                        ))}
                        {!readOnly && on && (
                          <button
                            type="button"
                            onClick={() => set({ ...draft, bonuses: [...draft.bonuses, emptyBonus(type)] })}
                            className="inline-flex min-h-[44px] items-center gap-1 text-[13px] font-medium text-brand hover:underline md:min-h-0"
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden /> Add another {meta.label.toLowerCase()}
                          </button>
                        )}
                      </div>
                    </Reveal>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          <PayScheduleCard
            staffId={staff.id}
            first={first}
            readOnly={readOnly}
            isSelf={viewer.isSelf}
            onDirtyChange={setScheduleDirty}
          />
          <section className="rounded-xl border border-app-border bg-surface p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold text-text-primary">The plan as shown</h2>
            <ul className="mt-2 space-y-1.5">
              {planSummaryLines(draft).map((l) => (
                <li key={l} className="text-[13px] text-text-primary">
                  {l}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12.5px] text-text-muted">
              This is the plan, not an amount owed. Payroll works out the final amount for a period from the saved plan.
            </p>
          </section>
          {!viewer.isSelf && (
            <section className="rounded-xl border border-app-border bg-surface p-2">
              <PayLink href="/dashboard/staff/payroll" title="Payroll" desc={`Calculates what ${first} is owed from this plan for any period.`} />
              <PayLink href="/dashboard/staff/payouts" title="Payouts" desc={`Records what you actually paid ${first}, and when.`} />
            </section>
          )}
        </div>
      </div>

      {!readOnly && (dirty || flash || error) && (
        <div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))] z-20 mt-4 rounded-xl border border-app-border bg-surface px-4 py-3 shadow-lg md:bottom-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-text-muted" role="status">
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />}
              <span>
                {dirty
                  ? `${changeCount} unsaved change${changeCount === 1 ? "" : "s"} to ${first}'s pay plan`
                  : flash}
              </span>
            </div>
            {dirty && (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setError(null);
                  setDraft(saved);
                }}
                className={`${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`}
              >
                Discard
              </button>
            )}
            {dirty && (
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}
              >
                {saving ? "Saving…" : "Save pay plan"}
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-2 text-[13px]" style={{ color: "var(--color-danger-text)" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LockedCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-app-border bg-surface px-5 py-4 text-[13px] text-text-muted">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function MoneyInput({
  id,
  value,
  onChange,
  prefix,
  suffix,
  label,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  label?: string;
}) {
  return (
    <div className="relative mt-1 w-full max-w-[200px]">
      {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">{prefix}</span>}
      <input
        id={id}
        aria-label={label}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        className={`${input} ${prefix ? "pl-7" : ""} ${suffix ? "pr-8" : ""}`}
      />
      {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">{suffix}</span>}
    </div>
  );
}

function BonusFields({
  bonus,
  opts,
  readOnly,
  numbered,
  onChange,
  onRemove,
}: {
  bonus: BonusDraft;
  opts: CompOptions;
  readOnly: boolean;
  numbered: number | null;
  onChange: (patch: Partial<BonusDraft>) => void;
  onRemove: (() => void) | null;
}) {
  const meta = BONUS_META[bonus.bonusType];
  return (
    <div className="rounded-lg border border-app-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-text-primary">
            {meta.amountLabel}
            {numbered !== null && <span className="text-text-muted"> · #{numbered}</span>}
          </p>
          <MoneyInput
            label={meta.amountLabel}
            value={bonus.amount}
            onChange={(v) => onChange({ amount: v })}
            prefix={meta.percent ? undefined : "$"}
            suffix={meta.percent ? "%" : undefined}
          />
          {!readOnly && bonus.amount.trim() === "" && (
            <p className="mt-1 text-[12px]" style={{ color: "var(--color-warn-text)" }}>
              Enter an amount — a bonus with no amount isn&apos;t saved.
            </p>
          )}
        </div>
        {onRemove && !readOnly && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove this ${meta.label.toLowerCase()}`}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-app-bg hover:text-text-primary md:h-8 md:w-8"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className="mb-1 block text-[12px] text-text-muted">Starts after</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={bonus.minThreshold}
            onChange={(e) => onChange({ minThreshold: e.target.value })}
            placeholder="e.g. 10"
            className={input}
          />
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-[12px] text-text-muted">Caps at</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={bonus.maxThreshold}
            onChange={(e) => onChange({ maxThreshold: e.target.value })}
            placeholder="e.g. 25"
            className={input}
          />
        </label>
      </div>
      <p className="mt-1 text-[12px] text-text-muted">
        Pays only for items above the &ldquo;starts after&rdquo; count, up to the &ldquo;caps at&rdquo; count. Leave blank for no limit.
      </p>

      <div className="mt-3">
        <ScopePicker
          allowed={BONUS_SCOPES[bonus.bonusType]}
          opts={opts}
          scopes={bonus.scopes}
          disabled={readOnly}
          onChange={(s) => onChange({ scopes: s })}
        />
      </div>
    </div>
  );
}

function PayLink({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-app-bg">
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-text-primary">{title}</span>
        <span className="block text-[12.5px] text-text-muted">{desc}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
    </Link>
  );
}
