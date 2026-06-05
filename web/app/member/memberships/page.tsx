"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Ticket, Sparkles } from "lucide-react";

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
  const [activeSubs, setActiveSubs] = useState<ActiveSub[]>([]);
  const [hasMemberProfile, setHasMemberProfile] = useState(true);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/member/memberships")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setMemberships(d.memberships || []);
          setActiveSubs(d.activeSubscriptions || []);
          setHasMemberProfile(d.hasMemberProfile);
        }
        setLoading(false);
      });
  }, []);

  async function subscribe(membershipId: string, optionLabel: string) {
    const key = `${membershipId}:${optionLabel}`;
    setSubmitting(key);
    setError("");
    const res = await fetch("/api/member/memberships/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ membershipId, optionLabel }),
    });
    const d = await res.json().catch(() => ({}));
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

                <div className="space-y-2 mt-3">
                  {opts.map((o) => {
                    const isCurrent = activeForThis?.optionLabel === o.label;
                    const key = `${m.id}:${o.label}`;
                    return (
                      <div
                        key={o.label}
                        className="flex items-center justify-between gap-3 border border-stone-200 rounded-lg px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-stone-900">{o.label}</p>
                          <p className="text-xs text-stone-500">
                            ${o.price.toFixed(2)}
                            <span>{periodLabel[o.billingPeriod] ?? ""}</span>
                          </p>
                        </div>
                        {isCurrent ? (
                          <span className="text-xs text-stone-500 px-3 py-1.5 flex-shrink-0">Active</span>
                        ) : (
                          <button
                            disabled={!hasMemberProfile || submitting === key}
                            onClick={() => subscribe(m.id, o.label)}
                            className="px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-700 disabled:opacity-50 flex-shrink-0"
                          >
                            {submitting === key ? "Starting…" : "Subscribe"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
