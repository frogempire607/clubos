"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  type BrandedAppConfig,
  type BrandedNavKey,
} from "@/lib/brandedApp";

type SectionKey =
  | "thumbnail"
  | "splash"
  | "signin"
  | "style"
  | "navigation"
  | "book"
  | "confirmation"
  | "reviews";

type ClubInfo = {
  name: string;
  slug: string;
  tier: string;
};

const SECTIONS: { key: SectionKey; label: string; description: string }[] = [
  { key: "thumbnail", label: "App thumbnail", description: "Home-screen icon and install tile." },
  { key: "splash", label: "Splash screen", description: "First screen members see on launch." },
  { key: "signin", label: "Sign-in screen", description: "Member and parent login presentation." },
  { key: "style", label: "Header & button style", description: "Core colors, buttons, icons, and weight." },
  { key: "navigation", label: "Navigation style", description: "Bottom tabs and labels." },
  { key: "book", label: "Book Now screen", description: "Entry point for classes, events, privates, and shop." },
  { key: "confirmation", label: "Confirmation screens", description: "Booking and purchase success states." },
  { key: "reviews", label: "Reviews screen", description: "Prompt members to leave public feedback." },
];

const CURRENT_SECTIONS = SECTIONS.filter((section) =>
  section.key === "style" || section.key === "navigation"
);

const NAV_LABELS: Record<BrandedNavKey, string> = {
  book: "Book Now",
  schedule: "My Schedule",
  store: "Store",
  videos: "Videos",
  more: "More",
};

export default function BrandedAppPage() {
  const [cfg, setCfg] = useState<BrandedAppConfig | null>(null);
  const [clubInfo, setClubInfo] = useState<ClubInfo | null>(null);
  const [portalUrl, setPortalUrl] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [active, setActive] = useState<SectionKey>("style");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

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

  function patch(patchValue: Partial<BrandedAppConfig>) {
    setCfg((c) => (c ? { ...c, ...patchValue } : c));
  }

  function patchNested<K extends keyof BrandedAppConfig>(
    key: K,
    value: Partial<BrandedAppConfig[K]>,
  ) {
    setCfg((c) => {
      if (!c) return c;
      const current = c[key];
      if (!current || typeof current !== "object" || Array.isArray(current)) return c;
      return { ...c, [key]: { ...current, ...value } };
    });
  }

  async function uploadImage(field: string, onDone: (url: string) => void, file: File) {
    setUploading(field);
    setError("");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", "image");
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json().catch(() => ({}));
    setUploading("");
    if (res.ok && d.url) onDone(d.url);
    else setError(d.error || "Image upload failed");
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
      setCfg(d.config ?? cfg);
      setMsg("Saved. Member portal styling will use these settings where supported.");
      setTimeout(() => setMsg(""), 4000);
    } else {
      setError(d.error || "Could not save");
    }
  }

  if (loading) return <div className="p-8 text-sm text-text-muted">Loading...</div>;
  if (!cfg) return <div className="p-8 text-sm text-text-muted">Could not load configuration.</div>;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="mb-2">
        <Link href="/dashboard/settings" className="text-sm text-text-muted hover:text-text-primary">
          Settings
        </Link>
      </div>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Member portal branding</h1>
          <p className="text-sm text-text-muted mt-1 max-w-2xl">
            Customize the mobile member portal and PWA experience for {clubInfo?.name || "this club"}.
            The native AthletixOS app shell uses this same portal after members sign in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {clubInfo?.tier === "growth" && (
            <span className="text-xs bg-orange-accent/10 text-orange-accent rounded-full px-3 py-1 font-medium">
              Pro feature
            </span>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {msg && (
        <div className="mb-4 text-sm text-text-primary bg-lime-accent/15 border border-lime-accent/40 rounded-lg px-3 py-2">
          {msg}
        </div>
      )}

      <div className="mb-5 grid md:grid-cols-3 gap-3">
        <StatusCard
          label="Available now"
          title="Member portal branding"
          body="Header colors, bottom tabs, portal content, logo, and club profile styling are live today."
        />
        <StatusCard
          label="Available now"
          title="PWA branding"
          body="Members can install the portal from mobile Safari or Chrome with the current AthletixOS manifest."
        />
        <StatusCard
          label="Native shell"
          title="AthletixOS iOS + Android"
          body="One native app shell loads the existing portal. Per-club store apps and automated submissions are roadmap items."
        />
      </div>

      <div className="grid lg:grid-cols-[260px_minmax(0,1fr)_330px] gap-5 items-start">
        <aside className="bg-white border border-app-border rounded-lg overflow-hidden">
          {CURRENT_SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setActive(s.key)}
              className={`w-full text-left px-4 py-3 border-b border-app-border last:border-b-0 transition ${
                active === s.key ? "bg-app-bg" : "hover:bg-app-bg"
              }`}
            >
              <span className="block text-sm font-semibold text-text-primary">{s.label}</span>
              <span className="block text-xs text-text-muted mt-0.5">{s.description}</span>
            </button>
          ))}
        </aside>

        <main className="bg-white border border-app-border rounded-lg p-5 min-h-[640px]">
          <SectionHeading section={SECTIONS.find((s) => s.key === active)!} />
          {active === "thumbnail" && (
            <ThumbnailSection
              cfg={cfg}
              uploading={uploading}
              patch={patch}
              patchNested={patchNested}
              uploadImage={uploadImage}
            />
          )}
          {active === "splash" && (
            <SplashSection
              cfg={cfg}
              uploading={uploading}
              patchNested={patchNested}
              uploadImage={uploadImage}
            />
          )}
          {active === "signin" && (
            <SignInSection
              cfg={cfg}
              uploading={uploading}
              patchNested={patchNested}
              uploadImage={uploadImage}
            />
          )}
          {active === "style" && (
            <StyleSection cfg={cfg} patchNested={patchNested} />
          )}
          {active === "navigation" && (
            <NavigationSection cfg={cfg} patchNested={patchNested} />
          )}
          {active === "book" && (
            <BookNowSection
              cfg={cfg}
              uploading={uploading}
              patchNested={patchNested}
              uploadImage={uploadImage}
            />
          )}
          {active === "confirmation" && (
            <ConfirmationSection
              cfg={cfg}
              uploading={uploading}
              patchNested={patchNested}
              uploadImage={uploadImage}
            />
          )}
          {active === "reviews" && (
            <ReviewsSection cfg={cfg} patchNested={patchNested} />
          )}
        </main>

        <aside className="lg:sticky lg:top-6">
          <p className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Live preview</p>
          <PhonePreview cfg={cfg} active={active} clubName={clubInfo?.name || cfg.appName} />
          <div className="mt-4 bg-white border border-app-border rounded-lg p-4 text-xs text-text-muted space-y-1">
            <p>Portal URL: <span className="font-mono text-text-primary">{portalUrl}</span></p>
            <p>Member sign-in: <span className="font-mono text-text-primary">{loginUrl}</span></p>
            <p className="pt-2 border-t border-app-border">
              Native app store IDs are managed by the AthletixOS shell for now, not per-club settings.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function StatusCard({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <div className="bg-white border border-app-border rounded-lg p-4">
      <p className="text-[11px] uppercase tracking-wider text-text-muted font-medium">{label}</p>
      <h2 className="text-sm font-semibold text-text-primary mt-1">{title}</h2>
      <p className="text-xs text-text-muted mt-1 leading-relaxed">{body}</p>
    </div>
  );
}

