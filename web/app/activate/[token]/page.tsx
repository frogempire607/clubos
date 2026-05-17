"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

type Data = {
  completed: boolean;
  member: {
    firstName: string; lastName: string; email: string | null; phone: string | null;
    isMinor: boolean; guardianName: string | null; guardianEmail: string | null;
  };
  club: { name: string; slug: string; logoUrl: string | null; primaryColor: string | null };
  membership: { name: string | null; price: number | null; frequency: string | null; nextBillingDate: string | null; commitmentEndDate: string | null };
  paymentEnabled: boolean;
  requiredDocument: { id: string; title: string; body: string | null } | null;
};

export default function ActivatePage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const justDone = search.get("done") === "true";

  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [autopay, setAutopay] = useState(false);
  const [signed, setSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    fetch(`/api/members/migration/activate/${token}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setLoadErr(d.error || "This link is no longer valid."); setLoading(false); return; }
        setData(d);
        setPhone(d.member?.phone || "");
        setLoading(false);
      })
      .catch(() => { setLoadErr("Something went wrong. Please try again."); setLoading(false); });
  }, [token]);

  const accent = data?.club.primaryColor || "#534AB7";

  async function submit() {
    setError("");
    if (password.length < 8) { setError("Choose a password with at least 8 characters."); return; }
    if (!autopay) { setError("Please accept the autopay terms to continue."); return; }
    if (data?.requiredDocument && !signed) { setError(`Please acknowledge "${data.requiredDocument.title}".`); return; }
    setSubmitting(true);
    const res = await fetch(`/api/members/migration/activate/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password,
        phone: phone || null,
        autopayAccepted: true,
        signedDocumentId: data?.requiredDocument?.id || null,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) { setError(typeof d.error === "string" ? d.error : "Could not complete activation."); return; }
    if (d.url) { window.location.href = d.url; return; }
    if (d.noPayment) { setSuccessMsg(d.message || "Your account is activated."); return; }
    setSuccessMsg("Your account is activated.");
  }

  if (loading) {
    return <div className="min-h-screen bg-stone-50 flex items-center justify-center text-sm text-stone-400">Loading…</div>;
  }
  if (loadErr) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-8 max-w-sm text-center">
          <p className="text-base font-semibold text-stone-900 mb-1">Activation link unavailable</p>
          <p className="text-sm text-stone-500">{loadErr}</p>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const done = justDone || data.completed || !!successMsg;

  return (
    <div className="min-h-screen bg-stone-50 py-10 px-4">
      <div className="max-w-lg mx-auto">
        {/* Branded header / card reveal */}
        <div className="rounded-t-2xl px-8 py-8 text-center" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
          {data.club.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.club.logoUrl} alt={data.club.name} className="w-14 h-14 rounded-xl object-cover mx-auto mb-3" />
          ) : (
            <div className="w-14 h-14 rounded-xl mx-auto mb-3 bg-white/20 text-white text-2xl font-bold flex items-center justify-center">
              {data.club.name.charAt(0)}
            </div>
          )}
          <p className="text-white/80 text-xs uppercase tracking-wider">{data.club.name}</p>
          <h1 className="text-white text-xl font-bold mt-1">
            {done ? "You're all set" : "Continue your membership"}
          </h1>
        </div>

        <div className="bg-white rounded-b-2xl border border-stone-200 border-t-0 p-8">
          {done ? (
            <div className="text-center">
              <p className="text-3xl mb-2">🎉</p>
              <p className="text-stone-700 leading-relaxed">
                {successMsg || `Thanks, ${data.member.firstName}! Your membership at ${data.club.name} is continuing without interruption.`}
              </p>
              <p className="text-sm text-stone-500 mt-3">
                You can sign in any time at the {data.club.name} member portal.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-stone-600 leading-relaxed mb-5">
                <strong>{data.club.name}</strong> has moved to AthletixOS. We've prepared your account
                from your previous club software. Confirm your details and add a payment method to
                keep your membership going — you won't be charged today.
              </p>

              {/* Membership card */}
              <div className="bg-stone-900 rounded-xl p-5 mb-6 text-white">
                <p className="text-[11px] uppercase tracking-wider text-stone-400 mb-1">Membership</p>
                <p className="text-lg font-bold mb-3">{data.membership.name || "Your membership"}</p>
                <div className="flex justify-between text-sm">
                  <div>
                    <p className="text-[11px] text-stone-400">Member</p>
                    <p>{data.member.firstName} {data.member.lastName}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-stone-400">Next billing</p>
                    <p>{data.membership.nextBillingDate ? new Date(data.membership.nextBillingDate).toLocaleDateString() : "After activation"}</p>
                  </div>
                </div>
                {data.membership.price != null && (
                  <p className="text-xs text-stone-400 mt-3">
                    ${data.membership.price.toFixed(2)}{data.membership.frequency ? ` / ${data.membership.frequency.toLowerCase()}` : ""}
                    {data.membership.commitmentEndDate ? ` · commitment through ${new Date(data.membership.commitmentEndDate).toLocaleDateString()}` : ""}
                  </p>
                )}
              </div>

              {/* Confirm profile */}
              <div className="space-y-4 mb-5">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Email</label>
                  <input value={data.member.email || data.member.guardianEmail || ""} disabled
                    className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-stone-50 text-stone-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Phone</label>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" placeholder="(555) 555-5555" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Create a password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" placeholder="At least 8 characters" />
                </div>
              </div>

              {/* Required document */}
              {data.requiredDocument && (
                <div className="mb-5 border border-stone-200 rounded-lg p-3">
                  <p className="text-sm font-medium text-stone-800 mb-1">{data.requiredDocument.title}</p>
                  {data.requiredDocument.body && (
                    <div className="text-xs text-stone-500 max-h-28 overflow-y-auto mb-2 whitespace-pre-wrap">{data.requiredDocument.body}</div>
                  )}
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} />
                    I have read and agree to this document
                  </label>
                </div>
              )}

              {/* Autopay */}
              <label className="flex items-start gap-2 text-sm text-stone-700 mb-5">
                <input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} className="mt-0.5" />
                <span>
                  I authorize {data.club.name} to automatically charge my payment method for this
                  membership on its recurring billing date. {data.paymentEnabled
                    ? "I'll add my card on the next secure step — my first charge is on my existing billing date, not today."
                    : "The club will confirm billing details with me."}
                </span>
              </label>

              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>}

              <button
                onClick={submit}
                disabled={submitting}
                className="w-full py-3 rounded-xl text-white font-semibold disabled:opacity-50"
                style={{ background: accent }}
              >
                {submitting ? "Activating…" : data.paymentEnabled ? "Activate & add payment method" : "Activate my account"}
              </button>
              <p className="text-[11px] text-stone-400 text-center mt-3">
                Secure activation · Powered by AthletixOS. We never ask for card details over email.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
