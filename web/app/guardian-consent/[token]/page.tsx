"use client";

import { useEffect, useState } from "react";

interface ConsentData {
  status: "valid" | "expired" | "used" | "invalid";
  child: { firstName: string; lastName: string };
  guardianName: string | null;
  guardianEmail: string;
  club: { name: string; slug: string };
  termsVersion: string;
  privacyVersion: string;
  consentVersion: string;
  consentText: string;
}

export default function GuardianConsentPage({ params }: { params: { token: string } }) {
  const [data, setData] = useState<ConsentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [relationship, setRelationship] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/guardian-consent/${params.token}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setError("Could not load this consent link."))
      .finally(() => setLoading(false));
  }, [params.token]);

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/guardian-consent/${params.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accepted: true, relationship: relationship || undefined }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(typeof d.error === "string" ? d.error : "Could not record consent.");
      } else {
        setDone(true);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const wrap = "min-h-screen bg-stone-100 flex items-center justify-center p-4";
  const card = "w-full max-w-lg bg-white rounded-2xl border border-stone-200 p-6 sm:p-8 shadow-sm";

  if (loading) {
    return <div className={wrap}><div className={card}><p className="text-stone-500">Loading…</p></div></div>;
  }

  if (done) {
    return (
      <div className={wrap}>
        <div className={card}>
          <h1 className="text-xl font-semibold text-stone-900">Consent recorded</h1>
          <p className="mt-2 text-stone-600 leading-relaxed">
            Thank you. Your consent for {data?.child.firstName} has been securely recorded. The account can now be used.
          </p>
        </div>
      </div>
    );
  }

  if (!data || data.status !== "valid") {
    const msg =
      data?.status === "used"
        ? "This consent has already been completed."
        : data?.status === "expired"
        ? "This consent link has expired. Please ask the club to resend it."
        : "This consent link is not valid.";
    return (
      <div className={wrap}>
        <div className={card}>
          <h1 className="text-xl font-semibold text-stone-900">Parental consent</h1>
          <p className="mt-2 text-stone-600">{msg}</p>
        </div>
      </div>
    );
  }

  const childName = `${data.child.firstName} ${data.child.lastName}`.trim();

  return (
    <div className={wrap}>
      <div className={card}>
        <h1 className="text-xl font-semibold text-stone-900">Parental consent for {childName}</h1>
        <p className="mt-1 text-sm text-stone-500">
          {data.club.name} · sent to {data.guardianEmail}
        </p>

        <div className="mt-5 rounded-xl bg-stone-50 border border-stone-200 p-4 text-sm text-stone-700 leading-relaxed">
          {data.consentText}
        </div>

        <p className="mt-4 text-sm text-stone-600">
          By continuing you accept the{" "}
          <a href="/terms" target="_blank" className="text-[#534AB7] underline">Terms of Service</a>{" "}
          (v{data.termsVersion}) and{" "}
          <a href="/privacy" target="_blank" className="text-[#534AB7] underline">Privacy Policy</a>{" "}
          (v{data.privacyVersion}) on behalf of your child.
        </p>

        <div className="mt-4">
          <label className="block text-sm font-medium text-stone-700 mb-1">Your relationship to the child (optional)</label>
          <input
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="e.g. Mother, Father, Legal guardian"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#534AB7]"
          />
        </div>

        <label className="mt-4 flex items-start gap-2 text-sm text-stone-700">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1" />
          <span>
            I am the parent or legal guardian of {childName} and I give my consent as described above.
          </span>
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
