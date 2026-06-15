"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

type PlanOption = { label: string; price: number; billingPeriod: string };
type Data = {
  completed: boolean;
  pendingApproval: boolean;
  finalPeriodPaid: boolean;
  kind: string | null;
  joined?: boolean;
  member: {
    firstName: string; lastName: string; email: string | null; phone: string | null;
    isMinor: boolean; guardianName: string | null; guardianEmail: string | null;
  };
  club: { name: string; slug: string; logoUrl: string | null; primaryColor: string | null };
  membership: {
    name: string | null; price: number | null; frequency: string | null;
    nextBillingDate: string | null; commitmentEndDate: string | null;
    options: PlanOption[]; priceLocked: boolean; selectedOption: PlanOption | null;
  };
  editable: { phone: boolean; email: boolean; billingDateRequest: boolean; notes: boolean; cancellationDate: boolean; paymentChoice: boolean };
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [autopay, setAutopay] = useState(false);
  const [signed, setSigned] = useState(false);
  const [reqDate, setReqDate] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [note, setNote] = useState("");
  const [selectedOptionLabel, setSelectedOptionLabel] = useState("");
  const [cancelDate, setCancelDate] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"CARD" | "CASH" | "CHECK">("CARD");
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
        setEmail(d.member?.email || "");
        const planOpts: PlanOption[] = d.membership?.options || [];
        setSelectedOptionLabel(d.membership?.selectedOption?.label || planOpts[0]?.label || "");
        setLoading(false);
      })
      .catch(() => { setLoadErr("Something went wrong. Please try again."); setLoading(false); });
  }, [token]);

  const accent = data?.club.primaryColor || "#534AB7";
  const finalPaid = !!data?.finalPeriodPaid;
  const isJoin = data?.kind === "JOIN";
  const opts = data?.membership.options ?? [];
  const canChoosePlan = !finalPaid && !data?.membership.priceLocked && opts.length > 1;
  const chosenOption = opts.find((o) => o.label === selectedOptionLabel) || null;
  const displayPrice = chosenOption ? chosenOption.price : data?.membership.price ?? null;
  const displayFrequency = chosenOption ? chosenOption.billingPeriod : data?.membership.frequency ?? null;

  async function submit() {
    setError("");
    if (password.length < 8) { setError("Choose a password with at least 8 characters."); return; }
    // Autopay only applies to recurring card billing.
    if (!finalPaid && !isJoin && paymentMethod === "CARD" && !autopay) {
      setError("Please accept the autopay terms to continue."); return;
    }
    if (!isJoin && data?.requiredDocument && !signed) { setError(`Please acknowledge "${data.requiredDocument.title}".`); return; }
    setSubmitting(true);
    const res = await fetch(`/api/members/migration/activate/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password,
        phone: phone || null,
        email: data?.editable.email && email ? email : null,
        autopayAccepted: !finalPaid && paymentMethod === "CARD" ? autopay : false,
        signedDocumentId: data?.requiredDocument?.id || null,
        requestedBillingDate: !finalPaid && data?.editable.billingDateRequest && reqDate ? reqDate : null,
        requestedBillingNote: !finalPaid && data?.editable.billingDateRequest && reqNote ? reqNote : null,
        activationNote: data?.editable.notes && note ? note : null,
        requestedCancellationDate: !finalPaid && data?.editable.cancellationDate && cancelDate ? cancelDate : null,
        selectedOptionLabel: canChoosePlan ? selectedOptionLabel || null : null,
        paymentMethod: finalPaid ? "CARD" : paymentMethod,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) { setError(typeof d.error === "string" ? d.error : "Could not complete activation."); return; }
    if (d.url) { window.location.href = d.url; return; }
    if (d.noPayment || d.finalPeriod || d.joined) { setSuccessMsg(d.message || "Your account is activated."); return; }
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

  const done = justDone || data.completed || data.pendingApproval || !!data.joined || !!successMsg;
  const doneMsg = data.joined
    ? successMsg || `You're in, ${data.member.firstName}! Your ${data.club.name} account is ready — sign in to explore memberships, classes, and events.`
    : data.completed
      ? `Thanks, ${data.member.firstName}! Your membership at ${data.club.name} is active and continuing without interruption.`
      : successMsg ||
        `Thanks, ${data.member.firstName}! Your details and payment method are saved. ${data.club.name} will review and confirm your billing — you have not been charged, and won't be until they approve and your billing date arrives.`;

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
              <p className="text-stone-700 leading-relaxed">{doneMsg}</p>
              <p className="text-sm text-stone-500 mt-3">
                You can sign in any time at the {data.club.name} member portal.
              </p>
            </div>
          ) : isJoin ? (
            <>
              <p className="text-sm text-stone-600 leading-relaxed mb-5">
                Create your free <strong>{data.club.name}</strong> account to browse memberships,
                classes, and events — and sign up for whatever's right for you.{" "}
                <strong>No payment needed to get started.</strong>
              </p>
              <div className="space-y-4 mb-5">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Email</label>
                  <input
                    value={data.editable.email ? email : data.member.email || data.member.guardianEmail || ""}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={!data.editable.email}
                    className={`w-full px-3 py-2 border rounded-lg text-sm ${data.editable.email ? "border-stone-300" : "border-stone-200 bg-stone-50 text-stone-500"}`}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Phone</label>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)}
                    disabled={!data.editable.phone}
                    className={`w-full px-3 py-2 border rounded-lg text-sm ${data.editable.phone ? "border-stone-300" : "border-stone-200 bg-stone-50 text-stone-500"}`}
                    placeholder="(555) 555-5555" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Create a password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" placeholder="At least 8 characters" />
                </div>
              </div>
              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>}
              <button onClick={submit} disabled={submitting}
                className="w-full py-3 rounded-xl text-white font-semibold disabled:opacity-50" style={{ background: accent }}>
                {submitting ? "Creating…" : "Create my free account"}
              </button>
              <p className="text-[11px] text-stone-400 text-center mt-3">
                Free account · Powered by AthletixOS. We never ask for card details over email.
              </p>
            </>
          ) : (
            <>
              {finalPaid ? (
                <p className="text-sm text-stone-600 leading-relaxed mb-5">
                  <strong>{data.club.name}</strong> has moved to AthletixOS. Your membership is already
                  paid through the end of your term — just set a password to access your member portal.{" "}
                  <strong>Nothing is due.</strong>
                </p>
              ) : (
                <p className="text-sm text-stone-600 leading-relaxed mb-5">
                  <strong>{data.club.name}</strong> has moved to AthletixOS. We've prepared your account
                  from your previous club software. Confirm your details{data.paymentEnabled ? " and choose how to pay" : ""} to
                  keep your membership going — you won't be charged today.
                </p>
              )}

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
                    <p className="text-[11px] text-stone-400">{finalPaid ? "Active through" : "Next billing"}</p>
                    <p>{finalPaid
                      ? (data.membership.commitmentEndDate ? new Date(data.membership.commitmentEndDate).toLocaleDateString() : "End of term")
                      : (data.membership.nextBillingDate ? new Date(data.membership.nextBillingDate).toLocaleDateString() : "After activation")}</p>
                  </div>
                </div>
                {finalPaid ? (
                  <p className="text-xs text-emerald-300 mt-3">Paid in full — no further payments.</p>
                ) : displayPrice != null && (
                  <p className="text-xs text-stone-400 mt-3">
                    ${displayPrice.toFixed(2)}{displayFrequency ? ` / ${displayFrequency.toLowerCase()}` : ""}
                    {data.membership.commitmentEndDate ? ` · commitment through ${new Date(data.membership.commitmentEndDate).toLocaleDateString()}` : ""}
                  </p>
                )}
              </div>

              {/* Plan / price option picker */}
              {canChoosePlan && (
                <div className="mb-5">
                  <label className="block text-sm font-medium text-stone-700 mb-2">Choose your plan</label>
                  <div className="space-y-2">
                    {opts.map((o) => (
                      <label key={o.label}
                        className={`flex items-center justify-between gap-3 px-3 py-2.5 border rounded-lg text-sm cursor-pointer ${selectedOptionLabel === o.label ? "border-stone-900 bg-stone-50" : "border-stone-300"}`}>
                        <span className="flex items-center gap-2">
                          <input type="radio" name="plan" checked={selectedOptionLabel === o.label}
                            onChange={() => setSelectedOptionLabel(o.label)} />
                          <span className="font-medium text-stone-800">{o.label}</span>
                        </span>
                        <span className="text-stone-600">${o.price.toFixed(2)}<span className="text-stone-400"> / {o.billingPeriod.toLowerCase()}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Confirm profile */}
              <div className="space-y-4 mb-5">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Email</label>
                  <input
                    value={data.editable.email ? email : data.member.email || data.member.guardianEmail || ""}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={!data.editable.email}
                    className={`w-full px-3 py-2 border rounded-lg text-sm ${data.editable.email ? "border-stone-300" : "border-stone-200 bg-stone-50 text-stone-500"}`}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Phone</label>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)}
                    disabled={!data.editable.phone}
                    className={`w-full px-3 py-2 border rounded-lg text-sm ${data.editable.phone ? "border-stone-300" : "border-stone-200 bg-stone-50 text-stone-500"}`}
                    placeholder="(555) 555-5555" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Create a password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" placeholder="At least 8 characters" />
                </div>
                {!finalPaid && data.editable.billingDateRequest && (
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">
                      Request a different billing date <span className="text-stone-400 font-normal">(optional)</span>
                    </label>
                    <input type="date" value={reqDate} onChange={(e) => setReqDate(e.target.value)}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
                    <input value={reqNote} onChange={(e) => setReqNote(e.target.value)}
                      placeholder="Why? (optional — your club reviews this)"
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm mt-2" />
                  </div>
                )}
                {!finalPaid && data.editable.cancellationDate && (
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">
                      Cancellation date <span className="text-stone-400 font-normal">(optional)</span>
                    </label>
                    <input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
                    <p className="text-[11px] text-stone-400 mt-1">When you'd like your membership to end. Your club reviews this.</p>
                  </div>
                )}
                {data.editable.notes && (
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">
                      Note for your club <span className="text-stone-400 font-normal">(optional)</span>
                    </label>
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
                      placeholder="Anything the club should know" />
                  </div>
                )}
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

              {/* Payment method choice */}
              {!finalPaid && data.editable.paymentChoice && data.paymentEnabled && (
                <div className="mb-5">
                  <label className="block text-sm font-medium text-stone-700 mb-2">How would you like to pay?</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(["CARD", "CASH", "CHECK"] as const).map((m) => (
                      <button key={m} type="button" onClick={() => setPaymentMethod(m)}
                        className={`px-3 py-2 border rounded-lg text-sm font-medium ${paymentMethod === m ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 text-stone-700"}`}>
                        {m === "CARD" ? "Card" : m === "CASH" ? "Cash" : "Check"}
                      </button>
                    ))}
                  </div>
                  {paymentMethod !== "CARD" && (
                    <p className="text-[11px] text-stone-500 mt-2">
                      Paying by {paymentMethod.toLowerCase()} — your club confirms the payment and approves your membership before it goes active.
                    </p>
                  )}
                </div>
              )}

              {/* Autopay — only when paying by card */}
              {!finalPaid && paymentMethod === "CARD" && (
                <label className="flex items-start gap-2 text-sm text-stone-700 mb-5">
                  <input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} className="mt-0.5" />
                  <span>
                    I authorize {data.club.name} to automatically charge my payment method for this
                    membership on its recurring billing date. {data.paymentEnabled
                      ? "I'll add my card on the next secure step. The club reviews and confirms my billing — I'm not charged today."
                      : "The club will confirm billing details with me."}
                  </span>
                </label>
              )}

              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>}

              <button
                onClick={submit}
                disabled={submitting}
                className="w-full py-3 rounded-xl text-white font-semibold disabled:opacity-50"
                style={{ background: accent }}
              >
                {submitting
                  ? "Activating…"
                  : finalPaid
                    ? "Activate my account"
                    : paymentMethod === "CARD" && data.paymentEnabled
                      ? "Activate & add payment method"
                      : paymentMethod === "CASH"
                        ? "Activate — pay by cash"
                        : paymentMethod === "CHECK"
                          ? "Activate — pay by check"
                          : "Activate my account"}
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
