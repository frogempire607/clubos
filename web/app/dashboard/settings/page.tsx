"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";
import ImageUpload from "@/components/ImageUpload";
import PageHeader from "@/components/PageHeader";
import { SkeletonCard } from "@/components/LoadingSkeleton";

type Club = {
  id: string;
  name: string;
  slug: string;
  sport: string | null;
  tagline: string | null;
  primaryColor: string | null;
  logoUrl: string | null;
  tier: string;
  subscriptionStatus: string | null;
  stripeSubscriptionId: string | null;
  stripeOnboardingComplete: boolean;
  stripeChargesEnabled: boolean;
  notificationPrefs: Record<string, boolean>;
  appFontFamily?: string | null;
  appTextAlign?: string | null;
  appHomeContent?: string | null;
  memberBillingVisibility?: {
    showPlan?: boolean;
    showNextBilling?: boolean;
    showPrice?: boolean;
    showInvoices?: boolean;
  } | null;
};

const SUB_STATUS_LABEL: Record<string, { label: string; bg: string; fg: string }> = {
  active:   { label: "Active",   bg: "var(--color-success)", fg: "#1F1F23" },
  trialing: { label: "Trialing", bg: "var(--color-success)", fg: "#1F1F23" },
  past_due: { label: "Past due", bg: "var(--color-warning)", fg: "#fff" },
  canceled: { label: "Canceled", bg: "var(--color-bg)",      fg: "var(--color-muted)" },
};

