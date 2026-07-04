"use client";

// Public registration link — /join/[slug]?m=<membershipId> or ?goal=privates.
//
// Opens directly to the selected membership (with any free trial called out)
// or to a "book a private lesson" pitch, with club branding — then funnels
// into the EXISTING signup/onboarding (no new billing surface). Owners copy
// these links from Dashboard → Memberships / Privates and drop them on a
// website, email, or social post. Unauthenticated + read-only.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Opt = { label: string; price: number; billingPeriod: string };
type Data = {
  club: {
    name: string;
    slug: string;
    logoUrl: string | null;
    primaryColor: string | null;
    tagline: string | null;
  };
  membership: {
    id: string;
    name: string;
    description: string | null;
    options: unknown;
    trialEnabled?: boolean;
    trialDays?: number | null;
  } | null;
};

const periodLabels: Record<string, string> = {
  WEEKLY: "per week",
  MONTHLY: "per month",
  QUADRIMESTRAL: "per 4 months",
  QUARTERLY: "per 3 months",
  SEMI_ANNUAL: "per 6 months",
  ANNUAL: "per year",
  ONE_TIME: "one-time",
};

function parseOptions(raw: unknown): Opt[] {
  if (Array.isArray(raw)) return raw as Opt[];
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

export default function JoinPage() {
  const params = useParams<{ slug: string }>();
  const slug = (params?.slug ?? "").toString();
  const [membershipId, setMembershipId] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!slug) return;
    const sp = new URLSearchParams(window.location.search);
    const m = sp.get("m");
    setGoal(sp.get("goal"));
    setMembershipId(m);
    const qs = new URLSearchParams({ club: slug });
    if (m) qs.set("id", m);
    fetch(`/api/public/membership?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.club) setData(d);
        else setError(true);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [slug]);

  const brand =
    data?.club.primaryColor && /^#[0-9a-fA-F]{6}$/.test(data.club.primaryColor)
      ? data.club.primaryColor
      : "#534AB7";
  // ?goal=privates deep-links straight to the private-lesson request page
  // after the account exists (signup + login both honor a /member-scoped
  // `next`).
  const isPrivates = goal === "privates";
  const nextParam = isPrivates ? `&next=${encodeURIComponent("/member/privates")}` : "";
  const signupHref = `/member/signup?club=${encodeURIComponent(slug)}${
    membershipId ? `&membership=${encodeURIComponent(membershipId)}` : ""
  }${nextParam}`;
  const loginHref = `/login?club=${encodeURIComponent(slug)}${nextParam}`;
  const opts = parseOptions(data?.membership?.options);
  const trialDays = data?.membership?.trialEnabled ? data.membership.trialDays ?? 0 : 0;

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {loading ? (
          <div className="bg-white rounded-2xl border border-stone-200 p-8 text-center">
            <div className="h-6 w-32 mx-auto mb-4 rounded bg-stone-100 animate-pulse" />
            <div className="h-24 rounded-xl bg-stone-100 animate-pulse" />
          </div>
        ) : error || !data ? (
          <div className="bg-white rounded-2xl border border-stone-200 p-8 text-center">
            <h1 className="text-lg font-semibold text-stone-900 mb-1">Link not available</h1>
            <p className="text-sm text-stone-500">
              This registration link is no longer active. Please contact the club for help.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden shadow-sm">
            {/* Branded header */}
            <div className="p-6 text-center border-b border-stone-100">
              {data.club.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={data.club.logoUrl}
                  alt=""
                  className="w-16 h-16 rounded-xl mx-auto mb-3 object-cover"
                />
              ) : (
                <div
                  className="w-16 h-16 rounded-xl mx-auto mb-3 flex items-center justify-center text-white text-2xl font-bold"
                  style={{ background: brand }}
                >
                  {data.club.name.charAt(0)}
                </div>
              )}
              <h1 className="text-xl font-bold text-stone-900">{data.club.name}</h1>
              {data.club.tagline && (
                <p className="text-sm text-stone-500 mt-0.5">{data.club.tagline}</p>
              )}
            </div>

            <div className="p-6">
              {data.membership ? (
                <>
                  <p className="text-xs uppercase tracking-wider text-stone-400 font-semibold mb-1">
                    Register for
                  </p>
                  <h2 className="text-lg font-semibold text-stone-900">{data.membership.name}</h2>
                  {trialDays > 0 && (
                    <span
                      className="inline-block mt-1.5 text-xs font-semibold text-white rounded-full px-3 py-1"
                      style={{ background: brand }}
                    >
                      {trialDays}-day free trial
                    </span>
                  )}
                  {data.membership.description && (
                    <p className="text-sm text-stone-500 mt-1">{data.membership.description}</p>
                  )}
                  {opts.length > 0 && (
                    <div className="mt-4 space-y-1.5 rounded-xl bg-stone-50 p-4">
                      {opts.map((o, i) => (
                        <div key={i} className="flex items-center justify-between text-sm">
                          <span className="text-stone-700">{o.label}</span>
                          <span className="text-stone-900 font-medium">
                            ${Number(o.price).toFixed(2)}{" "}
                            <span className="text-stone-400 font-normal">
                              {periodLabels[o.billingPeriod] || o.billingPeriod}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : isPrivates ? (
                <div className="text-center">
                  <h2 className="text-lg font-semibold text-stone-900">
                    Book a private lesson at {data.club.name}
                  </h2>
                  <p className="text-sm text-stone-500 mt-1">
                    1-on-1 coaching — pick a coach and request times that work for you.
                    Create a free account to send your request.
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <h2 className="text-lg font-semibold text-stone-900">Join {data.club.name}</h2>
                  <p className="text-sm text-stone-500 mt-1">
                    Create your account to get started.
                  </p>
                </div>
              )}

              <a
                href={signupHref}
                className="mt-6 block w-full text-center text-white font-semibold rounded-xl py-3 transition hover:opacity-90"
                style={{ background: brand }}
              >
                {isPrivates ? "Create account & book" : "Create account & register"}
              </a>
              <a
                href={loginHref}
                className="mt-2 block w-full text-center text-stone-600 font-medium rounded-xl py-3 border border-stone-200 hover:bg-stone-50 transition"
              >
                I already have an account
              </a>
              <p className="text-[11px] text-stone-400 text-center mt-4 leading-relaxed">
                You&apos;ll confirm your details and any required club documents during signup.
                No payment is taken until you complete registration.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
