"use client";

// Book — the one storefront (design 2d / 1f). Members browse five categories
// (Classes · Memberships · Events · Privates · Shop — the old Store is a
// category here) or search one unified "Popular right now" feed that mixes
// every purchasable kind. Category routes are unchanged; each item links
// into its existing purchase flow, so checkout, discounts and parental
// approval behave exactly as before.

import { useEffect, useMemo, useState } from "react";
import {
  Ticket,
  CalendarRange,
  CalendarDays,
  UserCheck,
  Package,
  Search,
} from "lucide-react";
import AthleteRail, { useAthleteProfiles } from "@/components/member/AthleteRail";
import CategoryGrid, { CategoryCard } from "@/components/member/CategoryCard";
import ItemCard, { type ItemKind } from "@/components/member/ItemCard";
import { Skeleton } from "@/components/member/ui";
import { friendlyDate, friendlyTime } from "@/lib/friendlyDate";

type FeedItem = {
  key: string;
  kind: ItemKind;
  title: string;
  meta: string;
  price: string | null;
  cta: string;
  href: string;
  color?: string | null;
  textColor?: string | null;
};

const KIND_FILTERS: { key: "all" | ItemKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "class", label: "Classes" },
  { key: "plan", label: "Memberships" },
  { key: "event", label: "Events" },
  { key: "private", label: "Privates" },
  { key: "shop", label: "Shop" },
];

// Best-effort "from $X" out of the membership options JSON — shapes vary per
// club, so anything unparseable just renders without a price.
function minPlanPrice(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  const prices = options
    .map((o) => {
      const p = (o as { price?: unknown })?.price;
      const n = typeof p === "number" ? p : Number(p);
      return Number.isFinite(n) && n > 0 ? n : null;
    })
    .filter((n): n is number => n !== null);
  if (!prices.length) return null;
  return `from $${Math.min(...prices)}`;
}

function money(v: unknown): string | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? `$${n % 1 === 0 ? n : n.toFixed(2)}` : null;
}

