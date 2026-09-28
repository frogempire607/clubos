"use client";

// Payroll page → "Paydays": staff due to be paid, from each staff member's
// pay schedule (GET /api/payroll/reminders). The amount is this page's own
// calculation for that pay period — an estimate. "Mark paid" records the
// payment in the Payouts ledger (POST /api/payroll/reminders/mark-paid),
// which is what clears the reminder. Payroll calculates; Payouts records.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Sheet from "@/components/Sheet";
import { formatPayday, formatPeriod, statusLabel, type ReminderStatus } from "@/lib/paySchedule";

type Reminder = {
  userId: string;
  name: string;
  firstName: string;
  payday: string;
  periodStart: string;
  periodEnd: string;
  status: ReminderStatus;
  daysUntil: number;
  estimate: number | null;
  hasPlan: boolean;
};
type Schedule = { userId: string; name: string; active: boolean; nextPayday: string | null };
type Resp = {
  today: string;
  reminders: Reminder[];
  schedules: Schedule[];
  unscheduled: { userId: string; name: string }[];
  viewer: { canMarkPaid: boolean; userId: string; isOwner: boolean };
};

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHECK", label: "Check" },
  { value: "TRANSFER", label: "Transfer" },
  { value: "OTHER", label: "Other" },
] as const;

const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px]";

