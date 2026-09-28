"use client";

// Staff profile → Pay → "Pay schedule": when this person gets paid. Drives
// the payday reminders on the Payroll page, the dashboard, and the owner's
// morning email. Saves on its own (PUT /api/staff/[id]/pay-schedule) — it is
// not part of "Save pay plan". Read-only for the staff member themselves and
// for anyone without Financials & payroll: full (the server enforces both).
import { useCallback, useEffect, useState } from "react";
import Switch from "@/components/staff/access/Switch";
import {
  PAY_FREQUENCIES,
  PAY_FREQUENCY_LABELS,
  describeSchedule,
  formatPayday,
  isValidYmd,
  nextPaydays,
  type PayFrequency,
} from "@/lib/paySchedule";

type Draft = { frequency: PayFrequency; anchorDate: string; active: boolean };

const field =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-70 md:min-h-[38px]";
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px]";

export default function PayScheduleCard({
  staffId,
  first,
  readOnly,
  isSelf,
  onDirtyChange,
}: {
  staffId: string;
  first: string;
  readOnly: boolean;
  isSelf: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(false);
  const [today, setToday] = useState("");
  const [saved, setSaved] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft>({ frequency: "BIWEEKLY", anchorDate: "", active: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const apply = useCallback((d: { schedule: Draft | null; today: string }) => {
    setToday(d.today);
    if (d.schedule) {
      const s: Draft = {
        frequency: d.schedule.frequency as PayFrequency,
        anchorDate: d.schedule.anchorDate,
        active: d.schedule.active,
      };
      setSaved(s);
      setDraft(s);
      setExists(true);
    } else {
      setSaved(null);
      setExists(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/staff/${staffId}/pay-schedule`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) setError(typeof d.error === "string" ? d.error : "Couldn't load the pay schedule.");
        else apply(d);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) {
          setError("Couldn't load the pay schedule.");
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [staffId, apply]);

  const dirty =
    !readOnly &&
    (saved
      ? saved.frequency !== draft.frequency || saved.anchorDate !== draft.anchorDate || saved.active !== draft.active
      : draft.anchorDate !== "");

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const set = (patch: Partial<Draft>) => {
    setFlash(null);
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  async function save() {
    if (!isValidYmd(draft.anchorDate)) {
      setError(draft.frequency === "SEMIMONTHLY" ? "Pick the date the schedule starts." : "Pick the next payday.");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await fetch(`/api/staff/${staffId}/pay-schedule`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "The pay schedule didn't save. Your edits are still here.");
      return;
    }
    apply(d);
    setFlash("Pay schedule saved.");
  }

  const valid = isValidYmd(draft.anchorDate);
  const upcoming = valid && today && draft.active ? nextPaydays(draft, today, 3) : [];
  const semimonthly = draft.frequency === "SEMIMONTHLY";

  return (
    <section className="rounded-xl border border-app-border bg-surface p-4 sm:p-5" aria-labelledby="pay-schedule-h">
      <h2 id="pay-schedule-h" className="text-[15px] font-semibold text-text-primary">
        Pay schedule
      </h2>
      <p className="mt-0.5 text-[12.5px] text-text-muted">
        {isSelf
          ? "When you get paid. Set by the owner."
          : `When ${first} gets paid. You'll get a reminder on the dashboard and an email the morning a payment is due.`}
      </p>

      {!loaded ? (
        <p className="mt-3 text-[13px] text-text-muted">Loading…</p>
      ) : readOnly && !exists ? (
        <p className="mt-3 text-[13px] text-text-muted">
          {isSelf ? "No payday has been set for you yet." : `No pay schedule set for ${first}.`}
        </p>
      ) : readOnly && saved ? (
        <div className="mt-3 space-y-1">
          <p className="text-[14px] text-text-primary">
            {PAY_FREQUENCY_LABELS[saved.frequency] ?? saved.frequency}
            <span className="text-text-muted"> · {describeSchedule(saved)}</span>
          </p>
          {!saved.active && <p className="text-[13px] text-text-muted">Payday reminders are off.</p>}
          <NextList days={upcoming} />
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">How often</span>
            <select
              value={draft.frequency}
              onChange={(e) => set({ frequency: e.target.value as PayFrequency })}
              className={field}
            >
              {PAY_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {PAY_FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">
              {semimonthly ? "Starting from" : "Next payday"}
            </span>
            <input
              type="date"
              value={draft.anchorDate}
              onChange={(e) => set({ anchorDate: e.target.value })}
              className={`${field} max-w-[220px]`}
            />
            <span className="mt-1 block text-[12px] text-text-muted">
              {semimonthly
                ? "Paid on the 1st and the 15th of every month."
                : draft.frequency === "MONTHLY"
                  ? "Paid on this day each month (the last day in shorter months)."
                  : "Paydays repeat from this date. Weekend paydays stay on the weekend."}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <Switch checked={draft.active} label="Payday reminders" onChange={(v) => set({ active: v })} />
            <span className="text-[13.5px] text-text-primary">Payday reminders {draft.active ? "on" : "off"}</span>
          </div>
          <NextList days={upcoming} />

          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-hairline)] pt-3">
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={save}
              className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}
            >
              {saving ? "Saving…" : "Save pay schedule"}
            </button>
            {dirty && saved && (
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
            <span className="text-[12px] text-text-muted" role="status">
              {flash ?? "Saves on its own — separate from Save pay plan."}
            </span>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px]" style={{ color: "var(--color-danger-text)" }}>
          {error}
        </p>
      )}
    </section>
  );
}

function NextList({ days }: { days: string[] }) {
  if (days.length === 0) return null;
  return (
    <div>
      <p className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Next paydays</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {days.map((d) => (
          <li key={d} className="rounded-full border border-app-border px-2.5 py-1 text-[13px] text-text-primary">
            {formatPayday(d)}
          </li>
        ))}
      </ul>
    </div>
  );
}
