"use client";

// Public, token-gated membership reactivation page (mobile-first). The client
// already has an account — no onboarding here. They review the owner-approved
// terms and confirm. Charge timing is spelled out ON the button; an
// immediate charge additionally requires an explicit checkbox. If no usable
// payment method exists, a secure Stripe setup page collects one — card
// details never touch AthletixOS.

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

type Payload = {
  confirmed?: boolean;
  athleteName?: string;
  confirmedAt?: string;
  error?: string;
  code?: string;
  club?: { name: string; logoUrl: string | null; primaryColor: string | null; contactEmail?: string | null };
  athlete?: { firstName: string; lastName: string; isMinor: boolean };
  offer?: {
    planName: string; optionLabel: string | null; price: number; billingPeriod: string;
    periodLabel: string; startDate: string | null; firstChargeDate: string | null;
    commitmentEndDate: string | null; paymentMode: string; autoRenew?: boolean; offerVersion: number;
  };
  // Processing-fee breakdown (dollars): totalCharged is the EXACT card charge —
  // it matches what the confirm route creates on Stripe.
  fees?: { passFees: boolean; base: number; fee: number; totalCharged: number };
  // OPEN = the club is reviewing a change request — confirmation is locked.
  changeRequestStatus?: string | null;
  chargeTiming?: { immediate: boolean; isFree: boolean };
  card?: { brand: string; last4: string; cardholder: string | null } | null;
  hasUsableCard?: boolean;
  payerName?: string | null;
  personalNote?: string | null;
  tokenExpires?: string;
  terms?: { authorization: string };
};

// Billing dates are date-only values pinned to 00:00 UTC — format in UTC so
// the page shows the same calendar day the owner approved.
const longDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;

