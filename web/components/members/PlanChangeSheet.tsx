"use client";

// B12/B13 "Change plan" for one live membership — moved out of the retired
// "Advanced billing" page (2026-09-28) so its deep links (`?changePlan=<sub>`
// and `&option=<id>`, used by the Membership panel, the sibling-discount nudge
// and the bulk price tool) keep working: /billing now redirects them to the
// profile's Memberships tab, which opens this.
//
// The sheet never does its own math: every sentence comes from
// GET …/billing-admin/plan-change (Stripe's live period end) and the commit
// recomputes it server-side.

import { useEffect, useMemo, useState } from "react";
import Sheet from "@/components/Sheet";

type Sub = { id: string; optionId: string | null; optionLabel: string; price: number; billingPeriod: string | null; status: string; hasStripe: boolean };
type Plan = { id: string; name: string; contractMonths: number | null; options: { id: string | null; label: string; price: number; billingPeriod: string; contractMonths: number | null }[] };
type Admin = { member: { firstName: string }; subscriptions: Sub[]; plans: Plan[] };

type Preview = {
  kind: "SAME_INTERVAL" | "SWITCH" | "OFFLINE";
  current: { optionLabel: string; price: number; chargedTotal: number; cancelAt: string | null; minimumTermEndsAt: string | null; autoRenew: boolean };
  target: { planName: string; optionLabel: string; price: number; billingPeriod: string; fee: number; total: number; contractMonths: number | null };
  effectiveAt: string; autoRenew: boolean; minimumTermEndsAt: string | null; cancelAt: string | null; sameAmount: boolean; lines: string[];
};

const money = (n: number) => `$${n.toFixed(2)}`;
const dayUTC = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
const periodWord = (p: string | null) => (p ? p.toLowerCase().replace("_", "-") : "");