type Location = {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

function mapsUrl(lat: number, lng: number) {
  // Universal: works in browsers and prompts Apple Maps on iOS / Google on Android.
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

const TIERS = [
  {
    id: "growth",
    name: "Growth",
    price: "$50/mo",
    fee: "Everything you need to run your club.",
    color: "#fff",
    features: ["Up to 200 members", "1 location", "Classes, events & attendance", "Memberships & billing", "Private lessons & packages", "Direct & group messaging", "Reports & analytics", "CSV import & custom fields"],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$99/mo",
    fee: "Built for growing, professional organizations.",
    color: "#fff",
    features: ["Everything in Growth", "Unlimited members", "Up to 3 locations", "Plaid bank reconciliation", "Email & SMS messaging", "Branded iOS & Android app", "Excel & PDF exports", "Priority support"],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "$199+/mo",
    fee: "Powerful infrastructure for large-scale operations.",
    color: "var(--color-text)",
    features: ["Everything in Pro", "Unlimited locations", "Custom onboarding", "Dedicated account manager", "Enterprise reporting"],
  },
];

const NOTIFICATION_OPTIONS = [
  { key: "newMemberJoins", label: "New member joins", desc: "Email me when a member signs up or is added" },
  { key: "paymentFailed", label: "Payment failed", desc: "Alert me when a member's payment fails" },
  { key: "newBooking", label: "New booking", desc: "Email me when a member books an event" },
  { key: "dailySummary", label: "Daily summary", desc: "Receive a daily digest of activity" },
  { key: "memberInactive", label: "Member goes inactive", desc: "Alert me when a member's status changes to inactive" },
];

type ClubProfileData = {
  termForMember: string;
  termForCoach: string;
  termForClass: string;
  termForEvent: string;
  termForMembership: string;
  welcomeMessage: string | null;
  accentColor: string | null;
  portalSections: string[];
};

type LegalEntity = {
  id: string;
  name: string;
  entityType: string;
  ein: string | null;
  isDefault: boolean;
  locationId: string | null;
  location: { id: string; name: string } | null;
};

type DonationLink = {
  id: string;
  title: string;
  description: string | null;
  url: string | null;
  stripePaymentLinkId: string | null;
  active: boolean;
  legalEntityId: string | null;
  legalEntity: { id: string; name: string; entityType: string } | null;
};

export default function SettingsPage() {
  const [section, setSection] = useState<"profile" | "identity" | "plan" | "app" | "memberPortal" | "locations" | "notifications" | "security" | "legal" | "danger">("profile");
  const [club, setClub] = useState<Club | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadClub() {
    const res = await fetch("/api/club/info");
    if (res.ok) setClub(await res.json());
  }

  async function loadLocations() {
    const res = await fetch("/api/club/locations");
    if (res.ok) setLocations(await res.json());
  }

  useEffect(() => {
    Promise.all([loadClub(), loadLocations()]).then(() => setLoading(false));
  }, []);

  const NAV = [
    { id: "profile", label: "Club Profile" },
    { id: "identity", label: "Club Identity" },
    { id: "plan", label: "Plan & Billing" },
    { id: "app", label: "Branded App" },
    { id: "memberPortal", label: "Member Portal" },
    { id: "locations", label: "Locations" },
    { id: "notifications", label: "Notifications" },
    { id: "security", label: "Security" },
    { id: "legal", label: "Business & Legal" },
    { id: "danger", label: "Danger Zone" },
  ] as const;

  if (loading) return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SkeletonCard /><SkeletonCard />
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
      <PageHeader
        title="Settings"
        description="Configure your club, plan, and preferences."
      />

      <div className="flex flex-col md:flex-row gap-4 md:gap-6">
        {/* Sidebar nav — collapses to horizontal scroll on mobile */}
        <div className="w-full md:w-44 flex-shrink-0">
          <nav className="space-y-0.5 sticky top-4">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                  section === n.id
                    ? "bg-brand text-white font-medium"
                    : "text-text-muted hover:bg-app-bg"
                } ${n.id === "danger" ? (section === n.id ? "" : "text-red-600 hover:text-red-700") : ""}`}
              >
                {n.label}
              </button>
            ))}
            <div className="pt-3 border-t border-app-border mt-3 space-y-0.5">
              <Link href="/dashboard/settings/billing"
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-text-muted hover:bg-app-bg flex items-center gap-1.5">
                <span className="w-4 h-4 rounded text-[10px] flex items-center justify-center font-bold" style={{ background: "var(--color-primary)", color: "#fff" }}>S</span>
                Stripe
              </Link>
              <Link href="/dashboard/settings/branded-app"
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-text-muted hover:bg-app-bg flex items-center gap-1.5">
                <span className="w-4 h-4 rounded text-[10px] flex items-center justify-center font-bold" style={{ background: "var(--color-warning)", color: "#fff" }}>A</span>
                App Design
              </Link>
              <Link href="/dashboard/settings/email"
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-text-muted hover:bg-app-bg flex items-center gap-1.5">
                <span className="w-4 h-4 rounded text-[10px] flex items-center justify-center font-bold" style={{ background: "var(--color-primary)", color: "#fff" }}>@</span>
                Email
              </Link>
              <Link href="/dashboard/custom-fields"
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-text-muted hover:bg-app-bg block">
                Custom Fields
              </Link>
              <Link href="/dashboard/staff"
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-text-muted hover:bg-app-bg block">
                Staff
              </Link>
            </div>
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {section === "profile" && club && <ProfileSection club={club} onSaved={loadClub} />}
          {section === "identity" && <IdentitySection />}
          {section === "plan" && club && <PlanSection club={club} onSaved={loadClub} />}
          {section === "app" && club && <BrandedAppSection club={club} onSaved={loadClub} />}
          {section === "memberPortal" && club && <MemberPortalSection club={club} onSaved={loadClub} />}
          {section === "locations" && <LocationsSection locations={locations} onSaved={loadLocations} />}
          {section === "notifications" && club && <NotificationsSection prefs={club.notificationPrefs} />}
          {section === "security" && <SecuritySection />}
          {section === "legal" && <LegalSection />}
          {section === "danger" && club && <DangerSection club={club} />}
        </div>
      </div>
    </div>
  );
}

/* ─── Club Profile ─── */

function ProfileSection({ club, onSaved }: { club: Club; onSaved: () => void }) {
  const [name, setName] = useState(club.name);
  const [slug, setSlug] = useState(club.slug);
  const [sport, setSport] = useState(club.sport || "");
  const [tagline, setTagline] = useState(club.tagline || "");
  const [primaryColor, setPrimaryColor] = useState(club.primaryColor || "#6D5DF6");
  const [logoUrl, setLogoUrl] = useState(club.logoUrl || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Re-hydrate inputs whenever the parent reloads the club (e.g. after Save
  // or when the user navigates back to this tab). Without this, useState
  // keeps its first-mount value and a saved field can look unchanged.
  useEffect(() => {
    setName(club.name);
    setSlug(club.slug);
    setSport(club.sport || "");
    setTagline(club.tagline || "");
    setPrimaryColor(club.primaryColor || "#6D5DF6");
    setLogoUrl(club.logoUrl || "");
  }, [club.id, club.name, club.slug, club.sport, club.tagline, club.primaryColor, club.logoUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess(false);
    const res = await fetch("/api/club/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        slug,
        sport: sport || null,
        tagline: tagline || null,
        primaryColor,
        logoUrl: logoUrl || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Save failed");
      return;
    }
    setSuccess(true);
    onSaved();
    setTimeout(() => setSuccess(false), 2000);
  }

  return (
    <div className="bg-white rounded-xl border border-app-border p-6">
      <h2 className="text-base font-semibold text-text-primary mb-1">Club Profile</h2>
      <p className="text-sm text-text-muted mb-4">
        Basic profile info. For your About Us, cover image, hours, contact info,
        and social links, open the{" "}
        <Link href="/dashboard/settings/club" className="underline text-text-primary">
          full club profile editor
        </Link>.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Club name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Club URL</label>
          <div className="flex items-center border border-app-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-stone-900">
            <span className="px-3 py-2 bg-app-bg text-text-muted text-sm border-r border-app-border flex-shrink-0">
              athletix-os.com/
            </span>
            <input type="text" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} required
              className="flex-1 px-3 py-2 text-sm focus:outline-none" />
          </div>
          <p className="text-xs text-text-muted mt-1">Members use this URL to find and join your club</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Sport</label>
            <select value={sport} onChange={(e) => setSport(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
              <option value="">Select a sport…</option>
              {["American Football","Baseball","Basketball","Boxing","Brazilian Jiu-Jitsu","Golf","Gymnastics","Hockey","Judo","Karate","Kickboxing","Lacrosse","Mixed Martial Arts (MMA)","Muay Thai","Soccer","Softball","Swimming","Taekwondo","Tennis","Track & Field","Volleyball","Wrestling"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Brand color</label>
            <div className="flex items-center gap-2">
              <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)}
                className="w-10 h-9 rounded border border-app-border cursor-pointer p-0.5" />
              <input type="text" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)}
                className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm font-mono focus:outline-none" maxLength={7} />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Tagline</label>
          <input type="text" value={tagline} onChange={(e) => setTagline(e.target.value)}
            placeholder="Train hard, compete harder"
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
        </div>

        <div>
          <ImageUpload
            label="Club logo"
            value={logoUrl || null}
            onChange={(v) => setLogoUrl(v || "")}
            shape="square"
          />
          <p className="text-xs text-text-muted mt-1">
            Used as your club&apos;s logo everywhere — dashboard, member portal,
            emails, kiosk QR screen, and the branded app icon.
          </p>
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        {success && <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">Saved!</div>}

        <div className="flex justify-end pt-2">
          <button type="submit" disabled={saving}
            className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ─── Plan & Billing ─── */

function PlanSection({ club, onSaved }: { club: Club; onSaved: () => void }) {
  const [promoCode, setPromoCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [promoError, setPromoError] = useState("");
  const [promoSuccess, setPromoSuccess] = useState("");
  const [upgradingTo, setUpgradingTo] = useState<string | null>(null);

  const currentTier = TIERS.find((t) => t.id === club.tier) || TIERS[0];

  async function applyPromo(e: React.FormEvent) {
    e.preventDefault();
    setApplying(true);
    setPromoError("");
    setPromoSuccess("");
    const res = await fetch("/api/club/tier", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promoCode: promoCode.trim() }),
    });
    setApplying(false);
    if (!res.ok) {
      const data = await res.json();
      setPromoError(data.error?.toString() || "Invalid code");
      return;
    }
    const data = await res.json();
    setPromoSuccess(`Plan upgraded to ${data.tier}!`);
    setPromoCode("");
    onSaved();
  }

  async function upgradeTo(tier: string) {
    setUpgradingTo(tier);
    // All plans are paid — changes go through Stripe Checkout. Downgrades /
    // cancellation are handled in the Stripe billing portal ("Manage in Stripe").
    const res = await fetch("/api/club/subscription/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    const data = await res.json().catch(() => ({}));
    setUpgradingTo(null);
    if (res.ok && data.url) {
      window.location.href = data.url;
    } else {
      setPromoError(typeof data.error === "string" ? data.error : "Could not start checkout");
    }
  }

  return (
    <div className="space-y-4">
      {/* Current plan */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Current Plan</p>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-2xl font-semibold text-text-primary">{currentTier.name}</h2>
              <span className="text-sm font-medium px-2 py-0.5 rounded-full" style={{ background: currentTier.color + "22", color: currentTier.color }}>
                {currentTier.price}
              </span>
              {club.subscriptionStatus && SUB_STATUS_LABEL[club.subscriptionStatus] && (
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded-full"
                  style={{
                    background: SUB_STATUS_LABEL[club.subscriptionStatus].bg,
                    color: SUB_STATUS_LABEL[club.subscriptionStatus].fg,
                  }}
                >
                  {SUB_STATUS_LABEL[club.subscriptionStatus].label}
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-0.5">{currentTier.fee}</p>
            <p className="text-xs text-text-muted mt-1">
              Billing is managed in Stripe — changes here and on the{" "}
              <Link href="/dashboard/settings/billing" className="underline">Payments &amp; billing</Link>{" "}
              page always reflect your live Stripe subscription.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold" style={{ background: currentTier.color + "22", color: currentTier.color }}>
              {currentTier.name[0]}
            </div>
            {club.stripeSubscriptionId && (
              <button
                onClick={async () => {
                  const res = await fetch("/api/club/subscription/portal", { method: "POST" });
                  const d = await res.json().catch(() => ({}));
                  if (res.ok && d.url) window.location.href = d.url;
                  else setPromoError(typeof d.error === "string" ? d.error : "Could not open billing portal");
                }}
                className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg whitespace-nowrap"
              >
                Manage in Stripe →
              </button>
            )}
          </div>
        </div>
        <ul className="space-y-1.5">
          {currentTier.features.map((f) => (
            <li key={f} className="flex items-center gap-2 text-sm text-text-primary">
              <span className="text-lime-accent text-xs">✓</span> {f}
            </li>
          ))}
        </ul>
      </div>

      {/* Promo code */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Promo / Partner Code</h3>
        <p className="text-xs text-text-muted mb-3">Have a code? Enter it to unlock a plan for free.</p>
        <form onSubmit={applyPromo} className="flex gap-2">
          <input
            type="text"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            placeholder="XXXX-XXXX"
            className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <button type="submit" disabled={applying || !promoCode.trim()}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
            {applying ? "Applying…" : "Apply"}
          </button>
        </form>
        {promoError && <p className="text-sm text-red-600 mt-2">{promoError}</p>}
        {promoSuccess && <p className="text-sm text-text-primary mt-2">{promoSuccess}</p>}
      </div>

      {/* Available plans */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <h3 className="text-sm font-semibold text-text-primary mb-4">All Plans</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TIERS.map((tier) => {
            const isCurrent = tier.id === club.tier;
            return (
              <div
                key={tier.id}
                className={`border rounded-lg p-4 transition ${
                  isCurrent
                    ? "border-brand bg-app-bg"
                    : "border-app-border"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{tier.name}</p>
                    <p className="text-xs text-text-muted">{tier.price}</p>
                  </div>
                  {isCurrent ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand text-white font-medium">Current</span>
                  ) : (
                    <button
                      onClick={() => upgradeTo(tier.id)}
                      disabled={upgradingTo === tier.id}
                      className="text-xs px-2.5 py-1 rounded-md border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      {upgradingTo === tier.id ? "…" : "Subscribe"}
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-text-muted">{tier.fee}</p>
                <ul className="mt-2 space-y-0.5">
                  {tier.features.slice(0, 3).map((f) => (
                    <li key={f} className="text-[10px] text-text-muted flex items-start gap-1">
                      <span className="text-lime-accent mt-px">✓</span> {f}
                    </li>
                  ))}
                  {tier.features.length > 3 && (
                    <li className="text-[10px] text-text-muted">+{tier.features.length - 3} more…</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-text-muted mt-4">
          Billing is managed through Stripe. Switching plans takes effect immediately.
          Contact support for custom pricing.
        </p>
      </div>

      <Link
        href="/dashboard/settings/diagnostics"
        className="block text-xs text-text-muted hover:text-text-primary underline"
      >
        Stripe diagnostics →
      </Link>
    </div>
  );
}

/* ─── Member Portal — owner controls for what members see ─── */

function MemberPortalSection({ club, onSaved }: { club: Club; onSaved: () => void }) {
  // Owner toggles for which billing details show on /member/profile. All on
  // by default; null/missing on the club row means "show everything".
  const initial = club.memberBillingVisibility ?? {};
  const [showPlan,        setShowPlan]        = useState<boolean>(initial.showPlan        ?? true);
  const [showNextBilling, setShowNextBilling] = useState<boolean>(initial.showNextBilling ?? true);
  const [showPrice,       setShowPrice]       = useState<boolean>(initial.showPrice       ?? true);
  const [showInvoices,    setShowInvoices]    = useState<boolean>(initial.showInvoices    ?? true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    const res = await fetch("/api/club/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // /api/club/update requires name + slug; we resend them so the request
      // validates without touching them.
      body: JSON.stringify({
        name: club.name,
        slug: club.slug,
        memberBillingVisibility: { showPlan, showNextBilling, showPrice, showInvoices },
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    setSaved(true);
    onSaved();
    setTimeout(() => setSaved(false), 2000);
  }

  const rows = [
    { state: showPlan,        set: setShowPlan,        label: "Plan name",         desc: "Show the active membership name on the member's profile." },
    { state: showNextBilling, set: setShowNextBilling, label: "Next billing date", desc: "Show when the next charge is scheduled." },
    { state: showPrice,       set: setShowPrice,       label: "Plan price",        desc: "Show the recurring price of the plan." },
    { state: showInvoices,    set: setShowInvoices,    label: "Invoice history",   desc: "Surface a 'View invoices' link to their Stripe billing portal." },
  ];

  return (
    <div className="bg-white rounded-xl border border-app-border p-6 space-y-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">Member Portal</h2>
        <p className="text-sm text-text-muted">
          Control what members can see when they log in. Useful when you handle billing
          offline and don&apos;t want members to see prices or charge dates.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-2">Billing visibility</h3>
        <p className="text-xs text-text-muted mb-3">
          Owners and staff always see everything in the dashboard. These toggles only
          affect what shows on <code className="px-1 py-0.5 bg-app-bg rounded text-[11px]">/member/profile</code>.
        </p>
        <div className="space-y-2">
          {rows.map((row) => (
            <label key={row.label} className="flex items-start gap-3 p-3 border border-app-border rounded-lg hover:bg-app-bg cursor-pointer">
              <input
                type="checkbox"
                checked={row.state}
                onChange={(e) => row.set(e.target.checked)}
                className="mt-1"
              />
              <span className="flex-1">
                <span className="text-sm font-medium text-text-primary block">{row.label}</span>
                <span className="text-xs text-text-muted">{row.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-lg bg-app-bg border border-app-border p-3 text-xs text-text-muted">
        Looking for more portal controls? <Link href="/dashboard/settings/club" className="underline text-text-primary">
          Full club profile (banner, hours, contact, about)
        </Link> · <Link href="/dashboard/settings/branded-app" className="underline text-text-primary">
          Branded app appearance
        </Link>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      {saved && <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">Saved.</div>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

/* ─── Locations ─── */

function LocationsSection({ locations, onSaved }: { locations: Location[]; onSaved: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);

  async function handleDelete(id: string) {
    if (!confirm("Remove this location?")) return;
    await fetch(`/api/club/locations/${id}`, { method: "DELETE" });
    onSaved();
  }

  return (
    <div className="bg-white rounded-xl border border-app-border p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold text-text-primary">Locations</h2>
        <button onClick={() => setShowAdd(true)}
          className="px-3 py-1.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
          + Add location
        </button>
      </div>

      {locations.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-sm text-text-muted mb-3">No locations added yet.</p>
          <button onClick={() => setShowAdd(true)}
            className="text-sm text-text-muted underline">Add your first location</button>
        </div>
      ) : (
        <div className="space-y-2">
          {locations.map((loc) => (
            <div key={loc.id} className="flex items-center gap-3 p-3 border border-app-border rounded-lg">
              <div className="w-8 h-8 rounded-md bg-app-bg flex items-center justify-center text-text-muted text-xs font-bold flex-shrink-0">
                {loc.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{loc.name}</p>
                {loc.address && <p className="text-xs text-text-muted">{loc.address}</p>}
                {loc.latitude != null && loc.longitude != null && (
                  <a
                    href={mapsUrl(loc.latitude, loc.longitude)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                  >
                    <MapPin className="h-3 w-3" strokeWidth={2} /> Open in Maps
                  </a>
                )}
              </div>
              <div className="flex gap-1">
                <button onClick={() => setEditing(loc)}
                  className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                  Edit
                </button>
                <button onClick={() => handleDelete(loc.id)}
                  className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(showAdd || editing) && (
        <LocationModal
          location={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); onSaved(); }}
        />
      )}
    </div>
  );
}

function LocationModal({
  location,
  onClose,
  onSaved,
}: {
  location: Location | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!location;
  const [name, setName] = useState(location?.name || "");
  const [address, setAddress] = useState(location?.address || "");
  const [latitude, setLatitude] = useState(location?.latitude != null ? String(location.latitude) : "");
  const [longitude, setLongitude] = useState(location?.longitude != null ? String(location.longitude) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const lat = latitude.trim() ? Number(latitude) : null;
    const lng = longitude.trim() ? Number(longitude) : null;
    if ((lat != null && Number.isNaN(lat)) || (lng != null && Number.isNaN(lng))) {
      setError("Latitude and longitude must be numbers.");
      return;
    }
    if ((lat == null) !== (lng == null)) {
      setError("Enter both latitude and longitude, or leave both blank.");
      return;
    }
    setSaving(true);
    const url = isEdit ? `/api/club/locations/${location!.id}` : "/api/club/locations";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, address: address || null, latitude: lat, longitude: lng }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Save failed");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit location" : "Add location"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
              placeholder="Main Gym, Annex, Competition Hall…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Address (optional)</label>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder="123 Main St, City, State"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              GPS coordinates (optional)
            </label>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)}
                placeholder="Latitude e.g. 40.7128"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
              <input type="text" inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)}
                placeholder="Longitude e.g. -74.0060"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <p className="text-[11px] text-text-muted mt-1">
              Adds an &quot;Open in Maps&quot; link (Apple/Google) for members. Tip: right-click a spot in Google Maps to copy its lat, long.
            </p>
            {latitude.trim() && longitude.trim() && !Number.isNaN(Number(latitude)) && !Number.isNaN(Number(longitude)) && (
              <a
                href={mapsUrl(Number(latitude), Number(longitude))}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-brand hover:underline mt-1 inline-block"
              >
                Preview on map →
              </a>
            )}
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save" : "Add location"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Notifications ─── */

function NotificationsSection({ prefs }: { prefs: Record<string, boolean> }) {
  const [values, setValues] = useState<Record<string, boolean>>({
    newMemberJoins: true,
    paymentFailed: true,
    newBooking: false,
    dailySummary: false,
    memberInactive: false,
    ...prefs,
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  async function toggle(key: string) {
    const newVal = { ...values, [key]: !values[key] };
    setValues(newVal);
    setSaving(true);
    await fetch("/api/club/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: !values[key] }),
    });
    setSaving(false);
    setSuccess(true);
    setTimeout(() => setSuccess(false), 1500);
  }

  return (
    <div className="bg-white rounded-xl border border-app-border p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Notifications</h2>
          <p className="text-xs text-text-muted mt-0.5">Email alerts sent to your account email</p>
        </div>
        {success && <span className="text-xs text-lime-accent">Saved</span>}
      </div>

      <div className="space-y-4">
        {NOTIFICATION_OPTIONS.map((opt) => (
          <label key={opt.key} className="flex items-start gap-3 cursor-pointer group">
            <div className="flex-1">
              <p className="text-sm font-medium text-text-primary">{opt.label}</p>
              <p className="text-xs text-text-muted">{opt.desc}</p>
            </div>
            <button
              type="button"
              onClick={() => toggle(opt.key)}
              className={`relative w-10 h-5.5 rounded-full transition-colors flex-shrink-0 mt-0.5 ${
                values[opt.key] ? "bg-brand" : "bg-app-border"
              }`}
              style={{ height: 22, width: 40 }}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  values[opt.key] ? "translate-x-[18px]" : "translate-x-0"
                }`}
              />
            </button>
          </label>
        ))}
      </div>

      <p className="text-xs text-text-muted mt-6 pt-4 border-t border-app-border">
        Push notifications and SMS alerts are available on Pro and Enterprise plans.
      </p>
    </div>
  );
}

/* ─── Branded App ─── */

function BrandedAppSection({ club, onSaved }: { club: Club; onSaved: () => void }) {
  const [logoUrl, setLogoUrl] = useState(club.logoUrl || "");
  const [appFontFamily, setAppFontFamily] = useState(club.appFontFamily || "");
  const [appTextAlign, setAppTextAlign] = useState<string>(club.appTextAlign || "left");
  const [appHomeContent, setAppHomeContent] = useState(club.appHomeContent || "");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const isPro = ["pro", "enterprise"].includes(club.tier);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch("/api/club/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // name+slug are required by the schema. Pass them through unchanged
      // so this section can save its own subset of fields independently.
      body: JSON.stringify({
        name: club.name,
        slug: club.slug,
        logoUrl: logoUrl || null,
        appFontFamily: appFontFamily || null,
        appTextAlign: appTextAlign || null,
        appHomeContent: appHomeContent || null,
      }),
    });
    setSaving(false);
    if (res.ok) { setSuccess(true); onSaved(); setTimeout(() => setSuccess(false), 2000); }
  }

  const FONT_PRESETS = [
    { value: "", label: "Default (Inter)" },
    { value: "'Inter', system-ui, sans-serif", label: "Inter (clean modern)" },
    { value: "'Poppins', system-ui, sans-serif", label: "Poppins (rounded)" },
    { value: "Georgia, 'Times New Roman', serif", label: "Georgia (classic serif)" },
    { value: "'Courier New', monospace", label: "Courier (mono)" },
    { value: "system-ui, -apple-system, sans-serif", label: "System default" },
  ];

  return (
    <div className="space-y-4">
      {/* Launch guide intro */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Launch your branded app</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Two ways to put {club.name} in your members&apos; pockets — start with one, do both over time.
            </p>
          </div>
          <a
            href="/dashboard/settings/branded-app"
            className="text-xs px-3 py-2 rounded-lg bg-brand text-white font-medium hover:bg-brand-hover whitespace-nowrap flex-shrink-0"
          >
            Open App Design editor →
          </a>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="border border-app-border rounded-lg p-4 bg-app-bg">
            <p className="text-sm font-semibold text-text-primary">1 · Instant web app (PWA)</p>
            <p className="text-[11px] text-text-muted mt-1">
              Live right now — members add your portal to their home screen in about 10 seconds. No app store, no waiting. The fastest way to start today.
            </p>
          </div>
          <div className="border border-app-border rounded-lg p-4 bg-app-bg">
            <p className="text-sm font-semibold text-text-primary">2 · Native iOS + Android app</p>
            <p className="text-[11px] text-text-muted mt-1">
              A dedicated app under your club&apos;s name in the App Store and Google Play. Follow the step-by-step below — AthletixOS handles the build and submission.
            </p>
          </div>
        </div>
      </div>

      {/* PWA Status */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Progressive Web App</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Your member portal is already installable on iPhone and Android — no app store needed.
            </p>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-lime-accent text-text-primary font-medium flex-shrink-0">Live</span>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: "Installable", desc: "Members tap 'Add to Home Screen'" },
            { label: "Offline ready", desc: "Cached pages load without internet" },
            { label: "Native feel", desc: "Full-screen, no browser chrome" },
          ].map((f) => (
            <div key={f.label} className="bg-app-bg rounded-lg p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-lime-accent text-xs">✓</span>
                <p className="text-xs font-semibold text-text-primary">{f.label}</p>
              </div>
              <p className="text-[10px] text-text-muted">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="border border-app-border rounded-lg p-4 bg-app-bg">
          <p className="text-xs font-semibold text-text-primary mb-2">How members install it</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-text-muted mb-1">iPhone (Safari)</p>
              <ol className="text-[11px] text-text-muted space-y-0.5 list-decimal list-inside">
                <li>Open member portal in Safari</li>
                <li>Tap the Share button (box with arrow)</li>
                <li>Tap "Add to Home Screen"</li>
                <li>Tap "Add"</li>
              </ol>
            </div>
            <div>
              <p className="text-xs font-medium text-text-muted mb-1">Android (Chrome)</p>
              <ol className="text-[11px] text-text-muted space-y-0.5 list-decimal list-inside">
                <li>Open member portal in Chrome</li>
                <li>Tap the "Install app" banner</li>
                <li>Or tap the three-dot menu → "Add to Home Screen"</li>
                <li>Tap "Install"</li>
              </ol>
            </div>
          </div>
          <p className="text-[11px] text-text-muted mt-3">
            Member portal URL:{" "}
            <span className="font-mono">
              {typeof window !== "undefined" ? `${window.location.origin}/member` : "/member"}
            </span>{" "}
            — share this link (or its QR code) so members can install it.
          </p>
        </div>
      </div>

      {/* App Icon & Branding */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">App Icon</h2>
        <p className="text-xs text-text-muted mb-4">
          Your club logo doubles as the app icon when members install the portal.
          Recommended: square, 512×512px minimum, PNG or SVG.
        </p>
        <form onSubmit={handleSave} className="space-y-3">
          <ImageUpload
            label="App icon"
            value={logoUrl || null}
            onChange={(v) => setLogoUrl(v || "")}
            shape="square"
          />
          <div>
            <p className="text-[11px] text-text-muted mt-1">
              Same image as your club logo on the Club Profile page — change in
              either place and it updates everywhere.
            </p>
          </div>
          {success && <p className="text-sm text-text-primary">Saved!</p>}
          <div className="flex justify-end">
            <button type="submit" disabled={saving}
              className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : "Save icon"}
            </button>
          </div>
        </form>
      </div>

      {/* Personalization — font, text alignment, home content */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">Personalization</h2>
        <p className="text-xs text-text-muted mb-4">
          Style the branded member portal. Anything you set on Club Profile
          (name, tagline, About, contact info, logo, primary color) is already
          pulled in automatically — these settings layer on top.
        </p>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Font</label>
              <select
                value={appFontFamily}
                onChange={(e) => setAppFontFamily(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white"
              >
                {FONT_PRESETS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              <div
                className="mt-2 px-3 py-2 border border-app-border rounded-lg text-sm bg-app-bg"
                style={{ fontFamily: appFontFamily || undefined }}
              >
                Aa — preview your members will see.
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Text alignment</label>
              <div className="flex gap-2">
                {(["left", "center", "right"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAppTextAlign(a)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                      appTextAlign === a
                        ? "border-brand bg-brand text-white"
                        : "border-app-border text-text-muted hover:bg-app-bg"
                    }`}
                  >
                    {a.charAt(0).toUpperCase() + a.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Home welcome content</label>
            <textarea
              value={appHomeContent}
              onChange={(e) => setAppHomeContent(e.target.value)}
              rows={4}
              maxLength={5000}
              placeholder="A short welcome paragraph members see on the portal home — practice tips, weekly focus, current news…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm"
              style={{ fontFamily: appFontFamily || undefined, textAlign: appTextAlign as "left" | "center" | "right" }}
            />
            <p className="text-[11px] text-text-muted mt-1">
              Plain text. Renders on the member portal Home above the schedule.
            </p>
          </div>

          {success && <p className="text-sm text-text-primary">Saved!</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save personalization"}
            </button>
          </div>
        </form>
      </div>

      {/* Native app launch guide */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-base font-semibold text-text-primary">Get your native iOS &amp; Android app</h2>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
            isPro ? "bg-brand/10 text-brand" : "bg-app-bg text-text-muted"
          }`}>
            {isPro ? "Included on your plan" : "Pro / Enterprise"}
          </span>
        </div>
        <p className="text-xs text-text-muted mb-4">
          Your app is a branded wrapper around your live member portal, so once it&apos;s on the
          stores it updates automatically whenever you change something here — you almost never
          have to resubmit. Here&apos;s exactly how it gets launched.
        </p>

        <ol className="space-y-3">
          {[
            {
              n: "1",
              who: "You",
              title: "Design your app",
              body: (
                <>
                  Set your icon, splash screen, colors, and screens in the{" "}
                  <a href="/dashboard/settings/branded-app" className="text-brand hover:underline">App Design editor</a>.
                  This is what members see when they open the app.
                </>
              ),
            },
            {
              n: "2",
              who: "You · one-time",
              title: "Create your store accounts",
              body: (
                <>
                  Apps publish under your club&apos;s own developer accounts so you fully own the
                  listings:{" "}
                  <a href="https://developer.apple.com/programs/enroll/" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Apple Developer Program</a>{" "}
                  ($99/year) and{" "}
                  <a href="https://play.google.com/console/signup" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Google Play Console</a>{" "}
                  ($25 one-time). Apple can take 1–2 days to verify a business, so start this early.
                </>
              ),
            },
            {
              n: "3",
              who: "You",
              title: "Invite AthletixOS as a developer",
              body: (
                <>
                  Add us to your Apple and Google accounts (we send exact click-by-click
                  instructions) so we can upload and manage builds. You stay the owner and can
                  remove our access anytime.
                </>
              ),
            },
            {
              n: "4",
              who: "AthletixOS",
              title: "We build and submit",
              body: (
                <>
                  We package your designed app, prepare the store listing (name, icon,
                  screenshots, description), and submit it to both stores. Nothing technical on
                  your end.
                </>
              ),
            },
            {
              n: "5",
              who: "Apple / Google",
              title: "Review and go live",
              body: (
                <>
                  Apple review is usually ~24–48 hours; Google is often a few hours to a day. We
                  let you know the moment each app is approved and live.
                </>
              ),
            },
          ].map((step) => (
            <li key={step.n} className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand/10 text-brand text-xs font-semibold flex items-center justify-center">
                {step.n}
              </span>
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {step.title}
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-app-bg text-text-muted font-medium align-middle">
                    {step.who}
                  </span>
                </p>
                <p className="text-xs text-text-muted mt-0.5">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-5 flex flex-col sm:flex-row gap-2">
          <a
            href="mailto:support@athletix-os.com?subject=Branded%20app%20launch%20request"
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover text-center"
          >
            Request my app launch
          </a>
          <a
            href="/dashboard/settings/branded-app"
            className="px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg text-center"
          >
            Design my app first
          </a>
        </div>
        {!isPro && (
          <p className="mt-3 text-xs text-text-muted border-t border-app-border pt-3">
            Native publishing is included on Pro and Enterprise plans. The instant web app (PWA)
            above works on every plan.
          </p>
        )}
      </div>
    </div>
  );
}

/* ─── Club Identity ─── */

const PORTAL_SECTION_OPTIONS = [
  { key: "schedule", label: "Schedule / Bookings" },
  { key: "documents", label: "Documents" },
  { key: "profile", label: "My Profile" },
  { key: "messages", label: "Messages" },
];

function IdentitySection() {
  const [data, setData] = useState<ClubProfileData | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/club/profile")
      .then((r) => r.json())
      .then(setData);
  }, []);

  function update(field: keyof ClubProfileData, value: string | string[] | null) {
    if (!data) return;
    setData({ ...data, [field]: value });
  }

  function toggleSection(key: string) {
    if (!data) return;
    const current = data.portalSections;
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    setData({ ...data, portalSections: next });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setSaving(true);
    setError("");
    const res = await fetch("/api/club/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setError(d.error?.toString() || "Save failed");
      return;
    }
    setSuccess(true);
    setTimeout(() => setSuccess(false), 2000);
  }

  if (!data) return <div className="text-sm text-text-muted py-8 text-center">Loading…</div>;

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="bg-white rounded-xl border border-app-border p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">Custom Terminology</h2>
        <p className="text-xs text-text-muted mb-5">
          Rename these nouns to match your sport. Members see these labels throughout the portal.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(["termForMember","termForCoach","termForClass","termForEvent","termForMembership"] as const).map((field) => {
            const labels: Record<string, string> = {
              termForMember: "Member", termForCoach: "Coach", termForClass: "Class",
              termForEvent: "Event", termForMembership: "Membership",
            };
            const placeholders: Record<string, string> = {
              termForMember: "Athlete, Student, Player…", termForCoach: "Instructor, Trainer…",
              termForClass: "Practice, Session…", termForEvent: "Competition, Meet…",
              termForMembership: "Plan, Subscription…",
            };
            return (
              <div key={field}>
                <label className="block text-xs font-medium text-text-muted mb-1 uppercase tracking-wider">
                  {labels[field]}
                </label>
                <input
                  type="text"
                  value={data[field] as string}
                  onChange={(e) => update(field, e.target.value)}
                  placeholder={placeholders[field]}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-app-border p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">Welcome Message</h2>
        <p className="text-xs text-text-muted mb-3">Shown to members on their portal home screen.</p>
        <textarea
          value={data.welcomeMessage || ""}
          onChange={(e) => update("welcomeMessage", e.target.value || null)}
          rows={3}
          maxLength={500}
          placeholder="Welcome to our club! Check your schedule and upcoming events below."
          className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none"
        />
        <p className="text-xs text-text-muted mt-1">{(data.welcomeMessage || "").length}/500</p>
      </div>

      <div className="bg-white rounded-xl border border-app-border p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">Member Portal Sections</h2>
        <p className="text-xs text-text-muted mb-4">Choose which tabs appear in the member portal sidebar.</p>
        <div className="space-y-2">
          {PORTAL_SECTION_OPTIONS.map((opt) => {
            const enabled = data.portalSections.includes(opt.key);
            return (
              <label key={opt.key} className="flex items-center gap-3 cursor-pointer">
                <button
                  type="button"
                  onClick={() => toggleSection(opt.key)}
                  className={`relative flex-shrink-0 rounded-full transition-colors`}
                  style={{ width: 40, height: 22, background: enabled ? "var(--color-primary)" : "var(--color-border)" }}
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
                    style={{ transform: enabled ? "translateX(18px)" : "translateX(0)" }}
                  />
                </button>
                <span className="text-sm text-text-primary">{opt.label}</span>
              </label>
            );
          })}
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      {success && <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">Saved!</div>}

      <div className="flex justify-end">
        <button type="submit" disabled={saving}
          className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/* ─── Business & Legal ─── */

const ENTITY_TYPE_LABELS: Record<string, string> = {
  LLC: "LLC",
  CORP: "Corporation",
  SOLE_PROP: "Sole Proprietor",
  NONPROFIT: "Nonprofit",
  OTHER: "Other",
};

const ENTITY_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  NONPROFIT: { bg: "var(--color-success)", fg: "#1F1F23" },
  LLC: { bg: "var(--color-primary)", fg: "#fff" },
  CORP: { bg: "var(--color-primary)", fg: "#fff" },
  SOLE_PROP: { bg: "var(--color-warning)", fg: "#fff" },
  OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

function LegalSection() {
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [donationLinks, setDonationLinks] = useState<DonationLink[]>([]);
  const [showEntityForm, setShowEntityForm] = useState(false);
  const [editingEntity, setEditingEntity] = useState<LegalEntity | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editingLink, setEditingLink] = useState<DonationLink | null>(null);

  const hasNonprofit = entities.some((e) => e.entityType === "NONPROFIT");

  async function load() {
    const [eRes, dRes] = await Promise.all([
      fetch("/api/club/legal-entities"),
      fetch("/api/club/donation-links"),
    ]);
    if (eRes.ok) setEntities(await eRes.json());
    if (dRes.ok) setDonationLinks(await dRes.json());
  }

  useEffect(() => { load(); }, []);

  async function deleteEntity(id: string) {
    if (!confirm("Remove this legal entity?")) return;
    await fetch(`/api/club/legal-entities/${id}`, { method: "DELETE" });
    load();
  }

  async function deleteLink(id: string) {
    if (!confirm("Remove this donation link?")) return;
    await fetch(`/api/club/donation-links/${id}`, { method: "DELETE" });
    load();
  }

  async function toggleLink(link: DonationLink) {
    await fetch(`/api/club/donation-links/${link.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !link.active }),
    });
    load();
  }

  return (
    <div className="space-y-4">
      {/* Legal Entities */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Legal Entities</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Add your business structure. Nonprofits unlock donation links on any plan.
            </p>
          </div>
          <button
            onClick={() => { setEditingEntity(null); setShowEntityForm(true); }}
            className="px-3 py-1.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover flex-shrink-0"
          >
            + Add entity
          </button>
        </div>

        {entities.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm text-text-muted">No legal entities added yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {entities.map((e) => {
              const c = ENTITY_TYPE_COLORS[e.entityType] || ENTITY_TYPE_COLORS.OTHER;
              return (
                <div key={e.id} className="flex items-center gap-3 p-3 border border-app-border rounded-lg">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                    style={{ background: c.bg, color: c.fg }}>
                    {ENTITY_TYPE_LABELS[e.entityType]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-text-primary">{e.name}</p>
                      {e.isDefault && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg text-text-muted font-medium">Default</span>
                      )}
                    </div>
                    <div className="flex gap-2 text-xs text-text-muted mt-0.5">
                      {e.ein && <span>EIN: {e.ein}</span>}
                      {e.location && <span>· {e.location.name}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => { setEditingEntity(e); setShowEntityForm(true); }}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                      Edit
                    </button>
                    <button onClick={() => deleteEntity(e.id)}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Donation Links */}
      <div className="bg-white rounded-xl border border-app-border p-6">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Donation Links</h2>
            <p className="text-xs text-text-muted mt-0.5">
              {hasNonprofit
                ? "Share these links so supporters can donate to your nonprofit."
                : "Add a Nonprofit legal entity above to enable donation links."}
            </p>
          </div>
          {hasNonprofit && (
            <button
              onClick={() => { setEditingLink(null); setShowLinkForm(true); }}
              className="px-3 py-1.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover flex-shrink-0"
            >
              + Add link
            </button>
          )}
        </div>

        {!hasNonprofit ? (
          <div className="bg-app-bg border border-app-border rounded-lg p-4 text-center">
            <p className="text-sm text-text-muted">
              Donation links are available to any club with a <strong>Nonprofit</strong> legal entity — on any plan.
            </p>
          </div>
        ) : donationLinks.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm text-text-muted">No donation links yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {donationLinks.map((link) => (
              <div key={link.id} className="flex items-center gap-3 p-3 border border-app-border rounded-lg">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-text-primary">{link.title}</p>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                      link.active ? "bg-lime-accent text-text-primary" : "bg-app-bg text-text-muted"
                    }`}>
                      {link.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  {link.description && <p className="text-xs text-text-muted mt-0.5 truncate">{link.description}</p>}
                  {(link.url || link.stripePaymentLinkId) && (
                    <p className="text-xs text-text-muted mt-0.5 font-mono truncate">
                      {link.url || `Stripe: ${link.stripePaymentLinkId}`}
                    </p>
                  )}
                  {link.legalEntity && (
                    <p className="text-xs text-text-muted mt-0.5">Entity: {link.legalEntity.name}</p>
                  )}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => toggleLink(link)}
                    className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                    {link.active ? "Deactivate" : "Activate"}
                  </button>
                  <button onClick={() => { setEditingLink(link); setShowLinkForm(true); }}
                    className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                    Edit
                  </button>
                  <button onClick={() => deleteLink(link.id)}
                    className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showEntityForm && (
        <EntityModal
          entity={editingEntity}
          onClose={() => { setShowEntityForm(false); setEditingEntity(null); }}
          onSaved={() => { setShowEntityForm(false); setEditingEntity(null); load(); }}
        />
      )}

      {showLinkForm && (
        <DonationLinkModal
          link={editingLink}
          entities={entities.filter((e) => e.entityType === "NONPROFIT")}
          onClose={() => { setShowLinkForm(false); setEditingLink(null); }}
          onSaved={() => { setShowLinkForm(false); setEditingLink(null); load(); }}
        />
      )}
    </div>
  );
}

function EntityModal({ entity, onClose, onSaved }: { entity: LegalEntity | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!entity;
  const [name, setName] = useState(entity?.name || "");
  const [entityType, setEntityType] = useState(entity?.entityType || "LLC");
  const [ein, setEin] = useState(entity?.ein || "");
  const [isDefault, setIsDefault] = useState(entity?.isDefault || false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const url = isEdit ? `/api/club/legal-entities/${entity!.id}` : "/api/club/legal-entities";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, entityType, ein: ein || null, isDefault }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setError(d.error?.toString() || "Save failed");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit entity" : "Add legal entity"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Entity name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
              placeholder="Apex Wrestling LLC"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Entity type</label>
            <select value={entityType} onChange={(e) => setEntityType(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
              {Object.entries(ENTITY_TYPE_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
            {entityType === "NONPROFIT" && (
              <p className="text-xs text-text-primary mt-1.5 bg-lime-accent px-2 py-1 rounded">
                Nonprofit entities unlock donation links on any plan.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">EIN (optional)</label>
            <input type="text" value={ein} onChange={(e) => setEin(e.target.value)}
              placeholder="12-3456789"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="rounded" />
            <span className="text-sm text-text-primary">Set as default entity</span>
          </label>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save" : "Add entity"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DonationLinkModal({
  link,
  entities,
  onClose,
  onSaved,
}: {
  link: DonationLink | null;
  entities: LegalEntity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!link;
  const [title, setTitle] = useState(link?.title || "");
  const [description, setDescription] = useState(link?.description || "");
  const [url, setUrl] = useState(link?.url || "");
  const [stripeId, setStripeId] = useState(link?.stripePaymentLinkId || "");
  const [legalEntityId, setLegalEntityId] = useState(link?.legalEntityId || entities[0]?.id || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const apiUrl = isEdit ? `/api/club/donation-links/${link!.id}` : "/api/club/donation-links";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(apiUrl, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: description || null,
        url: url || null,
        stripePaymentLinkId: stripeId || null,
        legalEntityId: legalEntityId || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setError(d.error?.toString() || "Save failed");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit donation link" : "Add donation link"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required
              placeholder="Support Youth Scholarships"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description (optional)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500}
              placeholder="Help us provide free memberships to underserved youth…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Donation URL</label>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://donate.stripe.com/…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Stripe Payment Link ID (optional)</label>
            <input type="text" value={stripeId} onChange={(e) => setStripeId(e.target.value)}
              placeholder="plink_…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          {entities.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Nonprofit entity</label>
              <select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )}
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save" : "Add link"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Security ─── */

function SecuritySection() {
  const [current, setCurrent] = useState("");
  const [next, setNext]       = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setError("New passwords do not match."); return; }
    if (next.length < 8) { setError("Password must be at least 8 characters."); return; }
    setSaving(true);
    setError("");
    setSuccess(false);
    const res = await fetch("/api/auth/change-password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to change password");
      return;
    }
    setSuccess(true);
    setCurrent(""); setNext(""); setConfirm("");
    setTimeout(() => setSuccess(false), 3000);
  }

  return (
    <div className="bg-white rounded-xl border border-app-border p-6">
      <h2 className="text-base font-semibold text-text-primary mb-1">Change Password</h2>
      <p className="text-xs text-text-muted mb-5">Update the password for your account.</p>
      <form onSubmit={handleSubmit} className="space-y-4 max-w-sm">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Current password</label>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password"
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">New password</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required autoComplete="new-password" minLength={8}
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Confirm new password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password"
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        {success && <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">Password updated successfully.</div>}
        <div className="flex justify-end pt-1">
          <button type="submit" disabled={saving}
            className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
            {saving ? "Updating…" : "Update password"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ─── Danger Zone ─── */

function DangerSection({ club }: { club: Club }) {
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (confirm !== club.name) {
      setError("Club name does not match.");
      return;
    }
    setDeleting(true);
    const res = await fetch("/api/club/delete", { method: "DELETE" });
    if (res.ok) {
      window.location.href = "/login";
    } else {
      const data = await res.json();
      setError(data.error || "Failed to delete club");
      setDeleting(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-red-200 p-6">
      <h2 className="text-base font-semibold text-red-700 mb-1">Danger Zone</h2>
      <p className="text-sm text-text-muted mb-6">These actions are permanent and cannot be undone.</p>

      <div className="border border-red-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Delete club</h3>
        <p className="text-xs text-text-muted mb-4">
          This will permanently delete <strong>{club.name}</strong> and all its data — members, events, transactions, and messages.
          There is no going back.
        </p>
        <form onSubmit={handleDelete} className="space-y-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Type <strong>{club.name}</strong> to confirm:
            </label>
            <input
              type="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={club.name}
              className="w-full px-3 py-2 border border-red-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={deleting || confirm !== club.name}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40"
          >
            {deleting ? "Deleting…" : "Permanently delete club"}
          </button>
        </form>
      </div>
    </div>
  );
}
