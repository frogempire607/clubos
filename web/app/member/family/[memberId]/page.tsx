"use client";

// Per-child parental-controls editor. Reached from the family switcher
// on /member/profile via "Controls" link next to each linked child.
// Guardian-only — the API enforces the link check.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type Controls = {
  requirePaymentApproval?: boolean;
  monitoredMessaging?: boolean;
  allowPackagePurchase?: boolean;
  dailySpendLimit?: number;
};

type Data = {
  member: {
    id: string;
    firstName: string;
    lastName: string;
    isMinor: boolean;
    dateOfBirth: string | null;
  };
  birthdayLockedAt: string | null;
  parentControls: Controls | null;
};

export default function FamilyControlsPage() {
  const params = useParams<{ memberId: string }>();
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Form state
  const [birthdayLocked, setBirthdayLocked] = useState(false);
  const [requirePaymentApproval, setRequirePaymentApproval] = useState(false);
  const [monitoredMessaging, setMonitoredMessaging] = useState(false);
  const [allowPackagePurchase, setAllowPackagePurchase] = useState(true);
  const [dailySpendLimit, setDailySpendLimit] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/member/family/${params.memberId}/controls`).then(async (r) => {
      if (!r.ok) {
        setError(r.status === 403 ? "You don't have access to this athlete." : "Couldn't load.");
        setLoading(false);
        return;
      }
      const d: Data = await r.json();
      setData(d);
      setBirthdayLocked(!!d.birthdayLockedAt);
      const c = d.parentControls ?? {};
      setRequirePaymentApproval(c.requirePaymentApproval === true);
      setMonitoredMessaging(c.monitoredMessaging === true);
      // Default true (no restriction) when never set.
      setAllowPackagePurchase(c.allowPackagePurchase !== false);
      setDailySpendLimit(
        typeof c.dailySpendLimit === "number" ? String(c.dailySpendLimit) : "",
      );
      setLoading(false);
    });
  }, [params.memberId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    const controls: Controls = {
      requirePaymentApproval,
      monitoredMessaging,
      allowPackagePurchase,
    };
    if (dailySpendLimit.trim() !== "") {
      const n = Number(dailySpendLimit);
      if (!Number.isFinite(n) || n < 0) {
        setError("Daily spend limit must be a non-negative number.");
        setSaving(false);
        return;
      }
      controls.dailySpendLimit = n;
    }
    const res = await fetch(`/api/member/family/${params.memberId}/controls`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ birthdayLocked, parentControls: controls }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  if (loading) return <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>;
  if (error && !data) {
    return (
      <div className="text-center py-8 text-stone-500 text-sm">
        {error}
        <div className="mt-3">
          <Link href="/member/profile" className="text-stone-700 underline">Back to profile</Link>
        </div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <>
      <div className="mb-5">
        <Link href="/member/profile" className="text-xs text-stone-500 hover:text-stone-900">
          ← Back to profile
        </Link>
        <h1 className="text-2xl font-semibold text-stone-900 mt-2">
          Controls for {data.member.firstName} {data.member.lastName}
        </h1>
        <p className="text-sm text-stone-500 mt-1">
          These settings only apply when {data.member.firstName} books or buys something
          from their own portal login. Anything you do on their behalf from your account
          bypasses these checks — you&apos;re the oversight.
        </p>
      </div>

      <form onSubmit={save} className="space-y-3">
        {/* Birthday lock */}
        <section className="bg-white border border-stone-200 rounded-xl p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={birthdayLocked}
              onChange={(e) => setBirthdayLocked(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-stone-900">
                Lock date of birth
              </span>
              <span className="block text-xs text-stone-500 mt-0.5">
                {data.member.firstName} can&apos;t edit their own DOB from the portal.
                You can still update it from the club&apos;s member screen if needed.
              </span>
            </span>
          </label>
        </section>

        {/* Payment approval */}
        <section className="bg-white border border-stone-200 rounded-xl p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={requirePaymentApproval}
              onChange={(e) => setRequirePaymentApproval(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-stone-900">
                Require my approval for every paid booking
              </span>
              <span className="block text-xs text-stone-500 mt-0.5">
                Class drop-ins, paid events, paid private lessons, and package
                purchases pause for your approval before any payment is taken.
                Free bookings (covered by an active membership) go through
                instantly.
              </span>
            </span>
          </label>
        </section>

        {/* Daily spend limit */}
        <section className="bg-white border border-stone-200 rounded-xl p-4">
          <label htmlFor="dsl" className="block text-sm font-medium text-stone-900 mb-1">
            Daily spend limit (optional)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-stone-500 text-sm">$</span>
            <input
              id="dsl"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={dailySpendLimit}
              onChange={(e) => setDailySpendLimit(e.target.value)}
              placeholder="No limit"
              className="flex-1 px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
            />
            <span className="text-xs text-stone-500">/ day</span>
          </div>
          <p className="text-xs text-stone-500 mt-2">
            When set, any booking whose total would push today&apos;s approved spend
            over this cap pauses for your approval — even if the full-approval
            toggle above is off.
          </p>
        </section>

        {/* Package purchases */}
        <section className="bg-white border border-stone-200 rounded-xl p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={allowPackagePurchase}
              onChange={(e) => setAllowPackagePurchase(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-stone-900">
                Allow package purchases
              </span>
              <span className="block text-xs text-stone-500 mt-0.5">
                Uncheck to block {data.member.firstName} from buying lesson packs
                entirely (they still pause for approval if the toggle above is on).
              </span>
            </span>
          </label>
        </section>

        {/* Monitored messaging */}
        <section className="bg-white border border-stone-200 rounded-xl p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={monitoredMessaging}
              onChange={(e) => setMonitoredMessaging(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-stone-900">
                Get a copy of {data.member.firstName}&apos;s messages
              </span>
              <span className="block text-xs text-stone-500 mt-0.5">
                You already see threads addressed to your linked child on your
                Messages tab. Turning this on adds an email notification each
                time someone messages them.
              </span>
            </span>
          </label>
        </section>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {saved && (
          <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            Saved.
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save controls"}
          </button>
        </div>
      </form>
    </>
  );
}