export default function MemberBookPage() {
  const { profiles } = useAthleteProfiles();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | ItemKind>("all");
  const [counts, setCounts] = useState({ memberships: 0, events: 0, products: 0, classes: 0, privates: 0 });
  const [feed, setFeed] = useState<FeedItem[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/member/memberships").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/member/events").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/member/products").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/member/schedule", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([m, e, p, s]) => {
      const memberships = (m?.memberships ?? []) as {
        id: string; name: string; description: string | null; options: unknown;
      }[];
      const events = (e?.events ?? []) as {
        id: string; name: string; startsAt: string; memberPrice: unknown;
        customEventType: { name: string; color: string; textColor: string } | null;
      }[];
      const products = (p?.products ?? []) as {
        id: string; name: string; description?: string | null; price: unknown;
      }[];
      const schedItems = (s?.items ?? []) as {
        id: string; kind: "class" | "event"; title: string; startsAt: string;
        price: string | null; statusText: string; bookingStatus: string | null;
        bookingTier?: string | null; color: string | null; textColor: string | null;
      }[];
      const privates = (s?.privateOfferings ?? []) as {
        id: string; title: string; durationMin: number; basePrice: number;
      }[];

      const classes = schedItems.filter((it) => it.kind === "class" && !it.bookingStatus);

      setCounts({
        memberships: memberships.length,
        events: events.length,
        products: products.length,
        classes: classes.length,
        privates: privates.length,
      });

      // One feed, kinds interleaved round-robin so no category dominates.
      const byKind: FeedItem[][] = [
        classes.slice(0, 4).map((it) => ({
          key: `class:${it.id}`,
          kind: "class" as const,
          title: it.title,
          meta: `${friendlyDate(it.startsAt, { relative: true, weekday: true }, true)} · ${friendlyTime(it.startsAt, true)}`,
          price: it.bookingTier === "MEMBERSHIP" ? "Included" : it.price ? `$${it.price}` : null,
          cta: "Book",
          href: "/member/schedule",
          color: it.color,
          textColor: it.textColor,
        })),
        memberships.slice(0, 3).map((mm) => ({
          key: `plan:${mm.id}`,
          kind: "plan" as const,
          title: mm.name,
          meta: mm.description?.trim() || "Join a plan or upgrade your current one.",
          price: minPlanPrice(mm.options),
          cta: "Join",
          href: "/member/memberships",
        })),
        events.slice(0, 3).map((ev) => ({
          key: `event:${ev.id}`,
          kind: "event" as const,
          title: ev.name,
          meta: friendlyDate(ev.startsAt, { relative: true, weekday: true }),
          price: money(ev.memberPrice),
          cta: "View",
          href: "/member/events",
          color: ev.customEventType?.color ?? null,
          textColor: ev.customEventType?.textColor ?? null,
        })),
        privates.slice(0, 2).map((pv) => ({
          key: `private:${pv.id}`,
          kind: "private" as const,
          title: pv.title,
          meta: `${pv.durationMin} min · pick a coach & request times`,
          price: money(pv.basePrice),
          cta: "Request",
          href: "/member/privates",
        })),
        products.slice(0, 3).map((pr) => ({
          key: `shop:${pr.id}`,
          kind: "shop" as const,
          title: pr.name,
          meta: pr.description?.trim() || "Gear, apparel & club items.",
          price: money(pr.price),
          cta: "Buy",
          href: "/member/products",
        })),
      ];
      const mixed: FeedItem[] = [];
      for (let i = 0; mixed.length < 9; i++) {
        const round = byKind.map((arr) => arr[i]).filter(Boolean) as FeedItem[];
        if (!round.length) break;
        mixed.push(...round);
      }
      setFeed(mixed.slice(0, 9));
      setLoading(false);
    });
  }, []);

  const visibleFeed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return feed
      .filter((it) => (kindFilter === "all" ? true : it.kind === kindFilter))
      .filter((it) => (q ? `${it.title} ${it.meta}`.toLowerCase().includes(q) : true));
  }, [feed, query, kindFilter]);

  const hasRail = profiles.length >= 2;

  const categories = [
    {
      href: "/member/schedule",
      title: "Classes",
      desc: "Browse the weekly schedule and book a spot.",
      count: loading ? "…" : counts.classes > 0 ? `${counts.classes} bookable` : "Weekly",
      icon: <CalendarDays className="h-4.5 w-4.5 md:h-5 md:w-5" strokeWidth={2} />,
    },
    {
      href: "/member/memberships",
      title: "Memberships",
      desc: "Join a plan or upgrade your current one.",
      count: loading ? "…" : `${counts.memberships} plan${counts.memberships === 1 ? "" : "s"}`,
      icon: <Ticket className="h-4.5 w-4.5 md:h-5 md:w-5" strokeWidth={2} />,
    },
    {
      href: "/member/events",
      title: "Events",
      desc: "Clinics, camps, tournaments & programs.",
      count: loading ? "…" : `${counts.events} upcoming`,
      icon: <CalendarRange className="h-4.5 w-4.5 md:h-5 md:w-5" strokeWidth={2} />,
    },
    {
      href: "/member/privates",
      title: "Privates",
      desc: "Pick a coach and request 1-on-1 times.",
      count: "Lesson packs",
      icon: <UserCheck className="h-4.5 w-4.5 md:h-5 md:w-5" strokeWidth={2} />,
    },
    {
      href: "/member/products",
      title: "Shop",
      desc: "Gear, apparel & club items.",
      count: loading ? "…" : counts.products > 0 ? `${counts.products} in stock` : "Store",
      icon: <Package className="h-4.5 w-4.5 md:h-5 md:w-5" strokeWidth={2} />,
    },
  ];

  return (
    <div className={hasRail ? "md:grid md:grid-cols-[250px_minmax(0,1fr)] md:gap-6 md:items-start" : ""}>
      {hasRail && (
        <AthleteRail
          label="Buying for"
          footer={
            <>
              <span className="font-bold text-stone-600 block">Discount code</span>
              <span className="block mt-1">
                Have one? Enter it at checkout — it works on classes, events, packs &amp; gear.
              </span>
            </>
          }
        />
      )}

      <div className="min-w-0">
        <div className="mb-4">
          <h1 className="text-[22px] md:text-[25px] font-extrabold tracking-[-0.01em] text-stone-900">Book</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            Everything the club offers — classes, plans, events, lessons &amp; gear, one place.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {/* Search + kind chips. Mobile order puts categories first (1f);
              desktop leads with search (2d). */}
          <div className="order-2 md:order-1 flex flex-col md:flex-row md:items-center gap-2.5">
            <label className="flex items-center gap-2.5 bg-white border border-stone-200 rounded-[13px] px-3.5 py-2.5 flex-1 focus-within:ring-2 focus-within:ring-[var(--club-accent-ring)]">
              <Search className="h-4 w-4 text-stone-400 flex-shrink-0" strokeWidth={2} aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search classes, plans, events, gear…"
                aria-label="Search everything bookable"
                className="w-full text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none bg-transparent"
              />
            </label>
            <div className="flex gap-1.5 flex-wrap">
              {KIND_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setKindFilter(f.key)}
                  aria-pressed={kindFilter === f.key}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition ${
                    kindFilter === f.key
                      ? "bg-stone-900 border-stone-900 text-white"
                      : "bg-white border-stone-200 text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Browse categories */}
          <div className="order-1 md:order-2">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-stone-400 mb-2 px-0.5">
              Browse categories
            </p>
            <CategoryGrid>
              {categories.map((c) => (
                <CategoryCard key={c.href} {...c} />
              ))}
            </CategoryGrid>
          </div>

          {/* Popular right now */}
          <div className="order-3">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-stone-400 mb-2 px-0.5">
              Popular right now
            </p>
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="pcard p-4 space-y-3">
                    <Skeleton className="h-10 w-10 !rounded-xl" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                ))}
              </div>
            ) : visibleFeed.length === 0 ? (
              <div className="pcard p-8 text-center">
                <p className="text-sm font-semibold text-stone-900">
                  {query.trim() ? `Nothing matches “${query.trim()}”` : "Nothing to show right now"}
                </p>
                <p className="text-xs text-stone-500 mt-1">
                  Try a different search — or browse the categories above; every class, plan,
                  event, lesson and item lives in one of them.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {visibleFeed.map(({ key, ...it }) => (
                  <ItemCard key={key} {...it} />
                ))}
              </div>
            )}
          </div>

          <p className="order-4 text-[11.5px] leading-relaxed text-stone-500 bg-stone-50 border border-stone-200 border-l-[3px] border-l-[var(--club-accent)] rounded-[10px] px-3.5 py-3">
            <strong className="text-stone-700">Browse</strong> to see what&apos;s bookable, or{" "}
            <strong className="text-stone-700">search</strong> to jump straight to it — one feed
            for classes, plans, events, privates &amp; gear. Store lives here as a category.
          </p>
        </div>
      </div>
    </div>
  );
}
