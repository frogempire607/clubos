"use client";

import { useEffect, useState } from "react";
import SiblingDiscountCard from "@/components/settings/SiblingDiscountCard";
import GroupRatesCard from "@/components/settings/GroupRatesCard";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";

type Status = {
  connected: boolean;
  stripeOnboardingComplete: boolean;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
};

export default function BillingSettingsPage() {
  const { data: session } = useSession();
  void session;
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const justConnected = params.get("connected") === "true";

  async function load() {
    setLoading(true);
    const statusRes = await fetch("/api/stripe/status");
    if (statusRes.ok) setStatus(await statusRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleConnect() {
    setError("");
    setConnecting(true);
    const res = await fetch("/api/stripe/connect", { method: "POST" });
    const data = await res.json();
    setConnecting(false);
    if (!res.ok || !data.url) {
      setError(data.error?.toString() || "Failed to start onboarding");
      return;
    }
    window.location.href = data.url;
  }

  async function handleOpenDashboard() {
    const res = await fetch("/api/stripe/dashboard", { method: "POST" });
    const data = await res.json();
    if (data.url) window.open(data.url, "_blank");
  }

  const fullyReady = status?.connected && status?.stripeChargesEnabled && status?.stripePayoutsEnabled;

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-text-primary mb-1">Member payments</h1>
        <p className="text-sm text-text-muted">Connect Stripe to accept payments from your members.</p>
      </div>

      {justConnected && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-lime-accent border border-lime-accent/40 text-sm text-text-primary">
          ✓ Stripe onboarding complete.
        </div>
      )}


      {loading ? (
        <div className="bg-white rounded-xl border border-app-border p-6 text-center text-sm text-text-muted">Loading…</div>
      ) : !status?.connected ? (
        <div className="bg-white rounded-xl border border-app-border p-6">
          <div className="flex items-start gap-4 mb-4">
            <div className="w-12 h-12 rounded-lg flex items-center justify-center text-white text-xl font-medium" style={{ background: "var(--color-primary)" }}>S</div>
            <div className="flex-1">
              <div className="text-base font-semibold text-text-primary">Stripe</div>
              <div className="text-xs text-text-muted">Card payments, subscriptions, payouts</div>
            </div>
            <span className="text-xs px-2 py-1 rounded-full font-medium bg-app-bg text-text-muted">Not connected</span>
          </div>

          {error && <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

          <button onClick={handleConnect} disabled={connecting} className="w-full py-2.5 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
            {connecting ? "Opening Stripe…" : "Connect Stripe →"}
          </button>
        </div>
      ) : fullyReady ? (
        <div className="bg-white rounded-xl border border-app-border p-6">
          <div className="flex items-start gap-4 mb-4">
            <div className="w-12 h-12 rounded-lg flex items-center justify-center text-white text-xl font-medium" style={{ background: "var(--color-primary)" }}>S</div>
            <div className="flex-1">
              <div className="text-base font-semibold text-text-primary">Stripe</div>
              <div className="text-xs text-text-muted">Ready to accept payments</div>
            </div>
            <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: "var(--color-success)", color: "#1F1F23" }}>✓ Connected</span>
          </div>

          <div className="flex gap-2">
            <button onClick={handleOpenDashboard} className="flex-1 py-2 rounded-lg border border-app-border text-text-primary text-sm hover:bg-app-bg">
              Open Stripe dashboard
            </button>
            <button onClick={load} className="px-3 py-2 rounded-lg border border-app-border text-text-primary text-sm hover:bg-app-bg">Refresh</button>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border p-6">
          <div className="flex items-start gap-4 mb-4">
            <div className="w-12 h-12 rounded-lg flex items-center justify-center text-white text-xl font-medium" style={{ background: "var(--color-primary)" }}>S</div>
            <div className="flex-1">
              <div className="text-base font-semibold text-text-primary">Stripe</div>
              <div className="text-xs text-text-muted">Onboarding incomplete</div>
            </div>
            <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: "var(--color-warning)", color: "#fff" }}>In progress</span>
          </div>
          <button onClick={handleConnect} disabled={connecting} className="w-full py-2.5 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
            {connecting ? "Opening Stripe…" : "Continue onboarding →"}
          </button>
        </div>
      )}

      <div className="mt-6 bg-app-bg border border-app-border rounded-xl p-5">
        <h3 className="text-sm font-semibold text-text-primary mb-2">How payments work</h3>
        <ul className="text-xs text-text-muted space-y-1.5 leading-relaxed">
          <li>· Members pay with their card directly to your Stripe account</li>
          <li>· AthletixOS charges <strong>0% platform fee</strong> on every plan — your monthly subscription is all you pay us</li>
          <li>· Optionally pass Stripe&apos;s processing fee to members at checkout (toggle below)</li>
          <li>· You handle payouts, taxes, and refunds through Stripe</li>
          <li>· Test card: <code className="bg-white px-1 py-0.5 rounded">4242 4242 4242 4242</code> — any future date / any CVC</li>
        </ul>
      </div>

      {/* ── Pass processing fees to customer ── */}
      <ProcessingFeeToggle />

      {/* ── Offline (cash/check) activation policy ── */}
      <OfflineActivationPolicyCard />

      {/* ── B3 slice 2: sibling membership discount ── */}
      <SiblingDiscountCard />
      <GroupRatesCard />

      {/* The AthletixOS plan (what your club pays us) lives in Settings → AthletixOS plan (B20). */}
      <div className="mt-8 rounded-xl border border-app-border bg-surface p-4 text-sm text-text-muted">
        This page is what your members pay you. What your club pays for AthletixOS is under{" "}
        <a href="/dashboard/settings?section=plan" className="text-brand hover:underline">Settings → AthletixOS plan</a>
        {" · "}
        <a href="/dashboard/settings/diagnostics" className="text-brand hover:underline">Stripe diagnostics</a>
      </div>
    </div>
  );
}