function SectionHeading({ section }: { section: { label: string; description: string } }) {
  return (
    <div className="mb-5 pb-4 border-b border-app-border">
      <h2 className="text-lg font-semibold text-text-primary">{section.label}</h2>
      <p className="text-sm text-text-muted mt-1">{section.description}</p>
    </div>
  );
}

function ThumbnailSection(props: SectionProps & { patch: (p: Partial<BrandedAppConfig>) => void }) {
  const { cfg, patch, patchNested, uploadImage, uploading } = props;
  return (
    <div className="space-y-5">
      <Field label="App name" hint="Shown under the icon on a member phone. Keep it short.">
        <input
          value={cfg.appName}
          maxLength={30}
          onChange={(e) => patch({ appName: e.target.value })}
          className="field-input"
        />
      </Field>
      <ImageUpload
        label="App thumbnail / icon"
        value={cfg.appThumbnail.iconUrl || cfg.iconUrl}
        uploading={uploading === "thumbnail-icon"}
        onUpload={(file) => uploadImage("thumbnail-icon", (url) => {
          patch({ iconUrl: url });
          patchNested("appThumbnail", { iconUrl: url });
        }, file)}
        onClear={() => {
          patch({ iconUrl: null });
          patchNested("appThumbnail", { iconUrl: null });
        }}
      />
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Background color">
          <ColorInput
            value={cfg.appThumbnail.backgroundColor}
            onChange={(v) => patchNested("appThumbnail", { backgroundColor: v })}
          />
        </Field>
        <Field label="Background gradient" hint="Optional CSS gradient.">
          <input
            value={cfg.appThumbnail.backgroundGradient}
            onChange={(e) => patchNested("appThumbnail", { backgroundGradient: e.target.value })}
            placeholder="linear-gradient(135deg, #FFFFFF, #F5F5F4)"
            className="field-input"
          />
        </Field>
      </div>
      <ImageUpload
        label="Background image"
        value={cfg.appThumbnail.backgroundImageUrl}
        uploading={uploading === "thumbnail-bg"}
        onUpload={(file) => uploadImage("thumbnail-bg", (url) => patchNested("appThumbnail", { backgroundImageUrl: url }), file)}
        onClear={() => patchNested("appThumbnail", { backgroundImageUrl: null })}
      />
    </div>
  );
}

