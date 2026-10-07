"use client";

// Pay plans — every coach's named, dated plans, with add / edit / copy /
// remove. Used on Payroll → Pay plans (everyone) and on a staff profile's Pay
// tab (one person, `staffId`). Read-only for anyone without Financials &
// payroll: full, and always read-only on your own pay.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import Sheet from "@/components/Sheet";
import PlanEditorSheet, { type PlanOptions } from "@/components/staff/pay/PlanEditorSheet";
import { fmtYmdYear, planState, planSummaryLines, type LedgerPlan, type ScopeNames } from "@/lib/payLedger";

type StaffPlans = { id: string; name: string; title?: string | null; hasSchedule: boolean; plans: LedgerPlan[]; warnings: string[] };
type Resp = {
  today: string;
  ledgerStart: string | null;
  options: PlanOptions;
  staff: StaffPlans[];
  viewer: { canEdit: boolean; userId: string; isOwner: boolean };
};

const btn = "inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium md:min-h-[34px]";
const input =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand md:min-h-[38px]";

const STATE_WORDS = { ACTIVE: "In force", UPCOMING: "Not started", ENDED: "Ended", ARCHIVED: "Removed" } as const;

function namesOf(o: PlanOptions): ScopeNames {
  const map = (list: { id: string; name: string }[]) => Object.fromEntries(list.map((x) => [x.id, x.name]));
  return { classes: map(o.classes), events: map(o.events), memberships: map(o.memberships), lessonTypes: map(o.lessonTypes) };
}