export default function ReactivatePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const search = useSearchParams();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ackImmediate, setAckImmediate] = useState(false);
  const [done, setDone] = useState<{ chargedNow: boolean; firstChargeDate: string | null } | null>(null);
  const [cardPoll, setCardPoll] = useState(0);

  const load = useCallback(() => {
    fetch(`/api/reactivate/${token}`)
      .then(async (r) => ({ ok: r.ok, body: (await r.json().catch(() => ({}))) as Payload }))
      .then(({ body }) => { setData(body); setLoading(false); })
      .catch(() => { setData({ error: "Something went wrong. Refresh to try again." }); setLoading(false); });
  }, [token]);
  useEffect(() => { load(); }, [load]);

  // Back from Stripe card entry: the webhook may land a beat after the
  // redirect, so poll a few times until the saved card shows up.
  useEffect(() => {
    if (!search.get("card_saved")) return;
    if (data?.hasUsableCard) return;
    if (cardPoll >= 5) return;
    const t = setTimeout(() => { setCardPoll((n) => n + 1); load(); }, 2000);
    return () => clearTimeout(t);
  }, [search, data?.hasUsableCard, cardPoll, load]);

  const brand = data?.club?.primaryColor && /^#[0-9a-fA-F]{6}$/.test(data.club.primaryColor)
    ? data.club.primaryColor
    : "#534AB7";

  const addCard = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/reactivate/${token}/payment-setup`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok && d.url) window.location.href = d.url;
    else setErr(d.error || "Could not open the secure card page.");
  };

  const confirm = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/reactivate/${token}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledgeImmediateCharge: ackImmediate }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) setDone({ chargedNow: !!d.chargedNow, firstChargeDate: d.firstChargeDate ?? null });
    else if (d.code === "NEEDS_PAYMENT_METHOD") setErr("Add a payment method below first — then confirm.");
    else setErr(d.error || "The confirmation couldn't be completed. Nothing was finalized.");
  };

  if (loading) {
    return <Shell brand={brand}><p className="text-center text-stone-500 text-sm py-10">Loading your membership…</p></Shell>;
  }
  if (!data || (data.error && !data.offer)) {
    return (
      <Shell brand={brand} club={data?.club}>
        <div className="text-center py-8">
          <p className="text-stone-800 font-medium">{data?.error || "This link isn't valid."}</p>
          {data?.code === "EXPIRED" && (
            <p className="text-sm text-stone-500 mt-2">Links expire for your security. Contact the club and they&apos;ll send a fresh one.</p>
          )}
        </div>
      </Shell>
    );
  }
  if (data.confirmed || done) {
    const chargedNow = done?.chargedNow ?? false;
    return (
      <Shell brand={brand} club={data.club}>
        <div className="text-center py-8">
          <div className="w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl text-white mb-4" style={{ background: brand }}>✓</div>
          <h2 className="text-xl font-semibold text-stone-900">Membership confirmed</h2>
          <p className="text-sm text-stone-600 mt-2">
            {done
              ? chargedNow
                ? "Your first payment was processed today. A receipt is on its way to your email."
                : done.firstChargeDate
                  ? `Nothing was charged today — your first payment runs on ${longDate(done.firstChargeDate)}. A confirmation email is on its way.`
                  : "You're all set — a confirmation email is on its way."
              : `This membership was already confirmed${data.confirmedAt ? ` on ${longDate(data.confirmedAt)}` : ""}. You're all set.`}
          </p>
          <a href="/member" className="inline-block mt-5 text-sm font-medium text-white rounded-xl px-6 py-3" style={{ background: brand }}>
            Go to your member portal
          </a>
        </div>
      </Shell>
    );
  }

  const offer = data.offer!;
  const timing = data.chargeTiming!;
  const isFree = timing.isFree;
  const needsCard = offer.paymentMode === "CARD" && !data.hasUsableCard;
  const firstChargeLabel = longDate(offer.firstChargeDate);
  // The club may pass the card processing fee — every stated amount must be
  // the EXACT total the card is charged (matches the confirm route).
  const hasFee = !!data.fees?.passFees && (data.fees?.fee ?? 0) > 0;
  const totalCharged = data.fees?.totalCharged ?? offer.price;
  const btnLabel = isFree
    ? "Confirm membership"
    : offer.paymentMode === "OFFLINE"
      ? "Confirm membership — the club collects payment offline"
      : timing.immediate
        ? `Confirm membership — $${totalCharged.toFixed(2)} charged today`
        : `Confirm membership — first payment ${firstChargeLabel}`;

  return (
    <Shell brand={brand} club={data.club}>
      <h1 className="text-xl font-semibold text-stone-900">
        Confirm {data.athlete?.firstName}&apos;s membership
      </h1>
      <p className="text-sm text-stone-600 mt-1 mb-4">
        {data.club?.name} set this up for you — review it and confirm. You already have an account; there&apos;s
        nothing else to fill out.
      </p>

      {data.personalNote && (
        <div className="rounded-xl px-4 py-3 mb-4 bg-stone-50 border-l-4" style={{ borderColor: brand }}>
          <p className="text-[11px] font-bold uppercase tracking-wide text-stone-500 mb-1">A note from {data.club?.name}</p>
          <p className="text-sm text-stone-700 whitespace-pre-line">{data.personalNote}</p>
        </div>
      )}

      <div className="rounded-2xl border border-stone-200 divide-y divide-stone-100 mb-4">
        <Item label="Athlete" value={`${data.athlete?.firstName} ${data.athlete?.lastName}`} />
        <Item label="Membership" value={`${offer.planName}${offer.optionLabel ? ` · ${offer.optionLabel}` : ""}`} />
        <Item label="Price" value={isFree ? "Free" : `$${offer.price.toFixed(2)} ${offer.periodLabel}`} />
        {hasFee && <Item label="Processing fee" value={`+ $${data.fees!.fee.toFixed(2)}`} />}
        {hasFee && <Item label="Total charged" value={`$${totalCharged.toFixed(2)} ${offer.periodLabel}`} />}
        {offer.startDate && <Item label="Membership start" value={longDate(offer.startDate)!} />}
        {!isFree && offer.paymentMode === "CARD" && (
          <Item
            label="First payment"
            value={timing.immediate ? "Today, when you confirm" : firstChargeLabel || "—"}
            highlight={timing.immediate}
          />
        )}
        {!isFree && !timing.immediate && offer.paymentMode === "CARD" && (
          <Item label="Then recurring" value={offer.periodLabel} />
        )}
        {offer.commitmentEndDate && <Item label="Commitment through" value={longDate(offer.commitmentEndDate)!} />}
        {!isFree && (
          <Item
            label="Renewal"
            value={
              offer.autoRenew === false
                ? offer.commitmentEndDate
                  ? `Ends on ${longDate(offer.commitmentEndDate)} — does not auto-renew`
                  : "Does not auto-renew"
                : `Renews automatically ${offer.periodLabel}`
            }
          />
        )}
        {offer.paymentMode === "CARD" && (
          <Item
            label="Payment method"
            value={
              data.card
                ? `${data.card.brand} ···· ${data.card.last4}${data.card.cardholder ? ` (${data.card.cardholder})` : ""}`
                : needsCard
                  ? "None on file yet"
                  : "Saved method on file"
            }
          />
        )}
        {data.payerName && <Item label="Billed to" value={data.payerName} />}
      </div>

      {needsCard && (
        <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 mb-4">
          <p className="text-sm text-stone-700 mb-2">
            Add a payment method to continue. You&apos;ll enter it on a secure Stripe page — nothing is charged when you
            save it.
          </p>
          <button disabled={busy} onClick={addCard} className="w-full text-sm font-medium text-white rounded-xl px-4 py-3" style={{ background: brand }}>
            {busy ? "Opening…" : "Add payment method securely"}
          </button>
          {search.get("card_saved") && !data.hasUsableCard && (
            <p className="text-xs text-stone-500 mt-2">Waiting for your saved card to register… this takes a few seconds.</p>
          )}
        </div>
      )}

      {!isFree && offer.paymentMode === "CARD" && timing.immediate && (
        <label className="flex items-start gap-2 text-sm text-stone-700 mb-4 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3">
          <input type="checkbox" checked={ackImmediate} onChange={(e) => setAckImmediate(e.target.checked)} className="mt-0.5" />
          <span>
            I understand <strong>${totalCharged.toFixed(2)} is charged today</strong>
            {hasFee ? <> (${offer.price.toFixed(2)} membership + ${data.fees!.fee.toFixed(2)} processing fee)</> : null} when
            I confirm, and the membership then renews {offer.periodLabel}.
          </span>
        </label>
      )}

      {err && <p className="text-sm text-red-600 mb-3">{err}</p>}

      {data.changeRequestStatus === "OPEN" ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 mb-3">
          <p className="text-sm text-amber-800 font-medium">Change request with the club</p>
          <p className="text-xs text-amber-700 mt-1">
            You asked for changes to this offer, so it can&apos;t be confirmed while {data.club?.name} reviews them.
            They&apos;ll send an updated offer or respond shortly. Nothing has been charged.
          </p>
        </div>
      ) : (
        <button
          disabled={busy || needsCard || (timing.immediate && !isFree && offer.paymentMode === "CARD" && !ackImmediate)}
          onClick={confirm}
          className="w-full text-[15px] font-semibold text-white rounded-xl px-4 py-3.5 disabled:opacity-50"
          style={{ background: brand }}
        >
          {busy ? "Confirming…" : btnLabel}
        </button>
      )}

      {data.changeRequestStatus !== "OPEN" && (
        <ChangeRequestSection token={token} brand={brand} clubName={data.club?.name ?? "the club"} onSubmitted={load} />
      )}

      <p className="text-xs text-stone-500 mt-3 leading-relaxed">{data.terms?.authorization}</p>
      <p className="text-xs text-stone-400 mt-2 leading-relaxed">
        This secure link expires {longDate(data.tokenExpires)}. If anything looks wrong, don&apos;t confirm —
        contact {data.club?.name}{data.club?.contactEmail ? ` at ${data.club.contactEmail}` : ""} and they&apos;ll fix it first.
      </p>
    </Shell>
  );
}

