"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import ImageUpload from "@/components/ImageUpload";

const SPORTS = [
  "American Football",
  "Baseball",
  "Basketball",
  "Boxing",
  "Brazilian Jiu-Jitsu",
  "Golf",
  "Gymnastics",
  "Hockey",
  "Judo",
  "Karate",
  "Kickboxing",
  "Lacrosse",
  "Mixed Martial Arts (MMA)",
  "Muay Thai",
  "Soccer",
  "Softball",
  "Swimming",
  "Taekwondo",
  "Tennis",
  "Track & Field",
  "Volleyball",
  "Wrestling",
];

const BRAND_COLORS = ["#6D5DF6", "#1F1F23", "#A3E635", "#FF6A00", "#A32D2D"];

export default function ClubSettingsPage() {
  const { data: session } = useSession();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [sport, setSport] = useState("");
  const [tagline, setTagline] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#6D5DF6");
  const [logoUrl, setLogoUrl] = useState<string>("");
  const [coverImageUrl, setCoverImageUrl] = useState<string>("");
  const [aboutUs, setAboutUs] = useState<string>("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [socialLinks, setSocialLinks] = useState<{ label: string; url: string }[]>([]);
  const [hours, setHours] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      const res = await fetch("/api/club/info");
      if (res.ok) {
        const club = await res.json();
        setName(club.name || "");
        setSlug(club.slug || "");
        setSport(club.sport || "");
        setTagline(club.tagline || "");
        setPrimaryColor(club.primaryColor || "#6D5DF6");
        setLogoUrl(club.logoUrl || "");
        setCoverImageUrl(club.coverImageUrl || "");
        setAboutUs(club.aboutUs || "");
        setContactEmail(club.contactEmail || "");
        setContactPhone(club.contactPhone || "");
        setWebsiteUrl(club.websiteUrl || "");
        const links = Array.isArray(club.socialLinks) ? club.socialLinks : [];
        setSocialLinks(links);
        const h = club.hoursOfOperation && typeof club.hoursOfOperation === "object" ? club.hoursOfOperation : {};
        setHours(h as Record<string, string>);
      }
      setLoading(false);
    }
    load();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");

    const res = await fetch("/api/club/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, slug, sport, tagline, primaryColor,
        logoUrl: logoUrl || null,
        coverImageUrl: coverImageUrl || null,
        aboutUs: aboutUs || null,
        contactEmail: contactEmail || null,
        contactPhone: contactPhone || null,
        websiteUrl: websiteUrl || null,
        socialLinks: socialLinks.filter((l) => l.label.trim() && l.url.trim()),
        hoursOfOperation: Object.keys(hours).length > 0 ? hours : null,
      }),
    });

    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // Same defensive parsing as ImageUpload: never render "[object Object]"
      // to the owner when upstream returns Zod arrays / nested objects.
      const raw = data?.error;
      const msg =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? ((raw[0]?.message as string | undefined) ?? (raw.map((x: { message?: string } | string) =>
                typeof x === "string" ? x : x?.message,
              ).filter(Boolean).join(", ") || "Failed to save"))
            : raw && typeof raw === "object"
              ? ((raw as { message?: string }).message ?? JSON.stringify(raw))
              : "Failed to save";
      setError(msg);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  if (loading) {
    return (
      <div className="p-8 text-sm text-text-muted text-center">Loading…</div>
    );
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <Link href="/dashboard/settings" className="text-sm text-text-muted hover:text-text-primary">
          ← Settings
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-text-primary mb-1">Club profile</h1>
        <p className="text-sm text-text-muted">Update your club's public information and branding.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="bg-white rounded-xl border border-app-border p-6 space-y-4">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Basic info</p>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Club name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Club URL</label>
            <div className="flex items-center">
              <span className="px-3 py-2 bg-app-bg border border-r-0 border-app-border rounded-l-lg text-sm text-text-muted">
                clubos.app/
              </span>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                required
                pattern="[a-z0-9-]+"
                className="flex-1 px-3 py-2 border border-app-border rounded-r-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <p className="text-xs text-text-muted mt-1">Lowercase letters, numbers, and dashes only</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Sport</label>
            <select
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand"
            >
              <option value="">Select a sport…</option>
              {SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Tagline</label>
            <input
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Where champions are made"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <p className="text-xs text-text-muted mt-1">Short one-liner shown next to your name on the member portal.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">About us</label>
            <textarea
              value={aboutUs}
              onChange={(e) => setAboutUs(e.target.value)}
              rows={6}
              maxLength={5000}
              placeholder="Tell members about your club — history, mission, philosophy, what makes you different…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-y"
            />
            <p className="text-xs text-text-muted mt-1">Appears on the member portal home page. Up to 5,000 characters.</p>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-app-border p-6 space-y-4">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Branding</p>

          <ImageUpload
            label="Club logo"
            value={logoUrl || null}
            onChange={setLogoUrl}
            shape="square"
            placeholder="◉"
          />

          <ImageUpload
            label="Cover photo (member portal hero)"
            value={coverImageUrl || null}
            onChange={setCoverImageUrl}
            shape="square"
            placeholder="◌"
          />

          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">Brand color</label>
            <div className="flex flex-wrap gap-2 mb-3">
              {BRAND_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPrimaryColor(c)}
                  className="w-8 h-8 rounded-full border-2 transition"
                  style={{
                    background: c,
                    borderColor: primaryColor === c ? "#000" : "transparent",
                    outline: primaryColor === c ? "2px solid #fff" : "none",
                    outlineOffset: -4,
                  }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border border-app-border"
              />
              <input
                type="text"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="w-28 px-3 py-1.5 border border-app-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <div
                className="flex-1 h-8 rounded-lg border border-app-border"
                style={{ background: primaryColor }}
              />
            </div>
          </div>
        </div>

        {/* Contact info */}
        <div className="bg-white rounded-xl border border-app-border p-6 space-y-4">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Contact</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Public email</label>
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="hello@yourclub.com"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Phone</label>
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="(555) 000-0000"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Website</label>
            <input
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://yourclub.com"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
        </div>

        {/* Hours */}
        <div className="bg-white rounded-xl border border-app-border p-6 space-y-3">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Hours</p>
          <p className="text-xs text-text-muted">Leave a day blank to mark it closed.</p>
          <div className="space-y-2">
            {["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => (
              <div key={day} className="flex items-center gap-3">
                <span className="w-28 text-sm text-text-primary capitalize">{day}</span>
                <input
                  type="text"
                  value={hours[day] || ""}
                  onChange={(e) => setHours({ ...hours, [day]: e.target.value })}
                  placeholder="9:00 AM – 9:00 PM"
                  className="flex-1 px-3 py-1.5 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Social links */}
        <div className="bg-white rounded-xl border border-app-border p-6 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Social links</p>
            <button
              type="button"
              onClick={() => setSocialLinks([...socialLinks, { label: "", url: "" }])}
              className="text-xs text-brand hover:underline"
            >
              + Add link
            </button>
          </div>
          {socialLinks.length === 0 ? (
            <p className="text-xs text-text-muted">No social links yet.</p>
          ) : (
            <div className="space-y-2">
              {socialLinks.map((link, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={link.label}
                    onChange={(e) => {
                      const next = [...socialLinks];
                      next[i] = { ...next[i], label: e.target.value };
                      setSocialLinks(next);
                    }}
                    placeholder="Instagram"
                    className="w-32 px-3 py-1.5 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  <input
                    type="url"
                    value={link.url}
                    onChange={(e) => {
                      const next = [...socialLinks];
                      next[i] = { ...next[i], url: e.target.value };
                      setSocialLinks(next);
                    }}
                    placeholder="https://instagram.com/yourclub"
                    className="flex-1 px-3 py-1.5 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  <button
                    type="button"
                    onClick={() => setSocialLinks(socialLinks.filter((_, idx) => idx !== i))}
                    className="text-text-muted hover:text-red-600 px-2"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}

        {saved && (
          <div className="text-sm text-text-primary bg-lime-accent border border-lime-accent/40 rounded-lg px-3 py-2">
            ✓ Club profile saved
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