/* ── Pass Stripe processing fees to the customer ── */
function ProcessingFeeToggle() {
  const [enabled, setEnabled] = useState(false);
  const [note, setNote] = useState("");
  const [feeDesc, setFeeDesc] = useState("2.9%");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/club/payment-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setEnabled(!!d.passProcessingFees);
          setNote(d.processingFeeNote || "");
          if (d.feeDescription) setFeeDesc(d.feeDescription);
        }
        setLoaded(true);
      });
  }, []);

  async function save(next: boolean, nextNote: string) {
    setSaving(true);
    setSaved(false);
    const res = await fetch("/api/club/payment-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passProcessingFees: next, processingFeeNote: nextNote || null }),
    });
    setSaving(false);
    if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2500); }
  }

  return (
    <div className="mt-6 bg-white rounded-xl border border-app-border p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary mb-1">Pass processing fees to customer</h3>
          <p className="text-xs text-text-muted leading-relaxed max-w-xl">
            When enabled, Stripe&apos;s processing fee ({feeDesc}) is transparently added to the
            member&apos;s checkout total so you receive the full intended amount. Members see a clear
            breakdown before paying. Applies to memberships, events, classes, products, and private
            lessons.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          disabled={!loaded || saving}
          onClick={() => { const n = !enabled; setEnabled(n); save(n, note); }}
          className="relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition disabled:opacity-50"
          style={{ background: enabled ? "var(--color-primary)" : "var(--color-border)" }}
        >
          <span
            className="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform mt-0.5"
            style={{ transform: enabled ? "translateX(22px)" : "translateX(2px)" }}
          />
        </button>
      </div>

      {enabled && (
        <div className="mt-4">
          <label className="block text-xs font-medium text-text-primary mb-1">
            Optional explanation shown to members (optional)
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => save(enabled, note)}
            placeholder="e.g. A small processing fee keeps your membership price the same for the club."
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
            maxLength={300}
          />
          <div className="mt-3 bg-app-bg border border-app-border rounded-lg p-3 text-xs text-text-muted">
            <p className="font-medium text-text-primary mb-1">Example member sees</p>
            <div className="flex justify-between"><span>Membership</span><span>$100.00</span></div>
            <div className="flex justify-between"><span>Processing fee</span><span>$2.90</span></div>
            <div className="flex justify-between font-semibold text-text-primary border-t border-app-border mt-1 pt-1">
              <span>Total</span><span>$102.90</span>
            </div>
          </div>
        </div>
      )}
      {saved && <p className="text-xs text-text-muted mt-2">Saved.</p>}
    </div>
  );
}

/* ── Offline (cash/check) payment activation policy ── */
// When a client accepts a cash/check offer, does the membership start right
// away (payment still due) or only when staff records the money as received?
// Persisted via the same club payment-settings API (additive field).
function OfflineActivationPolicyCard() {
  const [policy, setPolicy] = useState<"ON_PAYMENT" | "ON_ACCEPTANCE">("ON_PAYMENT");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/club/payment-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.offlineActivationPolicy === "ON_ACCEPTANCE") setPolicy("ON_ACCEPTANCE");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function save(next: "ON_PAYMENT" | "ON_ACCEPTANCE") {
    const prev = policy;
    setPolicy(next);
    setSaving(true);
    setSaved(false);
    setError("");
    const res = await fetch("/api/club/payment-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offlineActivationPolicy: next }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      setPolicy(prev);
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not save the setting.");
    }
  }

  const options: { value: "ON_PAYMENT" | "ON_ACCEPTANCE"; title: string; detail: string }[] = [
    {
      value: "ON_PAYMENT",
      title: "Activate only after staff records payment (recommended, default)",
      detail:
        "The client accepts the offer, but the membership stays pending until a staff member records the cash/check as physically received. Safest — access never starts before the money is in hand.",
    },
    {
      value: "ON_ACCEPTANCE",
      title: "Activate when the client accepts, payment still due",
      detail:
        "The membership starts the moment the client confirms; the cash/check stays outstanding in the billing center until staff records it as received.",
    },
  ];

  return (
    <div className="mt-6 bg-white rounded-xl border border-app-border p-5">
      <h3 className="text-sm font-semibold text-text-primary mb-1">Offline payment activation</h3>
      <p className="text-xs text-text-muted leading-relaxed max-w-xl mb-3">
        When a member accepts a cash or check offer, accepting is not paying. Choose when their
        membership actually starts. Either way, staff records the payment in the billing center —
        that&apos;s the moment it counts as revenue and the receipt is emailed.
      </p>
      <div className="space-y-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 cursor-pointer ${
              policy === o.value ? "border-brand bg-brand/5" : "border-app-border"
            } ${!loaded || saving ? "opacity-60" : ""}`}
          >
            <input
              type="radio"
              name="offline-activation-policy"
              checked={policy === o.value}
              disabled={!loaded || saving}
              onChange={() => save(o.value)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-text-primary">{o.title}</span>
              <span className="block text-xs text-text-muted mt-0.5 leading-relaxed">{o.detail}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {saved && <p className="text-xs text-text-muted mt-2">Saved.</p>}
    </div>
  );
}