export default function PayPlansPanel({ staffId, onChanged }: { staffId?: string; onChanged?: () => void }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ staff: StaffPlans; plan: LedgerPlan | null } | null>(null);
  const [copying, setCopying] = useState<{ staff: StaffPlans; plan: LedgerPlan } | null>(null);
  const [removing, setRemoving] = useState<{ staff: StaffPlans; plan: LedgerPlan } | null>(null);
  const [showOld, setShowOld] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // copy form
  const [copyTo, setCopyTo] = useState<string[]>([]);
  const [copyName, setCopyName] = useState("");
  const [copyFrom, setCopyFrom] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(staffId ? `/api/staff/${staffId}/pay-plans` : "/api/payroll/plans", { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setLoadError(typeof d.error === "string" ? d.error : "Couldn't load pay plans.");
      return;
    }
    setLoadError(null);
    setData(d);
  }, [staffId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) {
    return <div className="rounded-xl border border-app-border bg-surface p-5 text-[13px]" style={{ color: "var(--color-danger-text)" }}>{loadError}</div>;
  }
  if (!data) return <div className="h-32 animate-pulse rounded-xl border border-app-border bg-surface" aria-label="Loading pay plans" />;

  const { viewer, today } = data;
  // While the pay ledger has not started yet, new plans and copies start on its first day by default.
  const newPlanStart = data.ledgerStart && data.ledgerStart > today ? data.ledgerStart : today;
  const options: PlanOptions = { ...data.options, newPlanStart };
  const names = namesOf(options);
  const canEditFor = (s: StaffPlans) => viewer.canEdit && (viewer.isOwner || s.id !== viewer.userId);

  async function done(message: string) {
    setEditing(null);
    setCopying(null);
    setRemoving(null);
    setFlash(message);
    await load();
    onChanged?.();
  }

  function openCopy(staff: StaffPlans, plan: LedgerPlan) {
    setCopying({ staff, plan });
    setCopyTo([]);
    setCopyName(plan.name);
    setCopyFrom(newPlanStart);
    setError(null);
  }

  async function doCopy() {
    if (!copying) return;
    if (copyTo.length === 0) {
      setError("Choose who gets the copy.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/staff/${copying.staff.id}/pay-plans/${copying.plan.id}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toUserIds: copyTo, name: copyName.trim() || null, effectiveFrom: copyFrom }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "The copy didn't save.");
      return;
    }
    await done(`Copied "${copying.plan.name}" to ${copyTo.length} ${copyTo.length === 1 ? "person" : "people"}. Each copy is its own plan.`);
  }

  async function doRemove() {
    if (!removing) return;
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/staff/${removing.staff.id}/pay-plans/${removing.plan.id}`, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "That didn't save.");
      return;
    }
    await done(`Removed "${removing.plan.name}".`);
  }

  // For the copy sheet: everyone the caller may give a plan to (the plan-owner list comes from the all-staff endpoint).
  const recipients = data.staff.filter((s) => canEditFor(s));

  return (
    <div>
      {flash && (
        <p role="status" className="mb-3 rounded-lg border px-3 py-2 text-[13px]"
          style={{ background: "var(--color-success-surface)", color: "var(--color-success-text)", borderColor: "var(--color-success-border)" }}>
          {flash}
        </p>
      )}
      <div className="space-y-4">
        {data.staff.map((s) => {
          const live = s.plans.filter((p) => ["ACTIVE", "UPCOMING"].includes(planState(p, today)));
          const old = s.plans.filter((p) => !["ACTIVE", "UPCOMING"].includes(planState(p, today)));
          const editable = canEditFor(s);
          return (
            <section key={s.id} className="rounded-xl border border-app-border bg-surface" aria-label={`${s.name} pay plans`}>
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-4 sm:px-5">
                <div className="min-w-0">
                  {staffId ? (
                    <h2 className="text-[15px] font-semibold text-text-primary">Pay plans</h2>
                  ) : (
                    <h2 className="text-[15px] font-semibold text-text-primary">
                      <Link href={`/dashboard/staff/${s.id}?tab=pay`} className="hover:underline">{s.name}</Link>
                      {s.title && <span className="ml-2 text-[13px] font-normal text-text-muted">{s.title}</span>}
                    </h2>
                  )}
                  {!s.hasSchedule && live.length > 0 && (
                    <p className="mt-0.5 text-[12.5px] text-text-muted">
                      No pay schedule yet — class pay still builds up; <Link href={`/dashboard/staff/${s.id}?tab=pay`} className="text-brand hover:underline">set one</Link> for payday reminders.
                    </p>
                  )}
                </div>
                {editable && (
                  <button type="button" onClick={() => { setError(null); setEditing({ staff: s, plan: null }); }} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
                    <Plus className="h-4 w-4" aria-hidden /> Add pay plan
                  </button>
                )}
              </div>

              {s.warnings.map((w) => (
                <p key={w} className="mx-4 mb-2 rounded-lg border px-3 py-2 text-[13px] sm:mx-5"
                  style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)", borderColor: "var(--color-warn-border)" }}>
                  {w}
                </p>
              ))}

              {live.length === 0 ? (
                <p className="px-4 pb-4 text-[13px] text-text-muted sm:px-5">
                  No pay plan in force. {editable ? "Class days they work will show as “needs review” on Payroll until one is added." : ""}
                </p>
              ) : (
                <ul className="divide-y divide-app-border border-t border-app-border">
                  {live.map((p) => <PlanRow key={p.id} plan={p} today={today} names={names} editable={editable}
                    onEdit={() => { setError(null); setEditing({ staff: s, plan: p }); }} onCopy={() => openCopy(s, p)} onRemove={() => { setError(null); setRemoving({ staff: s, plan: p }); }}
                    canCopy={viewer.canEdit} />)}
                </ul>
              )}

              {old.length > 0 && (
                <div className="border-t border-app-border px-4 py-2 sm:px-5">
                  <button type="button" onClick={() => setShowOld((m) => ({ ...m, [s.id]: !m[s.id] }))}
                    className="inline-flex min-h-[44px] items-center text-[13px] text-brand hover:underline md:min-h-[32px]">
                    {showOld[s.id] ? "Hide" : "Show"} ended and removed plans ({old.length})
                  </button>
                  {showOld[s.id] && (
                    <ul className="divide-y divide-app-border">
                      {old.map((p) => <PlanRow key={p.id} plan={p} today={today} names={names} editable={editable && !p.archived}
                        onEdit={() => { setError(null); setEditing({ staff: s, plan: p }); }} onCopy={() => openCopy(s, p)} onRemove={() => { setError(null); setRemoving({ staff: s, plan: p }); }}
                        canCopy={viewer.canEdit} flush />)}
                    </ul>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {editing && (
        <PlanEditorSheet open staffId={editing.staff.id} staffName={editing.staff.name} plan={editing.plan} options={options}
          onClose={() => setEditing(null)} onSaved={done} />
      )}

      <Sheet
        open={!!copying}
        onClose={() => (busy ? undefined : setCopying(null))}
        title="Copy this pay plan"
        description={copying ? <>“{copying.plan.name}” from {copying.staff.name}. Each copy is a separate plan — changing one later never changes the other.</> : undefined}
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setCopying(null)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`}>Cancel</button>
            <button type="button" disabled={busy} onClick={doCopy} className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}>{busy ? "Copying…" : "Copy plan"}</button>
          </>
        }
      >
        {copying && (
          <div className="space-y-4 pt-1">
            <fieldset>
              <legend className="mb-1 text-[13px] font-medium text-text-primary">Copy to</legend>
              <CopyRecipients staffId={staffId} fallback={recipients} sourceId={copying.staff.id} viewer={viewer} value={copyTo} onChange={setCopyTo} />
            </fieldset>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Name of the copy</span>
              <input className={input} value={copyName} maxLength={80} onChange={(e) => setCopyName(e.target.value)} />
            </label>
            <label className="block max-w-[220px]">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">The copy starts</span>
              <input type="date" className={input} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} />
            </label>
            {error && <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>{error}</p>}
          </div>
        )}
      </Sheet>

      <Sheet
        open={!!removing}
        onClose={() => (busy ? undefined : setRemoving(null))}
        title="Remove this pay plan?"
        description={removing ? <>“{removing.plan.name}” for {removing.staff.name}.</> : undefined}
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setRemoving(null)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`}>Keep it</button>
            <button type="button" disabled={busy} onClick={doRemove} className={`${btn} text-white hover:opacity-90 disabled:opacity-50`} style={{ background: "var(--color-danger-text)" }}>
              {busy ? "Removing…" : "Remove plan"}
            </button>
          </>
        }
      >
        <div className="space-y-2 pt-1 text-[13px] text-text-primary">
          <p>It stops paying anything that hasn&apos;t been paid yet. Unpaid class days it covered will show as “needs review” unless another plan covers them.</p>
          <p className="text-text-muted">Lines already paid keep this plan&apos;s name and never change. To stop a plan from a date instead, edit it and set an end date.</p>
          {error && <p role="alert" style={{ color: "var(--color-danger-text)" }}>{error}</p>}
        </div>
      </Sheet>
    </div>
  );
}

function PlanRow({
  plan, today, names, editable, canCopy, onEdit, onCopy, onRemove, flush,
}: {
  plan: LedgerPlan; today: string; names: ScopeNames; editable: boolean; canCopy: boolean;
  onEdit: () => void; onCopy: () => void; onRemove: () => void; flush?: boolean;
}) {
  const state = planState(plan, today);
  const lines = planSummaryLines(plan, names);
  const icon = "inline-flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-app-bg hover:text-text-primary md:h-9 md:w-9";
  return (
    <li className={`flex flex-wrap items-start gap-x-3 gap-y-1 py-3 ${flush ? "" : "px-4 sm:px-5"}`}>
      <div className="min-w-0 flex-1 basis-[240px]">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-text-primary">
          <span className="min-w-0 break-words">{plan.name}</span>
          <span className="rounded-full border border-app-border bg-app-bg px-2 py-0.5 text-[12px] font-normal text-text-muted">{STATE_WORDS[state]}</span>
        </p>
        <ul className="mt-1 space-y-0.5">
          {lines.map((l) => <li key={l} className="text-[13px] text-text-primary">{l}</li>)}
        </ul>
        <p className="mt-1 text-[12.5px] text-text-muted">
          From {fmtYmdYear(plan.effectiveFrom)}{plan.effectiveTo ? ` to ${fmtYmdYear(plan.effectiveTo)}` : ""}
          {plan.copiedFromId ? " · started as a copy" : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        {editable && <button type="button" onClick={onEdit} aria-label={`Edit ${plan.name}`} title="Edit" className={icon}><Pencil className="h-4 w-4" aria-hidden /></button>}
        {canCopy && <button type="button" onClick={onCopy} aria-label={`Copy ${plan.name} to another coach`} title="Copy to another coach" className={icon}><Copy className="h-4 w-4" aria-hidden /></button>}
        {editable && <button type="button" onClick={onRemove} aria-label={`Remove ${plan.name}`} title="Remove" className={icon}><Trash2 className="h-4 w-4" aria-hidden /></button>}
      </div>
    </li>
  );
}

/** Who a plan can be copied to. On a profile's Pay tab the panel only knows one person, so the full list is fetched here. */
function CopyRecipients({
  staffId, fallback, sourceId, viewer, value, onChange,
}: {
  staffId?: string;
  fallback: { id: string; name: string }[];
  sourceId: string;
  viewer: { userId: string; isOwner: boolean };
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [all, setAll] = useState<{ id: string; name: string }[] | null>(staffId ? null : fallback);
  useEffect(() => {
    if (!staffId) return;
    let live = true;
    fetch("/api/payroll/plans", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live) return;
        const list = (d?.staff ?? []) as { id: string; name: string }[];
        setAll(list.filter((s) => viewer.isOwner || s.id !== viewer.userId));
      });
    return () => {
      live = false;
    };
  }, [staffId, viewer.isOwner, viewer.userId]);
  if (!all) return <p className="text-[13px] text-text-muted">Loading staff…</p>;
  if (all.length === 0) return <p className="text-[13px] text-text-muted">There is nobody you can copy this to.</p>;
  return (
    <ul className="max-h-56 space-y-1 overflow-y-auto">
      {all.map((s) => {
        const on = value.includes(s.id);
        return (
          <li key={s.id}>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg px-2 hover:bg-app-bg md:min-h-[36px]">
              <input type="checkbox" className="h-4 w-4" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== s.id) : [...value, s.id])} />
              <span className="text-[14px] text-text-primary">
                {s.name}
                {s.id === sourceId && <span className="text-text-muted"> — as a new plan for the same person</span>}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
