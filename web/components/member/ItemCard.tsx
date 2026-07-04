"use client";

// One bookable/buyable result in the Book hub's "Popular right now" feed
// (2d / 1f). A single component covers Class / Plan / Event / Private / Shop
// via `kind`; colors defer to the item's own colors when provided (classes
// and typed events), else the kind default.

import Link from "next/link";
import { Pill } from "@/components/member/ui";

export type ItemKind = "class" | "plan" | "event" | "private" | "shop";

const KIND_META: Record<ItemKind, { label: string; abbr: string; bg: string; fg: string }> = {
  class:   { label: "Class",   abbr: "CL", bg: "#6D5DF6", fg: "#FFFFFF" },
  plan:    { label: "Plan",    abbr: "MB", bg: "var(--club-accent)", fg: "var(--club-accent-contrast)" },
  event:   { label: "Event",   abbr: "EV", bg: "#0D9488", fg: "#FFFFFF" },
  private: { label: "Private", abbr: "PV", bg: "#6D28D9", fg: "#FFFFFF" },
  shop:    { label: "Shop",    abbr: "SH", bg: "#57534E", fg: "#FFFFFF" },
};

export default function ItemCard({
  kind,
  title,
  meta,
  price,
  cta,
  href,
  color,
  textColor,
}: {
  kind: ItemKind;
  title: string;
  meta: string;
  /** "$25", "from $89/mo", "Included", or null for a meta-only footer. */
  price: string | null;
  cta: string;
  href: string;
  /** Optional item-specific chip colors (class / typed event). */
  color?: string | null;
  textColor?: string | null;
}) {
  const k = KIND_META[kind];
  const chip = { background: color || k.bg, color: textColor || k.fg };
  return (
    <Link
      href={href}
      className="pcard pcard-hover p-4 flex flex-col gap-2.5 md:min-h-[150px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)]"
    >
      <span className="flex items-center justify-between gap-2">
        <span
          className="w-10 h-10 rounded-xl flex items-center justify-center text-[11px] font-extrabold flex-shrink-0"
          style={chip}
          aria-hidden
        >
          {k.abbr}
        </span>
        {kind === "plan" ? (
          <Pill tone="accent">{k.label}</Pill>
        ) : (
          <span
            className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full"
            style={{ background: `${color || k.bg}1F`, color: color || k.bg }}
          >
            {k.label}
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-stone-900 leading-tight truncate">{title}</span>
        <span className="block text-xs text-stone-500 leading-snug mt-0.5 line-clamp-2">{meta}</span>
      </span>
      <span className="mt-auto flex items-center justify-between gap-2 pt-1">
        {price === "Included" ? (
          <Pill tone="success">Included</Pill>
        ) : (
          <span className={`text-[13px] font-semibold ${price ? "text-stone-900" : "text-stone-400"}`}>
            {price ?? ""}
          </span>
        )}
        <span className="pbtn-accent text-xs font-semibold px-3 py-1.5 rounded-lg">{cta}</span>
      </span>
    </Link>
  );
}
