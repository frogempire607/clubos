"use client";

import { useEffect, useState } from "react";

interface PendingChild {
  memberId: string;
  childName: string;
  consentText: string;
}

interface ConsentResponse {
  enforced: boolean;
  termsVersion?: string;
  privacyVersion?: string;
  pending: PendingChild[];
}

// Blocking, non-dismissable overlay shown to a guardian who still owes COPPA
// consent for one or more minor children. Until every pending consent is
// recorded, the guardian can't reach the child's data below. Inert when the
// FEATURE_PARENTAL_CONSENT flag is off (the API returns pending: []).
export default function ParentalConsentGate() {
  const [pending, setPending] = useState<PendingChild[]>([]);
  const [meta, setMeta] = useState<{ termsVersion?: string; privacyVersion?: string }>({});
  const [idx, setIdx] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [relationship, setRelationship] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/member/consent")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ConsentResponse | null) => {
        if (!active || !d || !d.enforced) return;
        setPending(d.pending || []);
        setMeta({ termsVersion: d.termsVersion, privacyVersion: d.privacyVersion });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (pending.length === 0 || idx >= pending.length) return null;

  const child = pending[idx];

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/member/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: child.memberId, accepted: true, relationship: relationship || undefined }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(typeof d.error === "string" ? d.error : "Could not record consent.");
      } else {
        // Advance to the next pending child (or unmount when done).
        setAccepted(false);
        setRelationship("");
        setIdx((i) => i + 1);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] bg-stone-900/70 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl border border-stone-200 p-6 sm:p-8 shadow-xl max-h-[90vh] overflow-y-auto">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#534AB7]">Parental consent required</p>
        <h2 className="mt-1 text-xl font-semibold text-stone-900">Consent for {child.childName}</h2>
        <p className="mt-1 text-sm text-stone-500">
          To continue managing {child.childName}, please review and record your consent.
          {pending.length > 1 ? ` (${idx + 1} of ${pending.length})` : ""}
        </p>

        <div className="mt-4 rounded-xl bg-stone-50 border border-stone-200 p-4 text-sm text-stone-700 leading-relaxed">
          {child.consentText}
        </div>

        <p className="mt-3 text-sm text-stone-600">
          This accepts the{" "}
          <a href="/terms" target="_blank" className="text-[#534AB7] underline">Terms of Service</a>
          {meta.termsVersion ? ` (v${meta.termsVersion})` : ""} and{" "}
          <a href="/privacy" target="_blank" className="text-[#534AB7] underline">Privacy Policy</a>
          {meta.privacyVersion ? ` (v${meta.privacyVersion})` : ""} on behalf of your child.
        </p>

        <div className="mt-4">
          <label className="block text-sm font-medium text-stone-700 mb-1">Relationship (optional)</label>
          <input
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="e.g. Mother, Father, Legal guardian"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#534AB7]"
          />
        </div>

        <label className="mt-4 flex items-start gap-2 text-sm text-stone-700">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1" />
          <span>I am the parent or legal guardian of {child.childName} and I give my consent as described above.</span>
        </label>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <button
          onClick={submit}
          disabled={!accepted || submitting}
          className="mt-5 w-full rounded-lg bg-[#534AB7] text-white font-semibold py-3 text-sm disabled:opacity-50"
        >
          {submitting ? "Recording…" : "Give consent"}
        </button>
      </div>
    </div>
  );
}
