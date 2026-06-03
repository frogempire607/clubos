"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Ticket, CalendarRange, UserCheck, Package, type LucideIcon } from "lucide-react";

type Counts = {
  memberships: number;
  events: number;
  products: number;
  privatePackages: number;
};

export default function MemberShopPage() {
  const [counts, setCounts] = useState<Counts>({
    memberships: 0,
    events: 0,
    products: 0,
    privatePackages: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/member/memberships").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/member/events").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/member/products").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/member/private-packages").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([m, e, p, pk]) => {
      setCounts({
        memberships: m?.memberships?.length ?? 0,
        events: e?.events?.length ?? 0,
        products: p?.products?.length ?? 0,
        privatePackages: pk?.packages?.length ?? 0,
      });
      setLoading(false);
    });
  }, []);

  const cards: {
    href: string;
    title: string;
    desc: string;
    count: number;
    countLabel: string;
    Icon: LucideIcon;
  }[] = [
    {
      href: "/member/memberships",
      title: "Memberships",
      desc: "Join a plan or upgrade your current one.",
      count: counts.memberships,
      countLabel: "available",
      Icon: Ticket,
    },
    {
      href: "/member/events",
      title: "Events",
      desc: "Clinics, camps, tournaments, and special programs.",
      count: counts.events,
      countLabel: "upcoming",
      Icon: CalendarRange,
    },
    {
      href: "/member/privates",
      title: "Private lessons",
      desc: "Book 1-on-1 time — pick a coach and request times.",
      count: 0,
      countLabel: "",
      Icon: UserCheck,
    },
    // Only surface the packages card when there's something to buy.
    // Owners who haven't published any packages don't see a dead-end
    // card on the shop page.
    ...(counts.privatePackages > 0
      ? [
          {
            href: "/member/shop/packages",
            title: "Lesson packages",
            desc: "Prepaid packs that bundle private lessons at a lower per-lesson rate.",
            count: counts.privatePackages,
            countLabel: counts.privatePackages === 1 ? "available" : "available",
            Icon: UserCheck,
          },
        ]
      : []),
    {
      href: "/member/products",
      title: "Shop",
      desc: "Gear, apparel, and other items from your club.",
      count: counts.products,
      countLabel: "in stock",
      Icon: Package,
    },
  ];

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Purchase Options</h1>
        <p className="text-sm text-stone-500">Everything your club has on offer, all in one place.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="bg-white rounded-xl border border-stone-200 p-5 hover:shadow-sm transition flex flex-col"
          >
            <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
              <c.Icon className="h-6 w-6" strokeWidth={2} />
            </div>
            <h3 className="text-base font-semibold text-stone-900">{c.title}</h3>
            <p className="text-sm text-stone-500 mt-1 flex-1">{c.desc}</p>
            <p className="text-xs text-stone-400 mt-3">
              {loading ? "Loading…" : `${c.count} ${c.countLabel}`}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}