export default function PlanChangeSheet({
  memberId,
  subscriptionId,
  initialOptionId,
  onClose,
  onDone,
}: {
  memberId: string;
  subscriptionId: string;
  initialOptionId?: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/members/${memberId}/billing-admin`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(r.status === 403 ? "You don't have billing access." : "Couldn't load this membership.")))
      .then((d) => setAdmin(d as Admin))
      .catch((e) => setLoadError(typeof e === "string" ? e : "Couldn't load this membership."));
  }, [memberId]);

  const sub = admin?.subscriptions.find((s) => s.id === subscriptionId && (s.status === "active" || s.status === "past_due")) ?? null;
  const choices = useMemo(() => {
    const out: { id: string; label: string; planName: string; price: number; billingPeriod: string; contractMonths: number | null; sameInterval: boolean; isCurrent: boolean }[] = [];
    for (const p of admin?.plans ?? []) {
      for (const o of p.options) {
        if (!o.id || o.billingPeriod === "ONE_TIME" || (sub?.hasStripe && o.price <= 0)) continue;
        out.push({
          id: o.id, label: o.label, planName: p.name, price: o.price, billingPeriod: o.billingPeriod,
          contractMonths: o.contractMonths ?? p.contractMonths ?? null,
          sameInterval: !!sub && o.billingPeriod === sub.billingPeriod,
          isCurrent: !!sub && o.id === sub.optionId,
        });
      }
    }
    return out.sort((a, b) => Number(b.sameInterval) - Number(a.sameInterval) || a.planName.localeCompare(b.planName) || a.price - b.price);
  }, [admin, sub]);

  const [optionId, setOptionId] = useState<string>(initialOptionId ?? "");
  const [autoRenew, setAutoRenew] = useState<"default" | "on" | "off">("default");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ack, setAck] = useState(false);

  useEffect(() => {
    if (!optionId) { setPreview(null); return; }
    let alive = true;
    setLoading(true); setError(""); setPreview(null); setAck(false);
    const qs = new URLSearchParams({ subscriptionId, optionId });
    if (autoRenew !== "default") qs.set("autoRenew", autoRenew === "on" ? "true" : "false");
    fetch(`/api/members/${memberId}/billing-admin/plan-change?${qs.toString()}`)
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!alive) return; if (!r.ok) setError(typeof d.error === "string" ? d.error : "Couldn't preview."); else setPreview(d as Preview); })
      .catch(() => alive && setError("Couldn't reach the server."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [optionId, autoRenew, subscriptionId, memberId]);

  async function commit() {
    if (!optionId || !preview) return;
    setBusy(true); setError("");
    const r = await fetch(`/api/members/${memberId}/billing-admin/actions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "change_plan", confirm: true, subscriptionId, optionId, expectedKind: preview.kind, ...(autoRenew === "default" ? {} : { autoRenew: autoRenew === "on" }) }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(typeof d.error === "string" ? d.error : "Could not change the plan."); return; }
    onDone(typeof d.message === "string" ? d.message : "Plan changed.");
  }

  const first = admin?.member.firstName ?? "This member";
  return (
    <Sheet
      open
      onClose={() => { if (!busy) onClose(); }}
      title="Change plan"
      width={560}
      description={
        !sub ? undefined : sub.hasStripe
          ? <>{first} is on <strong>{sub.optionLabel}</strong> · {money(sub.price)} {periodWord(sub.billingPeriod)} in Stripe. Nothing is charged or refunded today.</>
          : <>{first} is on <strong>{sub.optionLabel}</strong> · {money(sub.price)} {periodWord(sub.billingPeriod)}, billed offline. The new option starts from the next payment.</>
      }
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-4 text-sm text-text-primary hover:bg-app-bg">Cancel</button>
          <button type="button" onClick={commit} disabled={busy || !preview || !ack} className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover disabled:opacity-50">
            {busy ? "Applying…" : preview?.kind === "SWITCH" ? "Switch plan" : "Change plan"}
          </button>
        </>
      }
    >
      {loadError ? (
        <p className="text-sm text-text-muted">{loadError}</p>
      ) : !admin ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : !sub ? (
        <p className="text-sm text-text-muted">That membership isn&apos;t active any more, so there is no plan to change. Use the Membership panel to assign one.</p>
      ) : (
        <div className="space-y-3">
          {error && <p className="rounded-lg bg-red-600 px-2.5 py-2 text-xs text-white">{error}</p>}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-primary">Move to</span>
            <select value={optionId} onChange={(e) => setOptionId(e.target.value)} className="min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-sm text-text-primary md:min-h-0">
              <option value="">Pick an option…</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id} disabled={c.isCurrent}>
                  {c.planName} · {c.label} — {money(c.price)} {periodWord(c.billingPeriod)}{c.contractMonths ? `, ${c.contractMonths}-mo commitment` : ""}
                  {c.isCurrent ? " (current)" : !c.sameInterval && sub.hasStripe ? " — switches at period end" : ""}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-text-muted">
              {sub.hasStripe
                ? `Options billed ${periodWord(sub.billingPeriod)} swap in place at the next invoice. A different cycle ends this subscription at its period end and starts the new one that day on the same card.`
                : "Paid-through stays as it is; the next payment is at the new price."}
            </span>
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-text-primary">After the commitment</span>
            <div className="flex flex-wrap gap-1.5">
              {([["default", "Option default"], ["off", "Ends — no renewal"], ["on", "Keeps renewing"]] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setAutoRenew(v)}
                  className={`inline-flex min-h-[44px] items-center rounded-lg border px-3 text-xs md:min-h-[32px] ${autoRenew === v ? "border-brand bg-brand/10 font-medium text-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {loading && <p className="text-xs text-text-muted">Checking with Stripe…</p>}
          {preview && (
            <div className="space-y-1 rounded-lg bg-app-bg px-3 py-2.5 text-sm text-text-primary">
              <p>
                {preview.kind === "SWITCH" ? "Switch to " : ""}<strong>{preview.target.planName} · {preview.target.optionLabel}</strong>
                {preview.kind === "OFFLINE" ? " from the next payment, " : " from "}<strong>{dayUTC(preview.effectiveAt)}</strong>.
              </p>
              {preview.lines.map((l, i) => <p key={i} className={i === 0 ? "" : "text-text-muted"}>{l}</p>)}
              {preview.kind !== "SWITCH" && preview.current.cancelAt && !preview.cancelAt && (
                <p className="text-text-muted">The old end date ({dayUTC(preview.current.cancelAt)}) is removed.</p>
              )}
            </div>
          )}
          {preview && (
            <label className="flex min-h-[44px] items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-5 w-5" />
              <span>
                {preview.kind === "SWITCH"
                  ? `End the current Stripe subscription on ${dayUTC(preview.effectiveAt)} and start the new one that day on the same card.`
                  : preview.kind === "OFFLINE"
                    ? `Change ${first}'s membership. Nothing is charged.`
                    : `Apply this to ${first}'s Stripe subscription.`}{" "}
                {first} isn&apos;t emailed — tell the family yourself.
              </span>
            </label>
          )}
        </div>
      )}
    </Sheet>
  );
}
