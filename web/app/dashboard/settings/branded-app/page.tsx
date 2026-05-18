"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Config = {
  appName: string;
  shortDescription: string;
  iconUrl: string | null;
  themeColor: string;
  splashColor: string;
  iosBundleId: string;
  androidPackage: string;
  enabled: boolean;
};

export default function BrandedAppPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [clubInfo, setClubInfo] = useState<{ name: string; slug: string; tier: string } | null>(null);
  const [portalUrl, setPortalUrl] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/club/branded-app")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setCfg(d.config);
          setClubInfo(d.club);
          setPortalUrl(d.portalUrl);
          setLoginUrl(d.loginUrl);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function set<K extends keyof Config>(key: K, value: Config[K]) {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
  }

  async function uploadIcon(file: File) {
    setUploading(true);
    setError("");
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json().catch(() => ({}));
    setUploading(false);
    if (res.ok && d.url) set("iconUrl", d.url);
    else setError(d.error || "Icon upload failed");
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/club/branded-app", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (res.ok) {
      setMsg("Saved. Your build configuration below is up to date.");
      setTimeout(() => setMsg(""), 4000);
    } else {
      setError(d.error || "Could not save");
    }
  }

  if (loading) return <div className="p-8 text-sm text-text-muted">Loading…</div>;
  if (!cfg) return <div className="p-8 text-sm text-text-muted">Could not load configuration.</div>;

  const capacitorConfig = `import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: '${cfg.iosBundleId}',
  appName: '${cfg.appName.replace(/'/g, "\\'")}',
  webDir: 'public',
  server: {
    // The app is a thin native shell around your hosted member portal.
    url: '${portalUrl}',
    cleartext: false,
  },
  ios: { contentInset: 'always' },
  plugins: {
    SplashScreen: {
      backgroundColor: '${cfg.splashColor}',
      showSpinner: false,
    },
  },
};

export default config;`;

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-2">
        <Link href="/dashboard/settings" className="text-sm text-text-muted hover:text-text-primary">
          ← Settings
        </Link>
      </div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Branded mobile app</h1>
          <p className="text-sm text-text-muted mt-1">
            Customize and publish your own iOS &amp; Android app. Parents download it,
            sign in, and land in your member portal.
          </p>
        </div>
        {clubInfo && clubInfo.tier === "growth" && (
          <span className="text-xs bg-orange-accent/10 text-orange-accent rounded-full px-3 py-1 font-medium flex-shrink-0">
            Pro feature
          </span>
        )}
      </div>

      <div className="grid md:grid-cols-[1fr_280px] gap-8">
        {/* ── Form ── */}
        <div className="space-y-5">
          <Field label="App name" hint="Shown under the icon on the home screen (keep it short).">
            <input
              value={cfg.appName}
              maxLength={30}
              onChange={(e) => set("appName", e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </Field>

          <Field label="Short description" hint="Used in the App Store / Play listing.">
            <textarea
              value={cfg.shortDescription}
              maxLength={200}
              rows={2}
              onChange={(e) => set("shortDescription", e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none"
            />
          </Field>

          <Field label="App icon" hint="Square PNG, at least 1024×1024 for store submission.">
            <div className="flex items-center gap-3">
              <div
                className="w-16 h-16 rounded-2xl border border-app-border overflow-hidden flex items-center justify-center bg-app-bg flex-shrink-0"
                style={{ background: cfg.iconUrl ? undefined : cfg.themeColor }}
              >
                {cfg.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cfg.iconUrl} alt="App icon" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-white text-xl font-bold">
                    {cfg.appName.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && uploadIcon(e.target.files[0])}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="px-3 py-1.5 border border-app-border rounded-lg text-sm hover:bg-app-bg disabled:opacity-50"
                >
                  {uploading ? "Uploading…" : cfg.iconUrl ? "Replace icon" : "Upload icon"}
                </button>
              </div>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Theme color" hint="App bar / accent.">
              <ColorInput value={cfg.themeColor} onChange={(v) => set("themeColor", v)} />
            </Field>
            <Field label="Splash background" hint="Launch screen.">
              <ColorInput value={cfg.splashColor} onChange={(v) => set("splashColor", v)} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="iOS bundle ID" hint="Reverse-domain, unique on the App Store.">
              <input
                value={cfg.iosBundleId}
                onChange={(e) => set("iosBundleId", e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </Field>
            <Field label="Android package" hint="Reverse-domain, unique on Google Play.">
              <input
                value={cfg.androidPackage}
                onChange={(e) => set("androidPackage", e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
              className="accent-brand"
            />
            Mark this branded app as live (we&apos;re distributing it on the stores)
          </label>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {msg && (
            <div className="text-sm text-text-primary bg-lime-accent/15 border border-lime-accent/40 rounded-lg px-3 py-2">
              {msg}
            </div>
          )}

          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save configuration"}
          </button>
        </div>

        {/* ── Live phone preview ── */}
        <div>
          <p className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">
            Preview
          </p>
          <div className="mx-auto w-[220px] rounded-[2rem] border-[6px] border-charcoal bg-charcoal p-2 shadow-lg">
            <div
              className="rounded-[1.5rem] overflow-hidden h-[400px] flex flex-col items-center justify-center"
              style={{ background: cfg.splashColor }}
            >
              <div
                className="w-20 h-20 rounded-2xl overflow-hidden flex items-center justify-center shadow"
                style={{ background: cfg.iconUrl ? undefined : cfg.themeColor }}
              >
                {cfg.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cfg.iconUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-white text-3xl font-bold">
                    {cfg.appName.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <p
                className="mt-3 text-sm font-semibold"
                style={{ color: contrast(cfg.splashColor) }}
              >
                {cfg.appName}
              </p>
            </div>
          </div>
          <p className="text-[11px] text-text-muted text-center mt-3">
            Home-screen icon &amp; launch screen
          </p>
        </div>
      </div>

      {/* ── Generated build config ── */}
      <div className="mt-10 border-t border-app-border pt-8">
        <h2 className="text-lg font-semibold text-text-primary mb-1">Your build configuration</h2>
        <p className="text-sm text-text-muted mb-4">
          The app is a thin native shell around your hosted member portal, so the code is
          identical for every club — only this configuration changes. Copy this into the
          Capacitor project (step 3 below).
        </p>
        <pre className="bg-charcoal text-stone-100 text-xs rounded-lg p-4 overflow-x-auto leading-relaxed">
{capacitorConfig}
        </pre>
        <div className="mt-3 text-xs text-text-muted space-y-1">
          <p>Portal URL the app loads: <span className="font-mono text-text-primary">{portalUrl}</span></p>
          <p>Branded login link: <span className="font-mono text-text-primary">{loginUrl}</span></p>
        </div>
      </div>

      {/* ── Step-by-step publishing guide ── */}
      <div className="mt-10 border-t border-app-border pt-8">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          How to publish to the App Store &amp; Google Play
        </h2>

        <Callout>
          You only do steps 1–3 once. After that, publishing an update is just
          re-running the build and uploading.
        </Callout>

        <Guide
          n="1"
          title="Create the developer accounts"
          items={[
            "Apple: enroll in the Apple Developer Program — $99/year at developer.apple.com. Approval can take 24–48h.",
            "Google: create a Google Play Console account — one-time $25 at play.google.com/console.",
            "Use the club's official email; you'll manage the listing from these accounts.",
          ]}
        />
        <Guide
          n="2"
          title="Install the build tools (one-time, on a Mac for iOS)"
          items={[
            "Install Node.js 18+ and Git.",
            "iOS: install Xcode from the Mac App Store. Android: install Android Studio.",
            "Install the Capacitor CLI: npm i -g @capacitor/cli",
          ]}
        />
        <Guide
          n="3"
          title="Create the wrapper project"
          items={[
            "npm create @capacitor/app  (name it after your club)",
            "Add platforms: npx cap add ios && npx cap add android",
            "Open capacitor.config.ts and paste the configuration shown above.",
            `Set the app icon: drop your 1024×1024 PNG in and run npx @capacitor/assets generate (it creates every required size + splash using your splash color ${cfg.splashColor}).`,
          ]}
        />
        <Guide
          n="4"
          title="Build & test"
          items={[
            "npx cap sync",
            "iOS: npx cap open ios → press Run in Xcode on a simulator or your iPhone.",
            "Android: npx cap open android → press Run in Android Studio.",
            "Confirm the app opens straight to your member portal and parents can sign in.",
          ]}
        />
        <Guide
          n="5"
          title="Submit to the App Store (iOS)"
          items={[
            "In Xcode: set the Bundle Identifier to " + cfg.iosBundleId + " and pick your team.",
            "Product → Archive, then Distribute App → App Store Connect.",
            "At appstoreconnect.apple.com create the app listing: name, the description above, screenshots (use your phone), privacy policy URL, and support email.",
            "Submit for review. Apple review typically takes 1–3 days.",
          ]}
        />
        <Guide
          n="6"
          title="Submit to Google Play (Android)"
          items={[
            "In Android Studio: Build → Generate Signed Bundle (.aab). Keep the signing key safe — you need it for every future update.",
            "Package name: " + cfg.androidPackage,
            "At play.google.com/console create the app, upload the .aab to the Production track, fill the store listing (description, screenshots, privacy policy), and complete the content rating + data-safety forms.",
            "Roll out to production. Google review usually takes a few hours to ~2 days.",
          ]}
        />
        <Guide
          n="7"
          title="Hand it to parents"
          items={[
            "Share the App Store / Play Store links (and a QR code) with your families.",
            "They install, open it, and sign in with their member portal credentials — choosing the Member / Parent option on the login screen.",
            "To ship updates later: change anything here, then re-run steps 4–6 (no new accounts needed).",
          ]}
        />

        <Callout tone="muted">
          Prefer zero app-store work? Your portal is already an installable web app — parents
          can open the portal in their phone browser and tap “Add to Home Screen” for a
          branded icon today, no download required.
        </Callout>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="w-10 h-9 rounded border border-app-border cursor-pointer bg-white"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
      />
    </div>
  );
}

function Guide({ n, title, items }: { n: string; title: string; items: string[] }) {
  return (
    <div className="flex gap-4 mb-5">
      <div className="w-7 h-7 rounded-full bg-brand text-white text-sm font-semibold flex items-center justify-center flex-shrink-0">
        {n}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-primary mb-1.5">{title}</p>
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="text-sm text-text-muted flex gap-2">
              <span className="text-brand mt-0.5">•</span>
              <span>{it}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Callout({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "muted";
}) {
  return (
    <div
      className={`rounded-lg px-4 py-3 text-sm mb-6 ${
        tone === "muted"
          ? "bg-app-bg text-text-muted border border-app-border"
          : "bg-brand/5 text-text-primary border border-brand/20"
      }`}
    >
      {children}
    </div>
  );
}

// Pick black/white text for legibility on the splash color.
function contrast(hex: string) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return "#111111";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111111" : "#FFFFFF";
}
