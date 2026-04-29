"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

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

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [sport, setSport] = useState("");
  const [tagline, setTagline] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#534AB7");

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-sm text-stone-500">Loading…</div>
      </div>
    );
  }

  if (!session || session.user.role !== "OWNER") {
    router.push("/login");
    return null;
  }

  const colors = ["#534AB7", "#1D9E75", "#D85A30", "#185FA5", "#BA7517", "#2C2C2A", "#A32D2D", "#D4537E"];

  const steps = [
    { label: "Club name" },
    { label: "Your URL" },
    { label: "Branding" },
    { label: "Review" },
  ];

  function suggestSlug(n: string) {
    return n
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  async function handleFinish() {
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/club/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug, sport, tagline, primaryColor }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Setup failed");
        setLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  }

  const canAdvance =
    (step === 0 && name.trim().length > 0) ||
    (step === 1 && slug.length >= 2 && /^[a-z0-9-]+$/.test(slug)) ||
    step === 2 ||
    step === 3;

  return (
    <div className="min-h-screen bg-stone-50 py-10 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-md bg-stone-900 flex items-center justify-center">
              <div className="w-3 h-3 rounded-full border-2 border-white" />
            </div>
            <span className="font-medium text-stone-900">ClubOS</span>
          </div>
          <div className="flex gap-1">
            {steps.map((_, i) => (
              <div
                key={i}
                className="flex-1 h-1 rounded-full transition-colors"
                style={{ background: i <= step ? "#1C1917" : "#E7E5E4" }}
              />
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-stone-200 p-8">
          {step === 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 mb-2 font-medium">Step 1 of 4</p>
              <h1 className="text-2xl font-semibold text-stone-900 mb-2">What's your club called?</h1>
              <p className="text-sm text-stone-500 mb-6">The name members will see everywhere.</p>

              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slug) setSlug(suggestSlug(e.target.value));
                }}
                placeholder="Apex Wrestling Academy"
                autoFocus
                className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
            </div>
          )}

          {step === 1 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 mb-2 font-medium">Step 2 of 4</p>
              <h1 className="text-2xl font-semibold text-stone-900 mb-2">Pick your club URL</h1>
              <p className="text-sm text-stone-500 mb-6">
                This is the code members use to join. You can change this later.
              </p>

              <div className="flex items-center border border-stone-300 rounded-lg px-3 py-2.5 focus-within:ring-2 focus-within:ring-stone-900">
                <span className="text-sm text-stone-400">clubos.app/</span>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  placeholder="apex-wrestling"
                  className="flex-1 bg-transparent outline-none text-base"
                />
              </div>
              <p className="text-xs text-stone-400 mt-2">Lowercase letters, numbers, and dashes only</p>
            </div>
          )}

          {step === 2 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 mb-2 font-medium">Step 3 of 4</p>
              <h1 className="text-2xl font-semibold text-stone-900 mb-2">A little branding</h1>
              <p className="text-sm text-stone-500 mb-6">All optional — change anytime.</p>

              <div className="space-y-4">
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
                    placeholder="Elite training for every level"
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-2">Brand color</label>
                  <div className="flex gap-2 flex-wrap">
                    {colors.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setPrimaryColor(c)}
                        className="w-9 h-9 rounded-full transition-transform hover:scale-110"
                        style={{
                          background: c,
                          boxShadow: primaryColor === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : "none",
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 mb-2 font-medium">Step 4 of 4</p>
              <h1 className="text-2xl font-semibold text-stone-900 mb-2">Ready to launch</h1>
              <p className="text-sm text-stone-500 mb-6">Everything is editable after this — don't sweat it.</p>

              <div className="bg-stone-50 rounded-lg p-4 space-y-3 mb-4">
                <Row label="Name" value={name} />
                <Row label="URL" value={`clubos.app/${slug}`} />
                {sport && <Row label="Sport" value={sport} />}
                {tagline && <Row label="Tagline" value={tagline} />}
                <div className="flex items-center justify-between py-1 border-t border-stone-200 pt-3">
                  <span className="text-sm text-stone-500">Brand color</span>
                  <span className="w-5 h-5 rounded-full" style={{ background: primaryColor }} />
                </div>
              </div>

              {error && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
                  {error}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between mt-8 pt-6 border-t border-stone-100">
            <button
              onClick={() => setStep(Math.max(0, step - 1))}
              disabled={step === 0}
              className="text-sm text-stone-600 hover:text-stone-900 disabled:opacity-30"
            >
              ← Back
            </button>

            {step < 3 ? (
              <button
                onClick={() => setStep(step + 1)}
                disabled={!canAdvance}
                className="px-5 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
              >
                Continue →
              </button>
            ) : (
              <button
                onClick={handleFinish}
                disabled={loading}
                className="px-6 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {loading ? "Launching…" : "Launch club ✦"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-stone-500">{label}</span>
      <span className="text-sm text-stone-900 font-medium">{value}</span>
    </div>
  );
}