// "Request a change" — the client asks the club to adjust the offer instead of
// confirming it. NEVER changes billing (and there is deliberately no price
// field); submitting locks this offer's confirmation until the club responds.
function ChangeRequestSection({
  token,
  brand,
  clubName,
  onSubmitted,
}: {
  token: string;
  brand: string;
  clubName: string;
  onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [membership, setMembership] = useState("");
  const [option, setOption] = useState("");
  const [billingDate, setBillingDate] = useState("");
  const [frequency, setFrequency] = useState("");
  const [payer, setPayer] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/reactivate/${token}/change-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestedMembership: membership || null,
        requestedOption: option || null,
        requestedBillingDate: billingDate || null,
        requestedFrequency: frequency || null,
        requestedPayer: payer || null,
        requestedPaymentMethod: payMethod || null,
        note: note || null,
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      setSent(true);
      onSubmitted();
    } else setErr(d.error || "The request couldn't be sent — try again.");
  };

  if (sent) {
    return (
      <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 mt-3">
        <p className="text-sm text-stone-800 font-medium">Request sent ✓</p>
        <p className="text-xs text-stone-500 mt-1">
          {clubName} will review it and send an updated offer or respond. This offer can&apos;t be confirmed until then.
        </p>
      </div>
    );
  }

  const inputCls =
    "mt-1 w-full border border-stone-200 rounded-lg px-2.5 py-2 text-sm text-stone-900 bg-white";
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-sm font-medium text-stone-600 border border-stone-200 rounded-xl px-4 py-2.5 hover:bg-stone-50"
      >
        {open ? "Cancel change request" : "Something not right? Request a change instead"}
      </button>
      {open && (
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 mt-2 space-y-3">
          <p className="text-xs text-stone-500">
            Tell {clubName} what you&apos;d like different — nothing changes or gets charged until they approve and
            send you an updated offer.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-stone-500">Different membership
              <input value={membership} onChange={(e) => setMembership(e.target.value)} placeholder="e.g. Monthly plan" className={inputCls} />
            </label>
            <label className="text-xs text-stone-500">Different purchase option
              <input value={option} onChange={(e) => setOption(e.target.value)} placeholder="e.g. 1 Year" className={inputCls} />
            </label>
            <label className="text-xs text-stone-500">Preferred billing date
              <input type="date" value={billingDate} onChange={(e) => setBillingDate(e.target.value)} className={inputCls} />
            </label>
            <label className="text-xs text-stone-500">Billing frequency
              <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={inputCls}>
                <option value="">No change</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
                <option value="SEMI_ANNUAL">Every 6 months</option>
                <option value="ANNUAL">Yearly</option>
              </select>
            </label>
            <label className="text-xs text-stone-500">Different payer
              <input value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="Name or email" className={inputCls} />
            </label>
            <label className="text-xs text-stone-500">Payment method
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className={inputCls}>
                <option value="">No change</option>
                <option value="CARD">Card on file</option>
                <option value="NEW_CARD">A different card</option>
                <option value="CASH">Cash</option>
                <option value="CHECK">Check</option>
              </select>
            </label>
          </div>
          <label className="text-xs text-stone-500 block">Anything else
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000}
              placeholder="Describe what you'd like changed…" className={inputCls} />
          </label>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <button
            disabled={busy}
            onClick={submit}
            className="w-full text-sm font-semibold text-white rounded-xl px-4 py-2.5 disabled:opacity-50"
            style={{ background: brand }}
          >
            {busy ? "Sending…" : "Send request to the club"}
          </button>
        </div>
      )}
    </div>
  );
}

function Item({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5">
      <span className="text-xs text-stone-500 pt-0.5 whitespace-nowrap">{label}</span>
      <span className={`text-sm text-right font-medium ${highlight ? "text-orange-600" : "text-stone-900"}`}>{value}</span>
    </div>
  );
}

function Shell({ brand, club, children }: { brand: string; club?: Payload["club"]; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-stone-100 py-6 px-4">
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl overflow-hidden border border-stone-200 bg-white shadow-sm">
          <div className="px-5 py-5 text-center" style={{ background: brand }}>
            {club?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={club.logoUrl} alt={club?.name || ""} className="w-14 h-14 rounded-2xl object-cover mx-auto mb-2" />
            ) : (
              <div className="w-14 h-14 rounded-2xl bg-white/20 text-white text-xl font-bold flex items-center justify-center mx-auto mb-2">
                {(club?.name?.[0] || "A").toUpperCase()}
              </div>
            )}
            <p className="text-white/95 text-sm font-semibold">{club?.name || "AthletixOS"}</p>
          </div>
          <div className="p-5">{children}</div>
        </div>
        <p className="text-center text-[11px] text-stone-400 mt-3">Secure membership confirmation · powered by AthletixOS</p>
      </div>
    </div>
  );
}
