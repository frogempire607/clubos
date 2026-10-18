"use client";

import { useEffect, useState } from "react";
import SiblingDiscountCard from "@/components/settings/SiblingDiscountCard";
import GroupRatesCard from "@/components/settings/GroupRatesCard";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { quoteCharge, formatCents, surchargeLabel, passesAnyFee, type FeePolicy } from "@/lib/fees";

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
      <PageHeader
        title="Member payments"
        description="Connect Stripe to accept payments from your members."
      />

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
          <li>· Stripe charges its processing fee (2.9% + $0.30) and AthletixOS charges a platform fee set by your plan, on each card payment</li>
          <li>· You choose who covers each fee — your club or the paying member (toggles below)</li>
          <li>· You handle payouts, taxes, and refunds through Stripe</li>
          <li>· Test card: <code className="bg-white px-1 py-0.5 rounded">4242 4242 4242 4242</code> — any future date / any CVC</li>
        </ul>
      </div>

      {/* ── Who pays which fee (Stripe processing / AthletixOS platform) ── */}
      <FeeSplitCard />

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

/* ── Who pays which fee (pricing overhaul 2026-10-18) ── */
// Two independent toggles. All math is lib/fees.ts quoteCharge — the same
// function every checkout uses, so this preview is exactly what is charged.
type FeeSettings = {
  passProcessingFees: boolean;
  passPlatformFee: boolean;
  processingFeeNote: string | null;
  feeChoiceRequired: boolean;
  feeDescription: string;
  tier: string;
  tierName: string;
  platformFeeDescription: string;
  platformRate: number;
  platformFixedCents: number;
};

