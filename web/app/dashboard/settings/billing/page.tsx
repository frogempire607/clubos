"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { getTierName, TIER_PRICES, TIER_FEATURES, type Tier } from "@/lib/tier";

type Status = {
  connected: boolean;
  stripeOnboardingComplete: boolean;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
};

const TIER_ORDER: Tier[] = ["starter", "growth", "pro", "enterprise"];

export default function BillingSettingsPage() {
  const { data: session } = useSession();
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const currentTier = (session?.user as any)?.tier ?? "starter";

  const justConnected = params.get("connected") === "true";

  async function load() {
    setLoading(true);
    const res = await fetch("/api/stripe/status");
    if (res.ok) setStatus(await res.json());
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
        <h1 className="text-3xl font-semibold text-text-primary mb-1">Payments</h1>
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
            <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: "var(--color-success)", color: "var(--color-text)" }}>✓ Connected</span>
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
          <li>· ClubOS takes a small platform fee (2.5% Starter, 1.25% Growth, 0% Pro/Enterprise)</li>
          <li>· You handle payouts, taxes, and refunds through Stripe</li>
          <li>· Test card: <code className="bg-white px-1 py-0.5 rounded">4242 4242 4242 4242</code> — any future date / any CVC</li>
        </ul>
      </div>

      {/* ── ClubOS Subscription Plan ── */}
      <div className="mt-8">
        <h2 className="text-xl font-semibold text-text-primary mb-1">ClubOS Plan</h2>
        <p className="text-sm text-text-muted mb-4">Your current ClubOS subscription tier.</p>

        {/* Current tier */}
        <div className="bg-white rounded-xl border border-app-border p-5 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-text-muted mb-1">Current plan</div>
              <div className="text-xl font-semibold text-text-primary">{getTierName(currentTier)}</div>
              <div className="text-sm text-text-muted mt-0.5">
                {TIER_PRICES[currentTier as Tier]?.monthly === 0
                  ? "Free forever"
                  : `$${TIER_PRICES[currentTier as Tier]?.monthly}/month`}
                {" · "}
                {TIER_FEATURES[currentTier as Tier]?.transactionFeePercent}% transaction fee
              </div>
            </div>
            <span
              className="text-xs px-3 py-1 rounded-full font-medium"
              style={{ background: "var(--color-success)", color: "var(--color-text)" }}
            >
              Active
            </span>
          </div>
        </div>

        {/* Upgrade options */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {TIER_ORDER.map((tier) => {
            const price = TIER_PRICES[tier];
            const isCurrent = tier === currentTier;
            const isHigher = TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(currentTier as Tier);
            return (
              <div
                key={tier}
                className="rounded-xl border p-4"
                style={{
                  background: isCurrent ? "var(--color-primary)" : "#fff",
                  borderColor: isCurrent ? "var(--color-primary)" : "var(--color-border)",
                  color: isCurrent ? "#fff" : "var(--color-text)",
                }}
              >
                <div className="text-xs font-medium mb-1" style={{ color: isCurrent ? "rgba(255,255,255,0.6)" : "var(--color-muted)" }}>
                  {price.label}
                </div>
                <div className="text-lg font-bold mb-0.5">
                  {price.monthly === 0 ? "Free" : `$${price.monthly}/mo`}
                </div>
                <div className="text-xs mb-3" style={{ color: isCurrent ? "rgba(255,255,255,0.55)" : "var(--color-muted)" }}>
                  {TIER_FEATURES[tier].transactionFeePercent}% fee
                </div>
                {isCurrent ? (
                  <div className="text-xs font-medium text-center py-1.5 rounded-lg" style={{ background: "rgba(255,255,255,0.15)" }}>
                    Current
                  </div>
                ) : isHigher ? (
                  <button
                    onClick={() => alert("Upgrade coming soon — contact support@clubos.app")}
                    className="w-full text-xs font-medium py-1.5 rounded-lg transition-colors"
                    style={{ background: "var(--color-primary)", color: "#fff" }}
                  >
                    Upgrade
                  </button>
                ) : (
                  <div className="text-xs text-center py-1.5 rounded-lg" style={{ color: "var(--color-muted)" }}>
                    Downgrade
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-text-muted mt-3">
          To change your plan, email <a href="mailto:support@clubos.app" className="underline">support@clubos.app</a>. Full self-serve billing coming soon.
        </p>
      </div>
    </div>
  );
}
