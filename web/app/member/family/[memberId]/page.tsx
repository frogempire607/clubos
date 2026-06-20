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
  allowOwnMessaging?: boolean;
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

type Purchase = { type: "subscription" | "sale"; id: string; label: string; status: string };
type Target = { id: string; firstName: string; lastName: string; kind: string };

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
  const [allowOwnMessaging, setAllowOwnMessaging] = useState(true);
  const [dailySpendLimit, setDailySpendLimit] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [openingBilling, setOpeningBilling] = useState(false);
  const [billingMsg, setBillingMsg] = useState("");
  const [ownLogin, setOwnLogin] = useState<{ hasLogin: boolean; email: string | null }>({ hasLogin: false, email: null });
  const [childEmail, setChildEmail] = useState("");
  const [invitingLogin, setInvitingLogin] = useState(false);
  const [loginMsg, setLoginMsg] = useState("");
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [movingKey, setMovingKey] = useState<string | null>(null);
  const [purchaseMsg, setPurchaseMsg] = useState("");

  function loadPurchases() {
    fetch(`/api/member/family/${params.memberId}/purchases`)
      .then((r) => (r.ok ? r.json() : { purchases: [], targets: [] }))
      .then((d) => { setPurchases(d.purchases || []); setTargets(d.targets || []); });
  }
  useEffect(() => { loadPurchases(); }, [params.memberId]);

  async function reassign(p: Purchase) {
    const key = `${p.type}:${p.id}`;
    const target = moveTo[key];
    if (!target) return;
    setMovingKey(key);
    setPurchaseMsg("");
    const res = await fetch(`/api/member/family/${params.memberId}/purchases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: p.type, id: p.id, targetMemberId: target }),
    });
    const d = await res.json().catch(() => ({}));
    setMovingKey(null);
    if (!res.ok) { setPurchaseMsg(typeof d.error === "string" ? d.error : "Could not move purchase."); return; }
    const name = targets.find((t) => t.id === target);
    setPurchaseMsg(`Moved "${p.label}"${name ? ` to ${name.firstName}` : ""}.`);
    loadPurchases();
  }

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
      setAllowOwnMessaging(c.allowOwnMessaging !== false);
      setDailySpendLimit(
        typeof c.dailySpendLimit === "number" ? String(c.dailySpendLimit) : "",
      );
      const ol = (d as Data & { ownLogin?: { hasLogin: boolean; email: string | null } }).ownLogin;
      if (ol) { setOwnLogin(ol); setChildEmail(ol.email ?? ""); }
      setLoading(false);
    });
  }, [params.memberId]);

  async function inviteChildLogin() {
    setInvitingLogin(true);
    setLoginMsg("");
    const res = await fetch(`/api/member/family/${params.memberId}/invite-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: childEmail.trim(),
        requirePaymentApproval,
        allowOwnMessaging,
        allowPackagePurchase,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setInvitingLogin(false);
    if (!res.ok) { setLoginMsg(typeof d.error === "string" ? d.error : "Could not send invite."); return; }
    setLoginMsg(d.message || "Invite sent.");
    setOwnLogin({ hasLogin: true, email: childEmail.trim().toLowerCase() });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    const controls: Controls = {
      requirePaymentApproval,
      monitoredMessaging,
      allowPackagePurchase,
      allowOwnMessaging,
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

  // Open the Stripe billing portal for THIS child (the API authorizes via the
  // guardian link). Lets a parent update the card / view invoices for their
  // child's membership. Cancellation stays gated behind club approval.
  async function openChildBilling() {
    setOpeningBilling(true);
    setBillingMsg("");
    const res = await fetch("/api/member/billing-portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: params.memberId }),
    });
    const d = await res.json().catch(() => ({}));
    setOpeningBilling(false);
    if (!res.ok || !d.url) {
      setBillingMsg(typeof d.error === "string" ? d.error : "Could not open billing.");
      return;
    }
    window.location.href = d.url;
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

      {/* Billing — parent manages the child's card/invoices via Stripe. */}
      <section className="bg-white border border-stone-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-stone-900 mb-1">Billing</h2>
        <p className="text-xs text-stone-500 mb-3">
          Update the card on file and view invoices for {data.member.firstName}&apos;s membership.
          To cancel, your club reviews the request first.
        </p>
        <button
          type="button"
          onClick={openChildBilling}
          disabled={openingBilling}
          className="text-sm px-4 py-2 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 disabled:opacity-50"
        >
          {openingBilling ? "Opening…" : "Manage billing"}
        </button>
        {billingMsg && (
          <div className="mt-3 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
            {billingMsg}
          </div>
        )}
      </section>

      {/* Child's own login — optional. Parent stays guardian + billing manager. */}
      <section className="bg-white border border-stone-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-stone-900 mb-1">{data.member.firstName}&apos;s own login</h2>
        <p className="text-xs text-stone-500 mb-3">
          Optionally give {data.member.firstName} their own login so they can sign in themselves.
          You stay the guardian and billing manager, and the controls below decide what they can do
          on their own.
        </p>
        {ownLogin.hasLogin ? (
          <div className="text-sm text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 mb-2">
            Has their own login{ownLogin.email ? <> · <strong>{ownLogin.email}</strong></> : null}.
          </div>
        ) : null}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="email"
            value={childEmail}
            onChange={(e) => setChildEmail(e.target.value)}
            placeholder={`${data.member.firstName}'s email`}
            className="flex-1 px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
          />
          <button
            type="button"
            onClick={inviteChildLogin}
            disabled={invitingLogin || !childEmail.trim()}
            className="text-sm px-4 py-2 bg-stone-900 text-white rounded-lg hover:bg-stone-700 disabled:opacity-50 whitespace-nowrap"
          >
            {invitingLogin ? "Sending…" : ownLogin.hasLogin ? "Resend invite" : "Send login invite"}
          </button>
        </div>
        <p className="text-[11px] text-stone-400 mt-2">
          They&apos;ll get an email to set their own password. Save the controls below first if you
          changed them — the invite uses your current settings.
        </p>
        {loginMsg && (
          <div className="mt-2 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
            {loginMsg}
          </div>
        )}
      </section>

      {/* Purchases — move one to another profile if it was bought under the wrong athlete. */}
      {purchases.length > 0 && targets.length > 0 && (
        <section className="bg-white border border-stone-200 rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold text-stone-900 mb-1">Purchases</h2>
          <p className="text-xs text-stone-500 mb-3">
            Bought something under the wrong athlete? Move it to the right profile.
          </p>
          <div className="space-y-2">
            {purchases.map((p) => {
              const key = `${p.type}:${p.id}`;
              return (
                <div key={key} className="flex flex-col sm:flex-row sm:items-center gap-2 border border-stone-200 rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-stone-800 truncate">{p.label}</p>
                    <p className="text-[11px] text-stone-400">{p.type === "subscription" ? "Membership" : "Product"} · {p.status}</p>
                  </div>
                  <select
                    value={moveTo[key] ?? ""}
                    onChange={(e) => setMoveTo((s) => ({ ...s, [key]: e.target.value }))}
                    className="text-sm px-2 py-1.5 border border-stone-300 rounded-lg"
                  >
                    <option value="">Move to…</option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>{t.firstName} {t.lastName}{t.kind === "self" ? " (you)" : ""}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => reassign(p)}
                    disabled={!moveTo[key] || movingKey === key}
                    className="text-xs px-3 py-1.5 border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 disabled:opacity-40 whitespace-nowrap"
                  >
                    {movingKey === key ? "Moving…" : "Move"}
                  </button>
                </div>
              );
            })}
          </div>
          {purchaseMsg && (
            <div className="mt-2 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
              {purchaseMsg}
            </div>
          )}
        </section>
      )}

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

        {/* Own messaging */}
        <section className="bg-white border border-stone-200 rounded-xl p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={allowOwnMessaging}
              onChange={(e) => setAllowOwnMessaging(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-stone-900">
                Allow {data.member.firstName} to send and receive their own messages
              </span>
              <span className="block text-xs text-stone-500 mt-0.5">
                When off, the Messages tab on {data.member.firstName}&apos;s
                portal shows a "managed by your guardian" banner instead of
                conversations, and they can&apos;t send DMs or group messages.
                Coaches can still see threads addressed to them — you receive
                those copies on your own Messages tab.
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
