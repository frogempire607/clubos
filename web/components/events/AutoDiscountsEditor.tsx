"use client";

// B3 slice 1 — the event editor's Discounts card body: sibling discount and
// group rate, both applied automatically at signup. Controlled; the parent
// sends `value` as Event.autoDiscounts and the server validates it.

import {
  autoDiscountSummary,
  ordinalWord,
  type AmountRule,
  type AutoDiscounts,
} from "@/lib/eventAutoDiscounts";

const input = "w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary min-h-[44px] md:min-h-0";
const chip = (on: boolean) =>
  `text-xs px-2.5 py-1.5 rounded-lg border ${on ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`;

function AmountInput({ value, onChange }: { value: AmountRule | undefined; onChange: (v: AmountRule) => void }) {
  const v = value ?? { type: "FIXED" as const, value: 0 };
  return (
    <div className="flex gap-1.5 items-center">
      <button type="button" onClick={() => onChange({ ...v, type: "FIXED" })} className={chip(v.type === "FIXED")}>$ off</button>
      <button type="button" onClick={() => onChange({ ...v, type: "PERCENT" })} className={chip(v.type === "PERCENT")}>% off</button>
      <input
        inputMode="decimal"
        value={v.value ? String(v.value) : ""}
        onChange={(e) => onChange({ ...v, value: parseFloat(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
        placeholder={v.type === "PERCENT" ? "10" : "15"}
        className={`${input} max-w-[110px]`}
      />
    </div>
  );
}

export function autoDiscountsLine(v: AutoDiscounts): string {
  const lines = autoDiscountSummary(v);
  return lines.length ? lines.map((l) => l.split(":")[0]).join(" · ") + " on" : "None";
}

export default function AutoDiscountsEditor({
  value,
  onChange,
}: {
  value: AutoDiscounts;
  onChange: (v: AutoDiscounts) => void;
}) {
  const sib = value.sibling ?? { on: false, shape: "EACH_ADDITIONAL" as const };
  const grp = value.group ?? { on: false, label: "School", threshold: 3, amount: { type: "PERCENT" as const, value: 10 }, options: [] };
  const setSib = (p: Partial<typeof sib>) => onChange({ ...value, sibling: { ...sib, ...p } });
  const setGrp = (p: Partial<typeof grp>) => onChange({ ...value, group: { ...grp, ...p } });
  const tiers = sib.tiers?.length ? sib.tiers : [{ type: "FIXED" as const, value: 0 }];
  const lines = autoDiscountSummary(value);

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-muted">
        Applied automatically when someone registers — no code to type. One discount per registration: if a family
        also types a code, whichever saves them more is used. Only unpaid prices are ever lowered; nothing is refunded
        on its own.
      </p>

      <div className="rounded-xl border border-app-border p-3 space-y-2.5">
        <label className="flex items-start gap-2.5">
          <input type="checkbox" checked={sib.on} onChange={(e) => setSib({ on: e.target.checked })} className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium text-text-primary">Sibling discount</span>
            <span className="block text-[11px] text-text-muted">
              The same family registering more than one athlete (same email, or kids on the same parent&apos;s
              account). The first athlete pays the price.
            </span>
          </span>
        </label>
        {sib.on && (
          <>
            <div className="flex gap-1.5 flex-wrap">
              <button type="button" onClick={() => setSib({ shape: "EACH_ADDITIONAL" })} className={chip(sib.shape === "EACH_ADDITIONAL")}>Same for every extra athlete</button>
              <button type="button" onClick={() => setSib({ shape: "LADDER", tiers })} className={chip(sib.shape === "LADDER")}>Different for 2nd, 3rd…</button>
            </div>
            {sib.shape === "EACH_ADDITIONAL" ? (
              <div>
                <span className="block text-xs font-medium text-text-primary mb-1">Each athlete after the first gets</span>
                <AmountInput value={sib.each} onChange={(each) => setSib({ each })} />
              </div>
            ) : (
              <div className="space-y-1.5">
                {tiers.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-text-primary w-24 shrink-0">
                      {ordinalWord(i + 2)}{i === tiers.length - 1 ? " & on" : ""} athlete
                    </span>
                    <AmountInput value={t} onChange={(nt) => setSib({ tiers: tiers.map((x, j) => (j === i ? nt : x)) })} />
                    {tiers.length > 1 && (
                      <button type="button" onClick={() => setSib({ tiers: tiers.filter((_, j) => j !== i) })} className="text-[11px] text-text-muted hover:text-red-600">Remove</button>
                    )}
                  </div>
                ))}
                {tiers.length < 6 && (
                  <button type="button" onClick={() => setSib({ tiers: [...tiers, { ...tiers[tiers.length - 1] }] })} className="text-[11px] text-brand">+ Add the {ordinalWord(tiers.length + 2)} athlete</button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="rounded-xl border border-app-border p-3 space-y-2.5">
        <label className="flex items-start gap-2.5">
          <input type="checkbox" checked={grp.on} onChange={(e) => setGrp({ on: e.target.checked })} className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium text-text-primary">Group rate</span>
            <span className="block text-[11px] text-text-muted">
              Athletes who share something — a school, a team. The form asks for it; once enough of them register,
              every one of them gets the rate (unpaid registrations already in are lowered too).
            </span>
          </span>
        </label>
        {grp.on && (
          <>
            <label className="block">
              <span className="block text-xs font-medium text-text-primary mb-1">What they share (the question families see)</span>
              <input value={grp.label} maxLength={40} onChange={(e) => setGrp({ label: e.target.value })} placeholder="School" className={input} />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-text-primary mb-1">How many before the rate starts</span>
              <input
                inputMode="numeric"
                value={grp.threshold ? String(grp.threshold) : ""}
                onChange={(e) => setGrp({ threshold: parseInt(e.target.value.replace(/[^0-9]/g, ""), 10) || 0 })}
                placeholder="3"
                className={`${input} max-w-[110px]`}
              />
            </label>
            <div>
              <span className="block text-xs font-medium text-text-primary mb-1">Each of them gets</span>
              <AmountInput value={grp.amount} onChange={(amount) => setGrp({ amount })} />
            </div>
            <label className="block">
              <span className="block text-xs font-medium text-text-primary mb-1">Pick-list (optional, one per line)</span>
              <textarea
                rows={3}
                value={grp.options.join("\n")}
                onChange={(e) => setGrp({ options: e.target.value.split("\n") })}
                placeholder={"Lincoln High\nWest Middle"}
                className={input}
              />
              <span className="block text-[11px] text-text-muted mt-1">
                A list keeps spellings together. Blank = families type it (case and spacing don&apos;t matter).
              </span>
            </label>
          </>
        )}
      </div>

      {lines.length > 0 && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800 space-y-0.5">
          <p className="font-medium">Families will see:</p>
          {lines.map((l) => <p key={l}>{l}</p>)}
        </div>
      )}
    </div>
  );
}
