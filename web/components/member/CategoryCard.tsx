"use client";

// Browse-categories tiles for the Book hub (2d / 1f). 5-up on desktop with
// descriptions; 3-up compact icon cards on mobile. Whole card is a link.

import Link from "next/link";
import type { ReactNode } from "react";

export function CategoryCard({
  icon,
  title,
  desc,
  count,
  href,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  /** Bottom line, e.g. "7 plans" — arrow appended automatically. */
  count: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="pcard pcard-hover p-3 md:p-4 flex flex-col gap-2 md:gap-2.5 md:min-h-[150px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)]"
    >
      <span
        className="w-9 h-9 md:w-11 md:h-11 rounded-full md:rounded-[14px] flex items-center justify-center flex-shrink-0"
        style={{ background: "var(--club-accent-soft)", color: "var(--club-accent)" }}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] md:text-[15px] font-bold text-stone-900 leading-tight">{title}</span>
        <span className="hidden md:block text-xs text-stone-500 leading-snug mt-1">{desc}</span>
      </span>
      <span className="mt-auto block text-[10.5px] md:text-[11px] font-bold" style={{ color: "var(--club-accent)" }}>
        {count} →
      </span>
    </Link>
  );
}

export default function CategoryGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-3 md:grid-cols-5 gap-2.5 md:gap-3">{children}</div>;
}