function FeeSplitCard() {
  const params = useSearchParams();
  const [s, setS] = useState<FeeSettings | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/club/payment-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: FeeSettings | null) => {
        if (d) { setS(d); setNote(d.processingFeeNote || ""); }
      });
  }, []);

  async function patch(body: Record<string, unknown>) {
    if (!s) return;
    const prev = s;
    setSaving(true); setSaved(false); setError("");
    if ("passProcessingFees" in body || "passPlatformFee" in body) setS({ ...s, ...(body as Partial<FeeSettings>) });
    const res = await fetch("/api/club/payment-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (res.ok) {
      const d = (await res.json()) as FeeSettings;
      setS(d);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
      if (!d.feeChoiceRequired) window.dispatchEvent(new Event("aox:fee-choice-made"));
    } else {
      setS(prev);
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not save.");
    }
  }

  if (!s) {
    return <div className="mt-6 bg-white rounded-xl border border-app-border p-5 text-sm text-text-muted">Loading fee settings…</div>;
  }

  const policyFor = (pp: boolean, pf: boolean): FeePolicy => ({
    passProcessing: pp, passPlatform: pf, platformRate: s.platformRate, platformFixedCents: s.platformFixedCents,
  });
  const current = quoteCharge(10000, policyFor(s.passProcessingFees, s.passPlatformFee));
  const combos: { pp: boolean; pf: boolean; label: string }[] = [
    { pp: false, pf: false, label: "Club covers both fees" },
    { pp: true, pf: false, label: "Member covers processing" },
    { pp: false, pf: true, label: "Member covers platform fee" },
    { pp: true, pf: true, label: "Member covers both fees" },
  ];
  const showBanner = s.feeChoiceRequired || params.get("feeChange") === "1";

  return (
    <div className="mt-6 space-y-4">
      {showBanner && s.feeChoiceRequired && (
        <div className="rounded-xl border border-brand/30 bg-brand/5 p-5">
          <h3 className="text-sm font-semibold text-text-primary">Our fee structure has changed</h3>
          <p className="text-xs text-text-muted mt-1 leading-relaxed max-w-2xl">
            AthletixOS now charges a per-transaction platform fee ({s.platformFeeDescription} on your {s.tierName} plan)
            instead of relying on the monthly subscription alone. You choose who covers it. Until you change anything,
            the defaults apply: <strong className="text-text-primary">Stripe processing is passed to the paying member</strong> and{" "}
            <strong className="text-text-primary">the platform fee is absorbed by your club</strong>. You can change these now or any time later.
          </p>
          <button
            onClick={() => patch({ confirmFeeChoice: true })}
            disabled={saving}
            className="mt-3 min-h-[44px] px-4 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Keep these settings"}
          </button>
        </div>
      )}

      <div className="bg-white rounded-xl border border-app-border p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Who pays which fee</h3>
            <p className="text-xs text-text-muted mt-1">
              Your plan: <strong className="text-text-primary">{s.tierName}</strong> · platform fee{" "}
              <strong className="text-text-primary">{s.platformFeeDescription}</strong> per card payment ·{" "}
              <a href="/dashboard/settings?section=plan" className="text-brand hover:underline">Change plan</a>
            </p>
          </div>
        </div>

        <div className="mt-4 divide-y divide-app-border border border-app-border rounded-lg">
          <FeeToggleRow
            title="Pass Stripe processing fee to members"
            detail={`Stripe's ${s.feeDescription} is added to the member's total so your club isn't charged it.`}
            checked={s.passProcessingFees}
            disabled={saving}
            onChange={(v) => patch({ passProcessingFees: v })}
          />
          <FeeToggleRow
            title="Pass AthletixOS platform fee to members"
            detail={`The ${s.platformFeeDescription} platform fee is added to the member's total instead of coming out of your payout.`}
            checked={s.passPlatformFee}
            disabled={saving}
            onChange={(v) => patch({ passPlatformFee: v })}
          />
        </div>
        <p className="text-[12px] text-text-muted mt-2">
          Applies to memberships, events, classes, products and private lessons paid by card. Discounts come off first; fees are worked out on the discounted price.
        </p>

        {/* Live preview on a $100 membership */}
        <div className="mt-5">
          <p className="text-xs font-medium text-text-primary mb-2">On a $100.00 membership</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-text-muted text-left">
                  <th className="font-medium py-1.5 pr-2">Setting</th>
                  <th className="font-medium py-1.5 px-2 text-right">Member pays</th>
                  <th className="font-medium py-1.5 pl-2 text-right">Club nets</th>
                </tr>
              </thead>
              <tbody>
                {combos.map((c) => {
                  const q = quoteCharge(10000, policyFor(c.pp, c.pf));
                  const on = c.pp === s.passProcessingFees && c.pf === s.passPlatformFee;
                  return (
                    <tr key={c.label} className={`border-t border-app-border ${on ? "bg-brand/5 font-semibold text-text-primary" : "text-text-muted"}`}>
                      <td className="py-2 pr-2">{c.label}{on ? " · current" : ""}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{formatCents(q.totalCents)}</td>
                      <td className="py-2 pl-2 text-right tabular-nums">{formatCents(q.clubNetCents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 bg-app-bg border border-app-border rounded-lg p-3 text-xs text-text-muted space-y-1">
            <p className="font-medium text-text-primary">With your current settings</p>
            <div className="flex justify-between"><span>Membership</span><span className="tabular-nums">$100.00</span></div>
            {current.surchargeCents > 0 && (
              <div className="flex justify-between"><span>{surchargeLabel(current.policy)} (paid by member)</span><span className="tabular-nums">{formatCents(current.surchargeCents)}</span></div>
            )}
            <div className="flex justify-between font-semibold text-text-primary border-t border-app-border pt-1"><span>Member pays</span><span className="tabular-nums">{formatCents(current.totalCents)}</span></div>
            <div className="flex justify-between"><span>Stripe processing</span><span className="tabular-nums">−{formatCents(current.stripeFeeCents)}</span></div>
            <div className="flex justify-between"><span>AthletixOS platform fee</span><span className="tabular-nums">−{formatCents(current.applicationFeeCents)}</span></div>
            <div className="flex justify-between font-semibold text-text-primary border-t border-app-border pt-1"><span>Your club nets</span><span className="tabular-nums">{formatCents(current.clubNetCents)}</span></div>
            <p className="pt-1 text-[12px]">Based on Stripe&apos;s standard U.S. card rate. Amex and international cards cost more, and that difference comes out of your payout.</p>
          </div>
        </div>

        {passesAnyFee(current.policy) && (
          <div className="mt-4">
            <label className="block text-xs font-medium text-text-primary mb-1">
              Explanation shown to members (optional)
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => { if ((s.processingFeeNote || "") !== note) patch({ processingFeeNote: note || null }); }}
              placeholder="e.g. A small processing fee keeps our membership prices the same for everyone."
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
              maxLength={300}
            />
          </div>
        )}
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        {saved && <p className="text-xs text-text-muted mt-2">Saved.</p>}
      </div>
    </div>
  );
}

function FeeToggleRow({ title, detail, checked, disabled, onChange }: {
  title: string; detail: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div>
        <p className="text-sm font-medium text-text-primary">{title}</p>
        <p className="text-xs text-text-muted mt-0.5 leading-relaxed max-w-xl">{detail}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition disabled:opacity-50 mt-0.5"
        style={{ background: checked ? "var(--color-primary)" : "var(--color-border)" }}
      >
        <span
          className="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform mt-0.5"
          style={{ transform: checked ? "translateX(22px)" : "translateX(2px)" }}
        />
      </button>
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