function SplashSection({ cfg, patchNested, uploadImage, uploading }: SectionProps) {
  return (
    <div className="space-y-5">
      <ImageUpload
        label="Splash logo image"
        value={cfg.splash.logoUrl}
        uploading={uploading === "splash-logo"}
        onUpload={(file) => uploadImage("splash-logo", (url) => patchNested("splash", { logoUrl: url }), file)}
        onClear={() => patchNested("splash", { logoUrl: null })}
      />
      <ImageUpload
        label="Splash background image"
        value={cfg.splash.backgroundImageUrl}
        uploading={uploading === "splash-bg"}
        onUpload={(file) => uploadImage("splash-bg", (url) => patchNested("splash", { backgroundImageUrl: url }), file)}
        onClear={() => patchNested("splash", { backgroundImageUrl: null })}
      />
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Background color">
          <ColorInput value={cfg.splash.backgroundColor} onChange={(v) => patchNested("splash", { backgroundColor: v })} />
        </Field>
        <Field label="Club name text color">
          <ColorInput value={cfg.splash.textColor} onChange={(v) => patchNested("splash", { textColor: v })} />
        </Field>
        <Field label="Background gradient" hint="Optional CSS gradient.">
          <input
            value={cfg.splash.backgroundGradient}
            onChange={(e) => patchNested("splash", { backgroundGradient: e.target.value })}
            className="field-input"
            placeholder="radial-gradient(circle, #FFFFFF, #F5F5F4)"
          />
        </Field>
      </div>
    </div>
  );
}

function SignInSection({ cfg, patchNested, uploadImage, uploading }: SectionProps) {
  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={cfg.signIn.useDefaultBackground}
          onChange={(e) => patchNested("signIn", { useDefaultBackground: e.target.checked })}
          className="accent-brand"
        />
        Use default light portal background
      </label>
      <ImageUpload
        label="Background image"
        value={cfg.signIn.backgroundImageUrl}
        uploading={uploading === "signin-bg"}
        onUpload={(file) => uploadImage("signin-bg", (url) => patchNested("signIn", { backgroundImageUrl: url, useDefaultBackground: false }), file)}
        onClear={() => patchNested("signIn", { backgroundImageUrl: null })}
      />
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Overlay color">
          <input
            value={cfg.signIn.overlayColor}
            onChange={(e) => patchNested("signIn", { overlayColor: e.target.value })}
            className="field-input"
            placeholder="rgba(28,25,23,0.22)"
          />
        </Field>
        <Field label="Overlay gradient">
          <input
            value={cfg.signIn.overlayGradient}
            onChange={(e) => patchNested("signIn", { overlayGradient: e.target.value })}
            className="field-input"
            placeholder="linear-gradient(...)"
          />
        </Field>
        <Field label="Sign-in card background">
          <ColorInput value={cfg.signIn.cardBackground} onChange={(v) => patchNested("signIn", { cardBackground: v })} />
        </Field>
        <Field label="Sign-in button color">
          <ColorInput value={cfg.signIn.buttonColor} onChange={(v) => patchNested("signIn", { buttonColor: v })} />
        </Field>
        <Field label="Button text color">
          <ColorInput value={cfg.signIn.buttonTextColor} onChange={(v) => patchNested("signIn", { buttonTextColor: v })} />
        </Field>
        <Field label="Font style">
          <select
            value={cfg.signIn.fontStyle}
            onChange={(e) => patchNested("signIn", { fontStyle: e.target.value })}
            className="field-input"
          >
            <option value="system">System</option>
            <option value="rounded">Rounded</option>
            <option value="serif">Serif</option>
          </select>
        </Field>
        <Field label="Logo placement">
          <select
            value={cfg.signIn.logoPlacement}
            onChange={(e) => patchNested("signIn", { logoPlacement: e.target.value as "top" | "inside" })}
            className="field-input"
          >
            <option value="top">Above card</option>
            <option value="inside">Inside card</option>
          </select>
        </Field>
      </div>
      <p className="text-xs text-text-muted">
        Social login buttons are not shown because AthletixOS does not currently support those providers.
      </p>
    </div>
  );
}

