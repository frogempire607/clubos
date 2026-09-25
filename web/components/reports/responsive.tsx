"use client";

// B5 (plan §2.5.12) — the small pieces every Reports tab shares on phones.
//
//   useMediaQuery   a live media query (re-renders on rotate / resize; never
//                   reads the window width during render)
//   useBodyScrollLock  stops the page behind a full-screen sheet from scrolling
//   ScrollTable     a wide table that scrolls sideways with momentum, keeps its
//                   FIRST column pinned, and shows a fade on the edge that still
//                   has more columns

import { useEffect, useRef, useState, type ReactNode } from "react";

export function useMediaQuery(query: string, initial = false): boolean {
  const [match, setMatch] = useState(initial);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return match;
}

/** True below Tailwind's `sm` (640px). */
export const usePhone = () => useMediaQuery("(max-width: 639.98px)");

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [active]);
}

/**
 * stickyFirst pins the first column with a surface background so scrolled
 * cells don't show through. Tables that already pin and tint their own first
 * column (the P&L grid) pass stickyFirst={false}.
 */
export function ScrollTable({ children, className = "", stickyFirst = true }: { children: ReactNode; className?: string; stickyFirst?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdge({ right: max - el.scrollLeft > 2 });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", update); ro?.disconnect(); };
  }, []);
  const sticky = stickyFirst
    ? "[&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-10 [&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-10 [&_td:first-child]:bg-surface [&_th:first-child]:bg-surface"
    : "";
  return (
    <div className={`relative ${className}`} data-scroll-table>
      <div ref={ref} className={`overflow-x-auto overscroll-x-contain ${sticky}`} style={{ WebkitOverflowScrolling: "touch" }}>
        {children}
      </div>
      <div aria-hidden className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent transition-opacity ${edge.right ? "opacity-100" : "opacity-0"}`} />
    </div>
  );
}
