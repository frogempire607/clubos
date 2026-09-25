"use client";

// B3 slice 2 — Settings → Billing: the sibling membership discount.
// New purchases get it automatically; running memberships are listed under
// "To review" and applied one by one through Change plan.

import { useEffect, useState } from "react";
import Link from "next/link";
import { AmountInput } from "@/components/events/AutoDiscountsEditor";
import { ordinalWord } from "@/lib/eventAutoDiscounts";
import type { MembershipSiblingConfig } from "@/lib/membershipSiblingDiscount";

type Review = { memberId: string; name: string; subId: string; drift: "DOWN" | "UP" | null; label: string | null; price: number; expected: number | null };

const chip = (on: boolean) =>
  `text-xs px-2.5 py-1.5 rounded-lg border ${on ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`;
const money = (n: number) => `$${n.toFixed(2)}`;

export default function SiblingDiscountCard() {
  const [cfg, setCfg] = useState<MembershipSiblingConfig | null>(null);
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [review, setReview] = useState<Review[]>([]);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = () =>
    fetch("/api/club/sibling-discount")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setCfg(d.config);
        setPlans(d.plans ?? []);
        setReview(d.review ?? []);
        setSummary(d.summary ?? "");
      });
  useEffect(() => { load(); }, []);

  if (!cfg) return null;
  const set = (p: Partial<MembershipSiblingConfig>) => { setCfg({ ...cfg, ...p }); setMsg(""); setErr(""); };
  const tiers = cfg.tiers?.length ? cfg.tiers : [{ type: "FIXED" as const, value: 0 }];

  async function save() {
    setBusy(true); setErr(""); setMsg("");
    const res = await fetch("/api/club/sibling-discount", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Couldn't save."); return; }
    setMsg("Saved. New memberships use it from now on; nothing already running changed.");
    load();
  }

  return (
    <div id="sibling-discount" className="mt-6 bg-surface border border-app-border rounded-xl p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Sibling membership discount</h3>
        <p className="text-xs text-text-muted mt-0.5">
          One parent paying for more than one athlete. New memberships get it automatically at checkout (and when you
          assign one). Memberships already running are never repriced on their own — they show up below for you to apply.
        </p>
        <p className="text-xs text-text-primary mt-1">Now: {summary}</p>
      </div>

      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={cfg.on} onChange={(e) => set({ on: e.target.checked })} />
        Turn on the sibling membership discount
      </label>

      {cfg.on && (
        <>
          <div className="flex gap-1.5 flex-wrap">
            <button type="button" onClick={() => set({ shape: "EACH_ADDITIONAL" })} className={chip(cfg.shape === "EACH_ADDITIONAL")}>Same for every extra athlete</button>
            <button type="button" onClick={() => set({ shape: "LADDER", tiers })} className={chip(cfg.shape === "LADDER")}>Different for 2nd, 3rd…</button>
          </div>
          {cfg.shape === "EACH_ADDITIONAL" ? (
            <div>
              <span className="block text-xs font-medium text-text-primary mb-1">Each athlete after the first gets</span>
              <AmountInput value={cfg.each} onChange={(each) => set({ each })} />
            </div>
          ) : (
            <div className="space-y-1.5">
              {tiers.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-text-primary w-24 shrink-0">{ordinalWord(i + 2)}{i === tiers.length - 1 ? " & on" : ""} athlete</span>
                  <AmountInput value={t} onChange={(nt) => set({ tiers: tiers.map((x, j) => (j === i ? nt : x)) })} />
                  {tiers.length > 1 && (
                    <button type="button" onClick={() => set({ tiers: tiers.filter((_, j) => j !== i) })} className="text-[11px] text-text-muted hover:text-red-600">Remove</button>
                  )}
                </div>
              ))}
              {tiers.length < 6 && (
                <button type="button" onClick={() => set({ tiers: [...tiers, { ...tiers[tiers.length - 1] }] })} className="text-[11px] text-brand">+ Add the {ordinalWord(tiers.length + 2)} athlete</button>
              )}
            </div>
          )}
          <div>
            <span className="block text-xs font-medium text-text-primary mb-1">Who gets the discount</span>
            <div className="flex gap-1.5 flex-wrap">
              <button type="button" onClick={() => set({ discountWhich: "CHEAPER" })} className={chip(cfg.discountWhich === "CHEAPER")}>The cheaper memberships</button>
              <button type="button" onClick={() => set({ discountWhich: "PRICIER" })} className={chip(cfg.discountWhich === "PRICIER")}>The pricier memberships</button>
            </div>
            <p className="text-[11px] text-text-muted mt-1">
              {cfg.discountWhich === "CHEAPER"
                ? "The priciest membership in the family pays full price."
                : "The cheapest membership in the family pays full price."}{" "}
              Compared per month, so monthly and quarterly plans line up. Comps and $0 memberships don&apos;t count.
            </p>
          </div>
          {plans.length > 0 && (
            <div>
              <span className="block text-xs font-medium text-text-primary mb-1">Plans it covers (none ticked = all)</span>
              <div className="flex gap-1.5 flex-wrap">
                {plans.map((p) => {
                  const on = cfg.membershipIds.includes(p.id);
                  return (
                    <button key={p.id} type="button" onClick={() => set({ membershipIds: on ? cfg.membershipIds.filter((x) => x !== p.id) : [...cfg.membershipIds, p.id] })} className={chip(on)}>
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {err && <p className="text-xs text-red-700">{err}</p>}
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      <button onClick={save} disabled={busy} className="text-sm px-4 py-2 rounded-lg text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
        {busy ? "Saving…" : "Save"}
      </button>

      {review.length > 0 && (
        <div className="pt-3 border-t border-app-border">
          <h4 className="text-xs font-semibold text-text-primary mb-1.5">Membership discounts to review — sibling and group rates ({review.length})</h4>
          <div className="space-y-1">
            {review.map((r) => (
              <div key={r.subId} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-text-primary">
                  <strong>{r.name}</strong> —{" "}
                  {r.drift === "DOWN"
                    ? `${r.label}: ${money(r.price)} → ${money(r.expected ?? r.price)}`
                    : `carries a discount it no longer earns (${money(r.price)}; would be ${money(r.expected ?? r.price)})`}
                </span>
                <Link href={`/dashboard/members/${r.memberId}`} className="text-brand hover:underline shrink-0">Open profile →</Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