function StyleSection({ cfg, patchNested }: Pick<SectionProps, "cfg" | "patchNested">) {
  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Primary button color">
          <ColorInput value={cfg.style.primaryButtonColor} onChange={(v) => patchNested("style", { primaryButtonColor: v })} />
        </Field>
        <Field label="Secondary button color">
          <ColorInput value={cfg.style.secondaryButtonColor} onChange={(v) => patchNested("style", { secondaryButtonColor: v })} />
        </Field>
        <Field label="Button text color">
          <ColorInput value={cfg.style.buttonTextColor} onChange={(v) => patchNested("style", { buttonTextColor: v })} />
        </Field>
        <Field label="Icon color">
          <ColorInput value={cfg.style.iconColor} onChange={(v) => patchNested("style", { iconColor: v })} />
        </Field>
        <Field label="Header background color">
          <ColorInput value={cfg.style.headerBackgroundColor} onChange={(v) => patchNested("style", { headerBackgroundColor: v })} />
        </Field>
        <Field label="Header text color">
          <ColorInput value={cfg.style.headerTextColor} onChange={(v) => patchNested("style", { headerTextColor: v })} />
        </Field>
        <Field label="Border radius">
          <input
            type="range"
            min={0}
            max={24}
            value={cfg.style.borderRadius}
            onChange={(e) => patchNested("style", { borderRadius: Number(e.target.value) })}
            className="w-full accent-brand"
          />
          <p className="text-xs text-text-muted mt-1">{cfg.style.borderRadius}px</p>
        </Field>
        <Field label="Font weight">
          <select
            value={cfg.style.fontWeight}
            onChange={(e) => patchNested("style", { fontWeight: e.target.value as BrandedAppConfig["style"]["fontWeight"] })}
            className="field-input"
          >
            <option value="normal">Normal</option>
            <option value="medium">Medium</option>
            <option value="semibold">Semibold</option>
            <option value="bold">Bold</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function NavigationSection({ cfg, patchNested }: Pick<SectionProps, "cfg" | "patchNested">) {
  function updateItem(key: BrandedNavKey, patch: Partial<{ label: string; enabled: boolean }>) {
    patchNested("navigation", {
      items: cfg.navigation.items.map((item) => item.key === key ? { ...item, ...patch } : item),
    });
  }
  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Bottom nav background">
          <ColorInput value={cfg.navigation.backgroundColor} onChange={(v) => patchNested("navigation", { backgroundColor: v })} />
        </Field>
        <Field label="Active icon color">
          <ColorInput value={cfg.navigation.activeIconColor} onChange={(v) => patchNested("navigation", { activeIconColor: v })} />
        </Field>
        <Field label="Inactive icon color">
          <ColorInput value={cfg.navigation.inactiveIconColor} onChange={(v) => patchNested("navigation", { inactiveIconColor: v })} />
        </Field>
      </div>
      <div className="space-y-3">
        {cfg.navigation.items.map((item) => (
          <div key={item.key} className="grid sm:grid-cols-[140px_1fr_auto] gap-3 items-center border border-app-border rounded-lg p-3">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={item.key === "videos"}
                onChange={(e) => updateItem(item.key, { enabled: e.target.checked })}
                className="accent-brand"
              />
              {NAV_LABELS[item.key]}
            </label>
            <input
              value={item.label}
              onChange={(e) => updateItem(item.key, { label: e.target.value })}
              className="field-input"
            />
            {item.key === "videos" && (
              <span className="text-xs text-text-muted">Future</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BookNowSection({ cfg, patchNested, uploadImage, uploading }: SectionProps) {
  return (
    <div className="space-y-5">
      <ImageUpload
        label="Book Now logo image"
        value={cfg.bookNow.logoUrl}
        uploading={uploading === "book-logo"}
        onUpload={(file) => uploadImage("book-logo", (url) => patchNested("bookNow", { logoUrl: url }), file)}
        onClear={() => patchNested("bookNow", { logoUrl: null })}
      />
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Logo / placeholder shape">
          <select
            value={cfg.bookNow.logoShape}
            onChange={(e) => patchNested("bookNow", { logoShape: e.target.value as BrandedAppConfig["bookNow"]["logoShape"] })}
            className="field-input"
          >
            <option value="round">Round</option>
            <option value="square">Square</option>
            <option value="rounded">Rounded</option>
          </select>
        </Field>
        <Field label="Top icon color">
          <ColorInput value={cfg.bookNow.topIconColor} onChange={(v) => patchNested("bookNow", { topIconColor: v })} />
        </Field>
        <Field label="Card background">
          <ColorInput value={cfg.bookNow.cardBackground} onChange={(v) => patchNested("bookNow", { cardBackground: v })} />
        </Field>
        <Field label="Button / card style">
          <select
            value={cfg.bookNow.buttonStyle}
            onChange={(e) => patchNested("bookNow", { buttonStyle: e.target.value as BrandedAppConfig["bookNow"]["buttonStyle"] })}
            className="field-input"
          >
            <option value="filled">Filled</option>
            <option value="outline">Outline</option>
            <option value="soft">Soft</option>
          </select>
        </Field>
      </div>
      <ImageUpload
        label="Background image"
        value={cfg.bookNow.backgroundImageUrl}
        uploading={uploading === "book-bg"}
        onUpload={(file) => uploadImage("book-bg", (url) => patchNested("bookNow", { backgroundImageUrl: url }), file)}
        onClear={() => patchNested("bookNow", { backgroundImageUrl: null })}
      />
      <Field label="Background overlay / gradient">
        <input
          value={cfg.bookNow.backgroundGradient}
          onChange={(e) => patchNested("bookNow", { backgroundGradient: e.target.value })}
          className="field-input"
          placeholder="linear-gradient(180deg, rgba(0,0,0,.15), rgba(255,255,255,.9))"
        />
      </Field>
    </div>
  );
}

function ConfirmationSection({ cfg, patchNested, uploadImage, uploading }: SectionProps) {
  return (
    <div className="space-y-5">
      <ImageUpload
        label="Success icon / logo"
        value={cfg.confirmation.successIconUrl}
        uploading={uploading === "confirm-icon"}
        onUpload={(file) => uploadImage("confirm-icon", (url) => patchNested("confirmation", { successIconUrl: url }), file)}
        onClear={() => patchNested("confirmation", { successIconUrl: null })}
      />
      <Field label="Confirmation message">
        <textarea
          value={cfg.confirmation.message}
          onChange={(e) => patchNested("confirmation", { message: e.target.value })}
          rows={3}
          className="field-input resize-none"
        />
      </Field>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Button color">
          <ColorInput value={cfg.confirmation.buttonColor} onChange={(v) => patchNested("confirmation", { buttonColor: v })} />
        </Field>
        <Field label="Button text color">
          <ColorInput value={cfg.confirmation.buttonTextColor} onChange={(v) => patchNested("confirmation", { buttonTextColor: v })} />
        </Field>
        <Field label="Background color">
          <ColorInput value={cfg.confirmation.backgroundColor} onChange={(v) => patchNested("confirmation", { backgroundColor: v })} />
        </Field>
      </div>
      <ImageUpload
        label="Background image"
        value={cfg.confirmation.backgroundImageUrl}
        uploading={uploading === "confirm-bg"}
        onUpload={(file) => uploadImage("confirm-bg", (url) => patchNested("confirmation", { backgroundImageUrl: url }), file)}
        onClear={() => patchNested("confirmation", { backgroundImageUrl: null })}
      />
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={cfg.confirmation.showAddToCalendar}
          onChange={(e) => patchNested("confirmation", { showAddToCalendar: e.target.checked })}
          className="accent-brand"
        />
        Show Add to calendar button in preview
      </label>
    </div>
  );
}

function ReviewsSection({ cfg, patchNested }: Pick<SectionProps, "cfg" | "patchNested">) {
  return (
    <div className="space-y-5">
      <Field label="Review prompt title">
        <input value={cfg.reviews.title} onChange={(e) => patchNested("reviews", { title: e.target.value })} className="field-input" />
      </Field>
      <Field label="Review prompt message">
        <textarea
          value={cfg.reviews.message}
          onChange={(e) => patchNested("reviews", { message: e.target.value })}
          rows={3}
          className="field-input resize-none"
        />
      </Field>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Button color">
          <ColorInput value={cfg.reviews.buttonColor} onChange={(v) => patchNested("reviews", { buttonColor: v })} />
        </Field>
        <Field label="Button text color">
          <ColorInput value={cfg.reviews.buttonTextColor} onChange={(v) => patchNested("reviews", { buttonTextColor: v })} />
        </Field>
      </div>
      <Field label="Google review link" hint="Optional. Use the club's public review URL.">
        <input
          value={cfg.reviews.googleReviewUrl}
          onChange={(e) => patchNested("reviews", { googleReviewUrl: e.target.value })}
          className="field-input"
          placeholder="https://..."
        />
      </Field>
      <Field label="Facebook review link" hint="Optional. Use the club's public review URL.">
        <input
          value={cfg.reviews.facebookReviewUrl}
          onChange={(e) => patchNested("reviews", { facebookReviewUrl: e.target.value })}
          className="field-input"
          placeholder="https://..."
        />
      </Field>
    </div>
  );
}

type SectionProps = {
  cfg: BrandedAppConfig;
  uploading: string;
  patchNested: <K extends keyof BrandedAppConfig>(key: K, value: Partial<BrandedAppConfig[K]>) => void;
  uploadImage: (field: string, onDone: (url: string) => void, file: File) => void;
};

function PhonePreview({ cfg, active, clubName }: { cfg: BrandedAppConfig; active: SectionKey; clubName: string }) {
  return (
    <div className="mx-auto w-[300px] rounded-[34px] border-[7px] border-charcoal bg-charcoal p-2 shadow-xl">
      <div className="h-[620px] rounded-[26px] bg-stone-50 overflow-hidden relative">
        {active === "thumbnail" && <ThumbnailPreview cfg={cfg} />}
        {active === "splash" && <SplashPreview cfg={cfg} />}
        {active === "signin" && <SignInPreview cfg={cfg} />}
        {active === "style" && <BookPreview cfg={cfg} clubName={clubName} />}
        {active === "navigation" && <BookPreview cfg={cfg} clubName={clubName} />}
        {active === "book" && <BookPreview cfg={cfg} clubName={clubName} />}
        {active === "confirmation" && <ConfirmationPreview cfg={cfg} />}
        {active === "reviews" && <ReviewsPreview cfg={cfg} />}
      </div>
    </div>
  );
}

function ThumbnailPreview({ cfg }: { cfg: BrandedAppConfig }) {
  return (
    <div className="h-full p-5" style={previewBackground(cfg.appThumbnail.backgroundColor, cfg.appThumbnail.backgroundGradient, cfg.appThumbnail.backgroundImageUrl)}>
      <div className="grid grid-cols-4 gap-4 pt-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-13 rounded-2xl bg-white/60 border border-white/70" />
        ))}
        <div className="flex flex-col items-center gap-1.5">
          <PreviewImage
            src={cfg.appThumbnail.iconUrl || cfg.iconUrl}
            fallback={cfg.appName.slice(0, 1)}
            className="w-14 h-14 rounded-2xl shadow"
            bg={cfg.themeColor}
          />
          <span className="text-[10px] text-center font-medium text-stone-900 max-w-16 truncate">{cfg.appName}</span>
        </div>
      </div>
    </div>
  );
}

function SplashPreview({ cfg }: { cfg: BrandedAppConfig }) {
  return (
    <div className="h-full flex flex-col items-center justify-center" style={previewBackground(cfg.splash.backgroundColor, cfg.splash.backgroundGradient, cfg.splash.backgroundImageUrl)}>
      <PreviewImage
        src={cfg.splash.logoUrl || cfg.iconUrl}
        fallback={cfg.appName.slice(0, 1)}
        className="w-24 h-24 rounded-3xl shadow-lg"
        bg={cfg.themeColor}
      />
      <p className="mt-4 text-base font-semibold" style={{ color: cfg.splash.textColor }}>
        {cfg.appName}
      </p>
    </div>
  );
}

function SignInPreview({ cfg }: { cfg: BrandedAppConfig }) {
  const bg = cfg.signIn.useDefaultBackground
    ? { background: "#F5F5F4" }
    : previewBackground("#F5F5F4", cfg.signIn.overlayGradient, cfg.signIn.backgroundImageUrl);
  return (
    <div className={fontClass(cfg.signIn.fontStyle)} style={{ ...bg, minHeight: "100%" }}>
      {!cfg.signIn.useDefaultBackground && (
        <div className="absolute inset-0" style={{ background: cfg.signIn.overlayColor }} />
      )}
      <div className="relative h-full flex flex-col justify-center px-5">
        {cfg.signIn.logoPlacement === "top" && (
          <PreviewImage src={cfg.iconUrl} fallback={cfg.appName.slice(0, 1)} className="w-18 h-18 rounded-2xl mx-auto mb-5" bg={cfg.themeColor} />
        )}
        <div className="rounded-2xl p-5 shadow-sm border border-white/60" style={{ background: cfg.signIn.cardBackground }}>
          {cfg.signIn.logoPlacement === "inside" && (
            <PreviewImage src={cfg.iconUrl} fallback={cfg.appName.slice(0, 1)} className="w-14 h-14 rounded-2xl mb-4" bg={cfg.themeColor} />
          )}
          <p className="text-lg font-semibold text-stone-900">Member sign in</p>
          <p className="text-xs text-stone-500 mt-1 mb-4">View your schedule, documents, and bookings.</p>
          <div className="space-y-3">
            <PreviewField label="Email" />
            <PreviewField label="Password" />
            <button className="w-full py-2.5 text-sm font-semibold rounded-lg" style={{ background: cfg.signIn.buttonColor, color: cfg.signIn.buttonTextColor }}>
              Sign in
            </button>
          </div>
          <p className="text-xs text-center text-stone-500 mt-4">Forgot password?</p>
        </div>
      </div>
    </div>
  );
}

function BookPreview({ cfg, clubName }: { cfg: BrandedAppConfig; clubName: string }) {
  const enabledNav = cfg.navigation.items.filter((item) => item.enabled);
  const logoRadius = cfg.bookNow.logoShape === "round" ? "999px" : cfg.bookNow.logoShape === "square" ? "4px" : "16px";
  return (
    <div className="h-full flex flex-col" style={previewBackground("#F5F5F4", cfg.bookNow.backgroundGradient, cfg.bookNow.backgroundImageUrl)}>
      <div className="px-4 pt-4 pb-3 flex items-center justify-between" style={{ background: cfg.style.headerBackgroundColor, color: cfg.style.headerTextColor }}>
        <div className="flex items-center gap-2 min-w-0">
          <PreviewImage src={cfg.bookNow.logoUrl || cfg.iconUrl} fallback={clubName.slice(0, 1)} className="w-9 h-9" bg={cfg.themeColor} radius={logoRadius} />
          <div className="min-w-0">
            <p className="text-sm truncate" style={{ fontWeight: weightNumber(cfg.style.fontWeight) }}>{clubName}</p>
            <p className="text-[10px] opacity-75 truncate">Member app</p>
          </div>
        </div>
        <span style={{ color: cfg.bookNow.topIconColor }}>***</span>
      </div>
      <div className="flex-1 p-4 space-y-3 overflow-hidden">
        <div className="text-xs rounded-lg p-3 border border-white/70" style={{ background: cfg.bookNow.cardBackground }}>
          <p className="font-semibold text-stone-900">Location</p>
          <p className="text-stone-500 mt-1">Club address and contact details appear here when saved.</p>
        </div>
        <p className="text-xs uppercase tracking-wider text-stone-500 font-medium pt-1">Book a service</p>
        {["Classes", "Events", "Private Lessons", "Products / Store"].map((label) => (
          <div key={label} className="rounded-lg p-3 border flex items-center justify-between" style={bookCardStyle(cfg)}>
            <span className="text-sm font-medium text-stone-900">{label}</span>
            <span className="text-sm" style={{ color: cfg.style.iconColor }}>+</span>
          </div>
        ))}
      </div>
      <div className="grid border-t border-stone-200" style={{ gridTemplateColumns: `repeat(${Math.max(enabledNav.length, 1)}, minmax(0, 1fr))`, background: cfg.navigation.backgroundColor }}>
        {enabledNav.map((item, i) => (
          <div key={item.key} className="py-2 flex flex-col items-center gap-1" style={{ color: i === 0 ? cfg.navigation.activeIconColor : cfg.navigation.inactiveIconColor }}>
            <span className="text-base">{navIcon(item.key)}</span>
            <span className="text-[9px] font-medium leading-none">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfirmationPreview({ cfg }: { cfg: BrandedAppConfig }) {
  return (
    <div className="h-full flex items-center justify-center p-5" style={previewBackground(cfg.confirmation.backgroundColor, "", cfg.confirmation.backgroundImageUrl)}>
      <div className="w-full bg-white rounded-2xl border border-stone-200 p-5 text-center shadow-sm">
        <PreviewImage src={cfg.confirmation.successIconUrl} fallback="✓" className="w-20 h-20 rounded-full mx-auto" bg={cfg.confirmation.buttonColor} />
        <p className="text-lg font-semibold text-stone-900 mt-4">Confirmed</p>
        <p className="text-sm text-stone-500 mt-2">{cfg.confirmation.message}</p>
        <button className="w-full mt-5 py-2.5 rounded-lg text-sm font-semibold" style={{ background: cfg.confirmation.buttonColor, color: cfg.confirmation.buttonTextColor }}>
          View my schedule
        </button>
        {cfg.confirmation.showAddToCalendar && (
          <button className="w-full mt-2 py-2.5 rounded-lg text-sm font-semibold border border-stone-200 text-stone-700">
            Add to calendar
          </button>
        )}
      </div>
    </div>
  );
}

function ReviewsPreview({ cfg }: { cfg: BrandedAppConfig }) {
  const hasLinks = !!cfg.reviews.googleReviewUrl || !!cfg.reviews.facebookReviewUrl;
  return (
    <div className="h-full bg-stone-50 p-5 flex items-center">
      <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm">
        <p className="text-lg font-semibold text-stone-900">{cfg.reviews.title}</p>
        <p className="text-sm text-stone-500 mt-2">{cfg.reviews.message}</p>
        <button className="w-full mt-5 py-2.5 rounded-lg text-sm font-semibold" style={{ background: cfg.reviews.buttonColor, color: cfg.reviews.buttonTextColor }}>
          {hasLinks ? "Leave a review" : "Send feedback"}
        </button>
        {hasLinks && <p className="text-[11px] text-stone-400 text-center mt-3">Links open your saved public review pages.</p>}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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
      <input type="color" value={safeHex(value)} onChange={(e) => onChange(e.target.value.toUpperCase())} className="w-10 h-9 rounded border border-app-border cursor-pointer bg-white" />
      <input value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="field-input font-mono" />
    </div>
  );
}

function ImageUpload({
  label,
  value,
  uploading,
  onUpload,
  onClear,
}: {
  label: string;
  value: string | null;
  uploading: boolean;
  onUpload: (file: File) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <Field label={label} hint="Uploads use the private AthletixOS file store.">
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 rounded-lg bg-app-bg border border-app-border overflow-hidden flex items-center justify-center">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-xs text-text-muted">None</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={ref}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
          <button
            type="button"
            onClick={() => ref.current?.click()}
            disabled={uploading}
            className="px-3 py-1.5 border border-app-border rounded-lg text-sm hover:bg-app-bg disabled:opacity-50"
          >
            {uploading ? "Uploading..." : value ? "Replace" : "Upload"}
          </button>
          {value && (
            <button type="button" onClick={onClear} className="px-3 py-1.5 border border-app-border rounded-lg text-sm hover:bg-app-bg">
              Clear
            </button>
          )}
        </div>
      </div>
    </Field>
  );
}

function PreviewImage({
  src,
  fallback,
  className,
  bg,
  radius,
}: {
  src: string | null | undefined;
  fallback: string;
  className: string;
  bg: string;
  radius?: string;
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" className={`${className} object-cover`} style={radius ? { borderRadius: radius } : undefined} />
    );
  }
  return (
    <div className={`${className} flex items-center justify-center text-white font-bold`} style={{ background: bg, borderRadius: radius }}>
      {fallback || "A"}
    </div>
  );
}

function PreviewField({ label }: { label: string }) {
  return (
    <div>
      <p className="text-[11px] text-stone-500 mb-1">{label}</p>
      <div className="h-9 rounded-lg border border-stone-200 bg-stone-50" />
    </div>
  );
}

function previewBackground(color: string, gradient: string, imageUrl: string | null): React.CSSProperties {
  const layers = [];
  if (gradient.trim()) layers.push(gradient.trim());
  if (imageUrl) layers.push(`url(${imageUrl})`);
  return {
    backgroundColor: color,
    backgroundImage: layers.length ? layers.join(", ") : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
}

function safeHex(value: string) {
  return /^#([0-9a-fA-F]{6})$/.test(value) ? value : "#111111";
}

function fontClass(style: string) {
  if (style === "serif") return "font-serif";
  if (style === "rounded") return "[font-family:ui-rounded,system-ui,sans-serif]";
  return "";
}

function weightNumber(weight: BrandedAppConfig["style"]["fontWeight"]) {
  if (weight === "bold") return 700;
  if (weight === "semibold") return 600;
  if (weight === "medium") return 500;
  return 400;
}

function bookCardStyle(cfg: BrandedAppConfig): React.CSSProperties {
  const base = { borderRadius: cfg.style.borderRadius };
  if (cfg.bookNow.buttonStyle === "outline") {
    return { ...base, background: "transparent", borderColor: cfg.style.primaryButtonColor };
  }
  if (cfg.bookNow.buttonStyle === "soft") {
    return { ...base, background: `${cfg.style.primaryButtonColor}16`, borderColor: `${cfg.style.primaryButtonColor}24` };
  }
  return { ...base, background: cfg.bookNow.cardBackground, borderColor: "#E7E5E4" };
}

function navIcon(key: BrandedNavKey) {
  if (key === "book") return "+";
  if (key === "schedule") return "□";
  if (key === "store") return "$";
  if (key === "videos") return "▶";
  return "...";
}
