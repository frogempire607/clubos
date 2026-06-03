"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package, UserCheck, ArrowLeft } from "lucide-react";

type ShopPackage = {
  id: string;
  title: string;
  description: string | null;
  lessonType: { title: string } | null;
  lessonTypeIds: string[];
  credits: number;
  bonusCredits: number;
  price: number;
  expiresAfterDays: number | null;
};

export default function MemberPackageShopPage() {
  const [packages, setPackages] = useState<ShopPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // /success URL drops ?bought=1 / ?canceled=1 — translated to banner copy
  // so the user knows the redirect-back state. Webhook may not have fired
  // yet on the bought path, so the message intentionally says "soon".
  const [statusBanner, setStatusBanner] = useState<
    { kind: "success" | "info" | "warning"; text: string } | null
  >(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("bought")) {
      setStatusBanner({
        kind: "success",
        text: "Payment received — your package credits will appear in Private lessons shortly.",
      });
    } else if (p.get("canceled")) {
      setStatusBanner({
        kind: "info",
        text: "Checkout canceled — no payment was taken.",
      });
    }
    if (p.has("bought") || p.has("canceled")) {
      // Clean the URL so a refresh doesn't re-show the banner.
      window.history.replaceState({}, "", "/member/shop/packages");
    }
  }, []);

  useEffect(() => {
    fetch("/api/member/private-packages")
      .then((r) => (r.ok ? r.json() : { packages: [] }))
      .then((d) => {
        setPackages(Array.isArray(d?.packages) ? d.packages : []);
        setLoading(false);
      });
  }, []);

  async function buy(id: string) {
    setBuying(id);
    setError(null);
    try {
      const res = await fetch(`/api/member/private-packages/${id}/buy`, {
        method: "POST",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d?.url) {
        setError(d?.error || "Couldn't open checkout. Try again.");
        return;
      }
      window.location.href = d.url;
    } finally {
      setBuying(null);
    }
  }

  return (
    <>
      <div className="mb-4">
        <Link
          href="/member/shop"
          className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          Back to purchase options
        </Link>
      </div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Private lesson packages</h1>
        <p className="text-sm text-stone-500">
          Prepaid lesson packs from your club — saves money vs. booking lessons one at a time.
        </p>
      </div>

      {statusBanner && (
        <div
          className={`mb-4 rounded-lg px-3 py-2 text-sm border ${
            statusBanner.kind === "success"
              ? "bg-green-50 border-green-200 text-green-800"
              : statusBanner.kind === "warning"
                ? "bg-amber-50 border-amber-200 text-amber-800"
                : "bg-stone-50 border-stone-200 text-stone-700"
          }`}
        >
          {statusBanner.text}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg px-3 py-2 text-sm bg-red-50 border border-red-200 text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : packages.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Package className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-base font-medium text-stone-900 mb-1">
            No packages available yet
          </p>
          <p className="text-sm text-stone-500">
            Your club hasn&apos;t published any lesson packs to the member shop. You can
            still request individual private lessons from{" "}
            <Link href="/member/privates" className="underline">
              Private lessons
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {packages.map((p) => {
            const totalCredits = p.credits + (p.bonusCredits || 0);
            const perLesson = totalCredits > 0 ? p.price / totalCredits : p.price;
            return (
              <div
                key={p.id}
                className="bg-white rounded-xl border border-stone-200 p-5 flex flex-col"
              >
                <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
                  <UserCheck className="h-6 w-6" strokeWidth={2} />
                </div>
                <h3 className="text-base font-semibold text-stone-900">{p.title}</h3>
                {p.lessonType && (
                  <p className="text-xs text-stone-500 mt-0.5">
                    Good for {p.lessonType.title}
                  </p>
                )}
                {p.description && (
                  <p className="text-sm text-stone-600 mt-2">{p.description}</p>
                )}

                <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-stone-400">
                      Lessons
                    </p>
                    <p className="font-semibold text-stone-900 tabular-nums">
                      {p.credits}
                      {p.bonusCredits > 0 && (
                        <span className="text-stone-500 text-xs ml-1">
                          + {p.bonusCredits} bonus
                        </span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-stone-400">
                      Total
                    </p>
                    <p className="font-semibold text-stone-900 tabular-nums">
                      ${p.price.toFixed(2)}
                    </p>
                  </div>
                </div>

                <p className="mt-2 text-xs text-stone-500">
                  {totalCredits > 0 && (
                    <>
                      About <span className="tabular-nums">${perLesson.toFixed(2)}</span> per lesson
                    </>
                  )}
                  {p.expiresAfterDays && (
                    <>
                      {totalCredits > 0 ? " · " : ""}Expires {p.expiresAfterDays} day
                      {p.expiresAfterDays === 1 ? "" : "s"} after purchase
                    </>
                  )}
                </p>

                <button
                  type="button"
                  onClick={() => buy(p.id)}
                  disabled={buying === p.id}
                  className="mt-4 w-full px-4 py-2.5 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
                >
                  {buying === p.id ? "Opening checkout…" : `Buy for $${p.price.toFixed(2)}`}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
