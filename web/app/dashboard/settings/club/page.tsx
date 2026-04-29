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

const BRAND_COLORS = [
  "#534AB7", "#1c1917", "#dc2626", "#ea580c", "#ca8a04",
  "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777",
];

export default function ClubSettingsPage() {
  const { data: session } = useSession();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [sport, setSport] = useState("");
  const [tagline, setTagline] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#534AB7");
  const [logoUrl, setLogoUrl] = useState<string>("");
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
        setPrimaryColor(club.primaryColor || "#534AB7");
        setLogoUrl(club.logoUrl || "");
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
      body: JSON.stringify({ name, slug, sport, tagline, primaryColor, logoUrl: logoUrl || null }),
    });

    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Failed to save");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  if (loading) {
    return (
      <div className="p-8 text-sm text-stone-500 text-center">Loading…</div>
    );
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <Link href="/dashboard/settings" className="text-sm text-stone-500 hover:text-stone-900">
          ← Settings
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-stone-900 mb-1">Club profile</h1>
        <p className="text-sm text-stone-500">Update your club's public information and branding.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Basic info</p>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Club name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Club URL</label>
            <div className="flex items-center">
              <span className="px-3 py-2 bg-stone-100 border border-r-0 border-stone-300 rounded-l-lg text-sm text-stone-500">
                clubos.app/
              </span>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                required
                pattern="[a-z0-9-]+"
                className="flex-1 px-3 py-2 border border-stone-300 rounded-r-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
            </div>
            <p className="text-xs text-stone-400 mt-1">Lowercase letters, numbers, and dashes only</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Sport</label>
            <select
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
            >
              <option value="">Select a sport…</option>
              {SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Tagline</label>
            <input
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Where champions are made"
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
            />
          </div>
        </div>

        <div className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Branding</p>

          <ImageUpload
            label="Club logo"
            value={logoUrl || null}
            onChange={setLogoUrl}
            shape="square"
            placeholder="◉"
          />

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-2">Brand color</label>
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
                className="w-8 h-8 rounded cursor-pointer border border-stone-300"
              />
              <input
                type="text"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="w-28 px-3 py-1.5 border border-stone-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
              <div
                className="flex-1 h-8 rounded-lg border border-stone-200"
                style={{ background: primaryColor }}
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}

        {saved && (
          <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            ✓ Club profile saved
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full py-2.5 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