function money(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const PILL: Record<ReminderStatus, React.CSSProperties> = {
  overdue: {
    background: "var(--color-danger-surface)",
    color: "var(--color-danger-text)",
    borderColor: "var(--color-danger-border)",
  },
  due_today: {
    background: "var(--color-warn-surface)",
    color: "var(--color-warn-text)",
    borderColor: "var(--color-warn-border)",
  },
  upcoming: {},
};

export default function PaydaysCard({ onPaid }: { onPaid?: () => void }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paying, setPaying] = useState<Reminder | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("TRANSFER");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/payroll/reminders", { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setLoadError(typeof d.error === "string" ? d.error : "Couldn't load paydays.");
      return;
    }
    setLoadError(null);
    setData(d);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openPay(r: Reminder) {
    setPaying(r);
    setAmount(r.estimate !== null && r.estimate > 0 ? r.estimate.toFixed(2) : "");
    setMethod("TRANSFER");
    setError(null);
  }

  async function markPaid() {
    if (!paying) return;
    const n = Number(amount);
    if (!amount.trim() || !Number.isFinite(n) || n <= 0) {
      setError("Enter the amount you paid.");
      return;
    }
    setSaving(true);
    setError(null);
    const r = await fetch("/api/payroll/reminders/mark-paid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: paying.userId, payday: paying.payday, amount: n, method }),
    });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "That didn't save. Try again.");
      return;
    }
    setFlash(`Recorded ${money(n)} to ${paying.name} in Payouts.`);
    setPaying(null);
    await load();
    onPaid?.();
  }

  if (loadError) {
    return (
      <section className="mb-4 rounded-xl border border-app-border bg-surface p-4 text-[13px]" style={{ color: "var(--color-danger-text)" }}>
        {loadError}
      </section>
    );
  }
  if (!data) {
    return <section className="mb-4 h-24 animate-pulse rounded-xl border border-app-border bg-surface" aria-label="Loading paydays" />;
  }

  const { reminders, schedules, unscheduled, viewer } = data;
  const dueIds = new Set(reminders.map((r) => r.userId));
  const later = schedules
    .filter((s) => s.active && s.nextPayday && !dueIds.has(s.userId))
    .sort((a, b) => (a.nextPayday! < b.nextPayday! ? -1 : 1))
    .slice(0, 6);
  const canPay = (r: Reminder) => viewer.canMarkPaid && (viewer.isOwner || r.userId !== viewer.userId);

  return (
    <section className="mb-4 rounded-xl border border-app-border bg-surface" aria-labelledby="paydays-h">
      <div className="px-4 pb-2 pt-4 sm:px-5">
        <h2 id="paydays-h" className="text-[15px] font-semibold text-text-primary">
          Paydays
        </h2>
        <p className="mt-0.5 text-[13px] text-text-muted">
          From each staff member&apos;s pay schedule. Amounts are this page&apos;s estimate for each pay period —
          &ldquo;Mark paid&rdquo; records what you actually paid in Payouts.
        </p>
        {flash && (
          <p
            role="status"
            className="mt-2 rounded-lg border px-3 py-2 text-[13px]"
            style={{
              background: "var(--color-success-surface)",
              color: "var(--color-success-text)",
              borderColor: "var(--color-success-border)",
            }}
          >
            {flash}
          </p>
        )}
      </div>

      {reminders.length === 0 ? (
        <p className="px-4 pb-3 text-[13px] text-text-muted sm:px-5">
          {schedules.some((s) => s.active) ? "Nobody is due to be paid in the next 2 days." : "No pay schedules set yet."}
        </p>
      ) : (
        <ul className="divide-y divide-app-border border-t border-app-border">
          {reminders.map((r) => (
            <li key={`${r.userId}-${r.payday}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1 basis-[200px]">
                <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-text-primary">
                  <span className="min-w-0 break-words">{r.name}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[12px] font-medium ${
                      r.status === "upcoming" ? "border-app-border bg-app-bg text-text-muted" : ""
                    }`}
                    style={PILL[r.status]}
                  >
                    {statusLabel(r)}
                  </span>
                </p>
                <p className="mt-0.5 text-[13px] text-text-muted">
                  Payday {formatPayday(r.payday)} · for {formatPeriod(r.periodStart, r.periodEnd)}
                </p>
              </div>
              <div className="text-right text-[14px]">
                {r.estimate !== null ? (
                  <span className="font-semibold text-text-primary">about {money(r.estimate)}</span>
                ) : (
                  <Link href={`/dashboard/staff/${r.userId}?tab=pay`} className="text-[13px] text-brand hover:underline">
                    No pay plan — set one
                  </Link>
                )}
              </div>
              {canPay(r) && (
                <button
                  type="button"
                  onClick={() => openPay(r)}
                  className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}
                >
                  Mark paid
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {later.length > 0 && (
        <div className="border-t border-app-border px-4 py-3 sm:px-5">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Coming up</p>
          <ul className="mt-1 space-y-0.5">
            {later.map((s) => (
              <li key={s.userId} className="text-[13px] text-text-primary">
                {s.name} <span className="text-text-muted">· {formatPayday(s.nextPayday!)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {unscheduled.length > 0 && (
        <div className="border-t border-app-border px-4 py-3 text-[13px] text-text-muted sm:px-5">
          <p>
            No pay schedule yet — set one on their profile → Pay to get payday reminders:
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-1 gap-y-0">
            {unscheduled.map((u, i) => (
              <li key={u.userId}>
                <Link
                  href={`/dashboard/staff/${u.userId}?tab=pay`}
                  className="inline-flex min-h-[44px] items-center text-brand hover:underline md:min-h-0"
                >
                  {u.name}
                </Link>
                {i < unscheduled.length - 1 && <span aria-hidden>,</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Sheet
        open={!!paying}
        onClose={() => (saving ? undefined : setPaying(null))}
        title={paying ? `Mark ${paying.firstName || paying.name} paid` : "Mark paid"}
        description={
          paying ? (
            <>
              For {formatPeriod(paying.periodStart, paying.periodEnd)} (payday {formatPayday(paying.payday)}). This records
              the payment in Payouts — it doesn&apos;t send money.
            </>
          ) : undefined
        }
        footer={
          <>
            <button
              type="button"
              disabled={saving}
              onClick={() => setPaying(null)}
              className={`${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={markPaid}
              className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}
            >
              {saving ? "Saving…" : "Mark paid"}
            </button>
          </>
        }
      >
        {paying && (
          <div className="space-y-4 pt-1">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Amount paid</span>
              <div className="relative max-w-[220px]">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="min-h-[44px] w-full rounded-lg border border-app-border bg-surface pl-7 pr-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
              <span className="mt-1 block text-[12px] text-text-muted">
                {paying.estimate !== null
                  ? `Payroll estimate: ${money(paying.estimate)}. Change it to what you actually paid.`
                  : "No pay plan, so there's no estimate — enter what you paid."}
              </span>
            </label>
            <fieldset>
              <legend className="mb-1 text-[13px] font-medium text-text-primary">Paid by</legend>
              <div role="radiogroup" aria-label="Paid by" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {METHODS.map((m) => {
                  const on = method === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setMethod(m.value)}
                      className={`min-h-[44px] rounded-lg border px-3 text-[13.5px] font-medium ${
                        on ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {error && (
              <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>
                {error}
              </p>
            )}
          </div>
        )}
      </Sheet>
    </section>
  );
}
