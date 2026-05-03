"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ALWAYS_ON_FIELDS,
  DEFAULT_MEMBER_FORM_CONFIG,
  FIELD_LABELS,
  FIELD_ORDER,
  type MemberFormConfig,
  type MemberFormFieldKey,
} from "@/lib/memberForm";

export default function MemberFormSettingsPage() {
  const [cfg, setCfg] = useState<MemberFormConfig>(DEFAULT_MEMBER_FORM_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/club/member-form")
      .then((r) => r.json())
      .then((d) => { setCfg(d.config); setLoading(false); });
  }, []);

  function toggleEnabled(k: MemberFormFieldKey) {
    if (ALWAYS_ON_FIELDS.includes(k)) return;
    setCfg((prev) => {
      const enabled = prev.enabledFields.includes(k)
        ? prev.enabledFields.filter((x) => x !== k)
        : [...prev.enabledFields, k];
      // If disabling, drop from required too
      const required = enabled.includes(k) ? prev.requiredFields : prev.requiredFields.filter((x) => x !== k);
      return { enabledFields: enabled, requiredFields: required };
    });
  }

  function toggleRequired(k: MemberFormFieldKey) {
    if (k === "athleteName") return; // always required
    setCfg((prev) => {
      const required = prev.requiredFields.includes(k)
        ? prev.requiredFields.filter((x) => x !== k)
        : [...prev.requiredFields, k];
      return { ...prev, requiredFields: required };
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch("/api/club/member-form", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error?.toString?.() || "Failed to save");
      return;
    }
    const d = await res.json();
    setCfg(d.config);
    setSavedAt(Date.now());
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <Link href="/dashboard/members" className="text-xs text-text-muted hover:text-text-primary">‹ Back to Members</Link>
        <h1 className="text-3xl font-semibold text-text-primary mt-1 mb-1">Member intake form</h1>
        <p className="text-sm text-text-muted">
          Choose which fields appear when you add a new member or import a CSV. Athlete name and email are always
          included — toggle the rest to fit your club.
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : (
        <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto] items-center px-5 py-3 border-b border-app-border bg-app-bg">
            <span className="text-xs uppercase tracking-wider text-text-muted font-medium">Field</span>
            <span className="text-xs uppercase tracking-wider text-text-muted font-medium px-3">Show</span>
            <span className="text-xs uppercase tracking-wider text-text-muted font-medium px-3">Required</span>
          </div>

          {FIELD_ORDER.map((k) => {
            const enabled  = cfg.enabledFields.includes(k);
            const required = cfg.requiredFields.includes(k);
            const isAlwaysOn = ALWAYS_ON_FIELDS.includes(k);
            const requiredLocked = k === "athleteName";
            return (
              <div
                key={k}
                className="grid grid-cols-[1fr_auto_auto] items-center px-5 py-3 border-b border-app-border last:border-b-0"
              >
                <div>
                  <div className="text-sm font-medium text-text-primary">{FIELD_LABELS[k]}</div>
                  {isAlwaysOn && (
                    <div className="text-[11px] text-text-muted">Always shown</div>
                  )}
                  {k === "isMinor" && (
                    <div className="text-[11px] text-text-muted">Reveals guardian fields when checked</div>
                  )}
                </div>

                <label className="flex items-center justify-center px-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={isAlwaysOn}
                    onChange={() => toggleEnabled(k)}
                    className="rounded"
                  />
                </label>

                <label className={`flex items-center justify-center px-3 ${enabled ? "cursor-pointer" : "opacity-30 cursor-not-allowed"}`}>
                  <input
                    type="checkbox"
                    checked={required}
                    disabled={!enabled || requiredLocked}
                    onChange={() => toggleRequired(k)}
                    className="rounded"
                  />
                </label>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-xs text-text-muted">
        <p>Need a field that isn't here? <Link href="/dashboard/custom-fields" className="text-brand hover:underline">Manage custom fields →</Link></p>
        <p className="mt-1">Required fields here are also enforced when importing members from a CSV.</p>
      </div>

      {error && <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save form"}
        </button>
        {savedAt && <span className="text-xs text-text-muted">Saved</span>}
      </div>
    </div>
  );
}
