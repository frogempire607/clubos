"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Ticket, Sparkles } from "lucide-react";
import ProfileSwitcher, { type AccessibleProfile } from "@/components/ProfileSwitcher";

type Option = { label: string; price: number; billingPeriod: string };
type Membership = {
  id: string;
  name: string;
  description: string | null;
  options: string;
  autoRenewDefault: boolean;
  contractMonths: number | null;
  trialEnabled: boolean;
  trialDays: number | null;
  trialAppliesToReturning: boolean;
};
type ActiveSub = { id: string; membershipId: string; optionLabel: string; status: string };

const periodLabel: Record<string, string> = {
  WEEKLY: "/wk",
  MONTHLY: "/mo",
  QUADRIMESTRAL: "/4mo",
  QUARTERLY: "/qtr",
  SEMI_ANNUAL: "/6mo",
  ANNUAL: "/yr",
  ONE_TIME: " one-time",
};

export default function MemberMembershipsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeByMember, setActiveByMember] = useState<Record<string, ActiveSub[]>>({});
  const [accessible, setAccessible] = useState<AccessibleProfile[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [hasMemberProfile, setHasMemberProfile] = useState(true);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Option key currently showing the card / cash-check payment choice.
  const [choosingKey, setChoosingKey] = useState<string | null>(null);
  const [discountCode, setDiscountCode] = useState("");

  useEffect(() => {
    fetch("/api/member/memberships")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setMemberships(d.memberships || []);
          setActiveByMember(d.activeByMember || {});
          setAccessible(d.accessible || []);
          setSelectedMemberId(d.defaultMemberId ?? d.accessible?.[0]?.id ?? null);
          setHasMemberProfile(d.hasMemberProfile);
        }
        setLoading(false);
      });
  }, []);

  // Subscriptions for the currently selected profile (self or chosen child).
  const activeSubs: ActiveSub[] = selectedMemberId ? activeByMember[selectedMemberId] ?? [] : [];

  async function subscribe(membershipId: string, optionLabel: string, paymentMethod: "CARD" | "CASH" | "CHECK") {
    const key = `${membershipId}:${optionLabel}`;
    setSubmitting(key);
    setError("");
    setNotice("");
    const res = await fetch("/api/member/memberships/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ membershipId, optionLabel, memberId: selectedMemberId, paymentMethod, discountCode: discountCode.trim() || null }),
    });
    const d = await res.json().catch(() => ({}));
    // Cash/check (and parental-approval) requests queue instead of redirecting.
    if (res.status === 202 || d.queued) {
      setSubmitting(null);
      setChoosingKey(null);
      setNotice(typeof d.message === "string" && d.message ? d.message : "Request sent — your club will confirm it shortly.");
      return;
    }
    if (!res.ok || !d.url) {
      setSubmitting(null);
      setError(d.error || "Could not start checkout");
      return;
    }
    window.location.href = d.url;
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Memberships</h1>
          <p className="text-sm text-stone-500">Browse and join your club's membership plans.</p>
        </div>
        <Link href="/member/shop" className="text-xs text-stone-500 hover:text-stone-900">All purchase options →</Link>
      </div>

      <ProfileSwitcher
        accessible={accessible}
        value={selectedMemberId}
        onChange={setSelectedMemberId}
        label="Membership for"
      />

      {!hasMemberProfile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
          Your account isn't linked to a member profile yet. Ask your club to add you, or contact them to purchase on your behalf.
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {notice && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800 mb-4">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : memberships.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Ticket className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-base font-medium text-stone-900 mb-1">No plans available</p>
          <p className="text-sm text-stone-500">Your club hasn&apos;t published any membership plans yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {memberships.map((m) => {
            let opts: Option[] = [];
            try { opts = JSON.parse(m.options); } catch {}
            const activeForThis = activeSubs.find((s) => s.membershipId === m.id);

            return (
              <div key={m.id} className="bg-white rounded-xl border border-stone-200 p-5">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <h3 className="text-base font-semibold text-stone-900">{m.name}</h3>
                    {m.description && (
                      <p className="text-sm text-stone-600 mt-1 whitespace-pre-wrap">{m.description}</p>
                    )}
                  </div>
                  {activeForThis && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-medium flex-shrink-0">
                      Current
                    </span>
                  )}
                </div>

                {m.trialEnabled && (m.trialDays ?? 0) > 0 && (
                  <div className="inline-flex items-center gap-1.5 mt-2 mb-1 px-2.5 py-1 rounded-full bg-lime-accent/20 text-charcoal text-xs font-semibold">
                    <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} />
                    {m.trialDays}-day free trial
                    {!m.trialAppliesToReturning && (
                      <span className="font-normal text-stone-600">· new members</span>
                    )}
                  </div>
                )}

                {m.contractMonths && (
                  <p className="text-xs text-stone-500 mb-3">{m.contractMonths}-month minimum commitment</p>
                )}

                {activeForThis ? (
                  // The selected profile is already on this membership — show it
                  // as their current plan instead of Subscribe buttons. (The sub's
                  // optionLabel can be the plan name from migration, not an option
                  // label, so we match on membership, not exact option.)
                  <div className="mt-3 rounded-lg bg-green-50 border border-green-200 px-3 py-2.5 text-sm text-green-800">
                    ✓ This is the current plan on this profile
                    {activeForThis.optionLabel ? <> — <span className="font-medium">{activeForThis.optionLabel}</span></> : null}.
                    <span className="block text-xs text-green-700 mt-0.5">
                      Update the card or cancel from Profile → Payment &amp; billing.
                    </span>
                  </div>
                ) : (
                  <div className="space-y-2 mt-3">
                    {opts.map((o) => {
                      const key = `${m.id}:${o.label}`;
                      const choosing = choosingKey === key;
                      return (
                        <div key={o.label} className="border border-stone-200 rounded-lg px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-stone-900">{o.label}</p>
                              <p className="text-xs text-stone-500">
                                ${o.price.toFixed(2)}
                                <span>{periodLabel[o.billingPeriod] ?? ""}</span>
                              </p>
                            </div>
                            <button
                              disabled={!hasMemberProfile || submitting === key}
                              onClick={() => setChoosingKey(choosing ? null : key)}
                              className="px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-700 disabled:opacity-50 flex-shrink-0"
                            >
                              {submitting === key ? "Starting…" : "Subscribe"}
                            </button>
                          </div>
                          {choosing && (
                            <div className="mt-2 pt-2 border-t border-stone-100">
                              <input
                                type="text"
                                value={discountCode}
                                onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
                                placeholder="Discount code (optional)"
                                className="w-full mb-2 px-2.5 py-1.5 border border-stone-200 rounded-lg text-xs font-mono uppercase placeholder:font-sans placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-stone-400"
                              />
                              <p className="text-[11px] text-stone-500 mb-1.5">How will you pay?</p>
                              <div className="grid grid-cols-3 gap-2">
                                <button
                                  disabled={submitting === key}
                                  onClick={() => subscribe(m.id, o.label, "CARD")}
                                  className="px-2 py-1.5 rounded-lg text-xs font-medium bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-50"
                                >
                                  Card
                                </button>
                                <button
                                  disabled={submitting === key}
                                  onClick={() => subscribe(m.id, o.label, "CASH")}
                                  className="px-2 py-1.5 rounded-lg text-xs font-medium border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                                >
                                  Cash
                                </button>
                                <button
                                  disabled={submitting === key}
                                  onClick={() => subscribe(m.id, o.label, "CHECK")}
                                  className="px-2 py-1.5 rounded-lg text-xs font-medium border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                                >
                                  Check
                                </button>
                              </div>
                              <p className="text-[11px] text-stone-400 mt-1.5">
                                Card checks out securely online. Cash/check sends a request — your club
                                activates the membership and collects payment in person.
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
