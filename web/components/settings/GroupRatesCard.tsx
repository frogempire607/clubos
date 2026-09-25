"use client";

// B3 slice 3 — Settings → Billing: membership group rates. The club names
// each one (a team, a school, a bus route…), sets how many athletes it takes
// and the amount. Athletes' answers are set on their profile (or by the
// family in the portal). New memberships get the rate at checkout; running
// ones are listed under "to review" on the sibling card and applied by hand.

import { useEffect, useState } from "react";
import { AmountInput } from "@/components/events/AutoDiscountsEditor";
import type { GroupRate } from "@/lib/membershipGroupRates";

const chip = (on: boolean) =>
  `text-xs px-2.5 py-1.5 rounded-lg border ${on ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`;
const input = "w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary";

type Draft = Omit<GroupRate, "id"> & { id?: string; optionsText: string };

export default function GroupRatesCard() {
  const [rates, setRates] = useState<Draft[] | null>(null);
  const [answered, setAnswered] = useState<Record<string, number>>({});
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = () =>
    Promise.all([
      fetch("/api/club/group-rates").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/club/sibling-discount").then((r) => (r.ok ? r.json() : null)),
    ]).then(([g, s]) => {
      if (g) { setRates((g.rates as GroupRate[]).map((r) => ({ ...r, optionsText: r.options.join("\n") }))); setAnswered(g.answered ?? {}); }
      if (s) setPlans(s.plans ?? []);
    });
  useEffect(() => { load(); }, []);
  if (!rates) return null;

  const set = (i: number, p: Partial<Draft>) => { setRates(rates.map((r, j) => (j === i ? { ...r, ...p } : r))); setMsg(""); setErr(""); };
  async function save() {
    setBusy(true); setErr(""); setMsg("");
    const res = await fetch("/api/club/group-rates", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rates: rates!.map(({ optionsText, ...r }) => ({ ...r, options: optionsText.split("\n").map((x) => x.trim()).filter(Boolean) })) }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(d.error || "Couldn't save."); return; }
    setMsg("Saved. New memberships use these from now on; nothing already running changed.");
    load();
  }

  return (
    <div id="group-rates" className="mt-6 bg-surface border border-app-border rounded-xl p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Membership group rates</h3>
        <p className="text-xs text-text-muted mt-0.5">
          A lower rate for athletes who share something — you name it: a team, a school, a club, a bus route. Add as many
          as you need. Set each athlete&apos;s answer on their profile (families can answer in the portal too). Once enough
          athletes with the same answer are on a paid membership, each of them earns the rate. One discount per membership:
          sibling, group or code — whichever saves more.
        </p>
      </div>

      {rates.length === 0 && <p className="text-xs text-text-muted">No group rates yet.</p>}
      {rates.map((r, i) => (
        <div key={r.id ?? `new-${i}`} className="rounded-xl border border-app-border p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} /> On
            </label>
            <button type="button" onClick={() => setRates(rates.filter((_, j) => j !== i))} className="text-[11px] text-text-muted hover:text-red-600">Remove</button>
          </div>
          <label className="block">
            <span className="block text-xs font-medium text-text-primary mb-1">What they share (the question on the profile)</span>
            <input value={r.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} placeholder="e.g. Team, School, Bus route" className={input} />
          </label>
          <div className="grid grid-cols-[120px_1fr] gap-2 items-end">
            <label className="block">
              <span className="block text-xs font-medium text-text-primary mb-1">How many</span>
              <input inputMode="numeric" value={r.threshold ? String(r.threshold) : ""} onChange={(e) => set(i, { threshold: parseInt(e.target.value.replace(/[^0-9]/g, ""), 10) || 0 })} placeholder="3" className={input} />
            </label>
            <div>
              <span className="block text-xs font-medium text-text-primary mb-1">Each of them gets</span>
              <AmountInput value={r.amount} onChange={(amount) => set(i, { amount })} />
            </div>
          </div>
          <label className="block">
            <span className="block text-xs font-medium text-text-primary mb-1">Pick-list (optional, one per line)</span>
            <textarea rows={2} value={r.optionsText} onChange={(e) => set(i, { optionsText: e.target.value })} className={input} />
            <span className="block text-[11px] text-text-muted mt-1">A list keeps spellings together. Blank = typed (case and spacing don&apos;t matter).</span>
          </label>
          {plans.length > 0 && (
            <div>
              <span className="block text-xs font-medium text-text-primary mb-1">Plans it covers (none ticked = all)</span>
              <div className="flex gap-1.5 flex-wrap">
                {plans.map((p) => {
                  const on = r.membershipIds.includes(p.id);
                  return <button key={p.id} type="button" onClick={() => set(i, { membershipIds: on ? r.membershipIds.filter((x) => x !== p.id) : [...r.membershipIds, p.id] })} className={chip(on)}>{p.name}</button>;
                })}
              </div>
            </div>
          )}
          {r.id && <p className="text-[11px] text-text-muted">{answered[r.id] ?? 0} athlete{answered[r.id] === 1 ? "" : "s"} answered so far.</p>}
        </div>
      ))}
      <button type="button" onClick={() => setRates([...rates, { on: true, label: "", threshold: 3, amount: { type: "PERCENT", value: 10 }, options: [], membershipIds: [], optionsText: "" }])} className="text-[12.5px] font-medium text-brand">+ Add a group rate</button>

      {err && <p className="text-xs text-red-700">{err}</p>}
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      <div>
        <button onClick={save} disabled={busy} className="text-sm px-4 py-2 rounded-lg text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>{busy ? "Saving…" : "Save group rates"}</button>
      </div>
    </div>
  );
}
