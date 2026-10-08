"use client";

// Private lesson pay (Branch 3): what this coach is paid for each kind of
// private lesson — a flat amount per lesson, or a percentage of what the family
// paid. A finished lesson becomes a pay line from this; a lesson type with
// nothing set becomes a "needs review" line on Payroll, never a guess.
// Read-only for the coach themself and for anyone without Financials: full —
// the server refuses either way.
import { useCallback, useEffect, useState } from "react";

type Rate = { lessonTypeId: string; payType: "FLAT" | "PERCENT"; payValue: number };
type LessonType = { id: string; title: string; basePrice: number; active: boolean };
type Payload = { rates: Rate[]; lessonTypes: LessonType[]; viewer: { canEdit: boolean } };
type Draft = { payType: "NONE" | "FLAT" | "PERCENT"; value: string };

const field = "min-h-[44px] rounded-lg border border-app-border bg-surface px-2.5 text-[14px] text-text-primary md:min-h-[36px] md:text-[13px] disabled:opacity-60";
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";

function draftOf(r: Rate | undefined): Draft {
  return r ? { payType: r.payType, value: String(r.payValue) } : { payType: "NONE", value: "" };
}
export function rateSummary(r: Rate | undefined, basePrice: number): string {
  if (!r) return "Not set — lessons will need review";
  if (r.payType === "FLAT") return `$${r.payValue.toFixed(2)} per lesson`;
  const eg = basePrice > 0 ? ` (about $${((basePrice * r.payValue) / 100).toFixed(2)} on a $${basePrice.toFixed(2)} lesson)` : "";
  return `${r.payValue}% of what the family paid${eg}`;
}

export default function PrivateLessonPayCard({ staffId, first, isSelf, onChanged }: { staffId: string; first: string; isSelf: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/${staffId}/pay-rates`, { cache: "no-store" });
    if (!r.ok) return setMsg({ kind: "err", text: "Couldn't load private lesson pay." });
    const d: Payload = await r.json();
    setData(d);
    setDrafts(Object.fromEntries(d.lessonTypes.map((t) => [t.id, draftOf(d.rates.find((x) => x.lessonTypeId === t.id))])));
  }, [staffId]);
  useEffect(() => { load(); }, [load]);

  async function save(t: LessonType) {
    const d = drafts[t.id];
    if (!d) return;
    setMsg(null);
    let res: Response;
    if (d.payType === "NONE") {
      setBusy(t.id);
      res = await fetch(`/api/staff/${staffId}/pay-rates?lessonTypeId=${encodeURIComponent(t.id)}`, { method: "DELETE" });
    } else {
      const n = Number(d.value);
      if (d.value.trim() === "" || !Number.isFinite(n) || n < 0) return setMsg({ kind: "err", text: `Enter an amount for ${t.title}.` });
      if (d.payType === "PERCENT" && n > 100) return setMsg({ kind: "err", text: "A percentage can't be more than 100." });
      setBusy(t.id);
      res = await fetch(`/api/staff/${staffId}/pay-rates`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonTypeId: t.id, payType: d.payType, payValue: n }),
      });
    }
    setBusy(null);
    if (!res.ok && res.status !== 404) {
      const e = await res.json().catch(() => ({}));
      return setMsg({ kind: "err", text: e.error || "That didn't save. Try again." });
    }
    await load();
    setMsg({ kind: "ok", text: `Saved — ${t.title}. Lessons not yet paid now use this.` });
    onChanged?.();
  }

  if (!data) return msg ? <p className="mt-4 text-[13px] text-text-muted">{msg.text}</p> : null;
  // Lesson types in use, plus any retired one that still has a rate.
  const types = data.lessonTypes.filter((t) => t.active || data.rates.some((r) => r.lessonTypeId === t.id));
  if (types.length === 0) return null;
  const canEdit = data.viewer.canEdit && !isSelf;

  return (
    <section className="mt-4 rounded-xl border border-app-border bg-surface p-4 sm:p-5" aria-label="Private lesson pay">
      <h2 className="text-[15px] font-semibold text-text-primary">Private lesson pay</h2>
      <p className="mt-1 text-[12.5px] text-text-muted">
        What {isSelf ? "you are" : `${first} is`} paid for each private lesson once it has finished. A lesson type with nothing set shows on Payroll as “needs review” — no amount is guessed.
      </p>
      {msg && (
        <p role="status" className="mt-3 rounded-lg px-3 py-2 text-[13px]"
          style={msg.kind === "ok" ? { background: "var(--color-success-surface)", color: "var(--color-success-text)" } : { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
          {msg.text}
        </p>
      )}
      <ul className="mt-3 divide-y divide-app-border">
        {types.map((t) => {
          const saved = data.rates.find((r) => r.lessonTypeId === t.id);
          const d = drafts[t.id] ?? draftOf(saved);
          const s = draftOf(saved);
          const changed = d.payType !== s.payType || (d.payType !== "NONE" && Number(d.value) !== Number(s.value));
          return (
            <li key={t.id} className="py-3">
              <p className="text-[14px] font-medium text-text-primary">
                {t.title}
                {!t.active && <span className="ml-1.5 text-[12px] font-normal text-text-muted">no longer offered</span>}
              </p>
              <p className="text-[12.5px] text-text-muted">{rateSummary(saved, t.basePrice)}</p>
              {canEdit && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select aria-label={`How ${t.title} pays`} value={d.payType} className={field}
                    onChange={(e) => setDrafts((m) => ({ ...m, [t.id]: { payType: e.target.value as Draft["payType"], value: d.value } }))}>
                    <option value="NONE">Not set</option>
                    <option value="FLAT">Flat amount per lesson ($)</option>
                    <option value="PERCENT">Percent of the lesson price (%)</option>
                  </select>
                  {d.payType !== "NONE" && (
                    <input aria-label={d.payType === "FLAT" ? `Dollars per ${t.title}` : `Percent of ${t.title}`} type="number" inputMode="decimal" min={0} max={d.payType === "PERCENT" ? 100 : undefined} step="0.01"
                      value={d.value} placeholder={d.payType === "FLAT" ? "e.g. 40" : "e.g. 60"} className={`${field} w-28`}
                      onChange={(e) => setDrafts((m) => ({ ...m, [t.id]: { payType: d.payType, value: e.target.value } }))} />
                  )}
                  <button type="button" disabled={!changed || busy === t.id} onClick={() => save(t)} className={`${btn} bg-brand text-white hover:opacity-90`}>
                    {busy === t.id ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
