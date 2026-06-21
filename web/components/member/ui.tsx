"use client";

/**
 * Member-portal UI kit — premium, club-branded, presentational only.
 *
 * These components carry NO business logic. They read the club's accent
 * colour from the `--club-accent` CSS variable injected by the portal layout
 * (lib: app/member/layout.tsx), so every surface is branded with one source
 * of truth. Safe to use anywhere under the `.member-portal` root.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode, CSSProperties } from "react";

/* ── Shared club-brand hook ───────────────────────────────────────────────
 * Fetches /api/member/club exactly once per page load and shares the result
 * across every consumer (switcher, home, cards) via a module-level cache, so
 * we don't fan out duplicate requests. No new endpoint — same data the layout
 * already loads. */
export type ClubBrand = {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
};

let _brandCache: ClubBrand | null = null;
let _brandPromise: Promise<ClubBrand | null> | null = null;

function fetchBrand(): Promise<ClubBrand | null> {
  if (_brandCache) return Promise.resolve(_brandCache);
  if (_brandPromise) return _brandPromise;
  _brandPromise = fetch("/api/member/club")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return null;
      _brandCache = { name: d.name, logoUrl: d.logoUrl ?? null, primaryColor: d.primaryColor ?? null };
      return _brandCache;
    })
    .catch(() => null);
  return _brandPromise;
}

export function useClubBrand(): ClubBrand | null {
  const [brand, setBrand] = useState<ClubBrand | null>(_brandCache);
  useEffect(() => {
    let alive = true;
    fetchBrand().then((b) => {
      if (alive && b) setBrand(b);
    });
    return () => {
      alive = false;
    };
  }, []);
  return brand;
}

/* ── Card ─────────────────────────────────────────────────────────────── */
export function Card({
  children,
  className = "",
  hover = false,
  padding = "p-5",
  style,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  padding?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`pcard ${hover ? "pcard-hover" : ""} ${padding} ${className}`} style={style}>
      {children}
    </div>
  );
}

/* ── Section header ───────────────────────────────────────────────────── */
export function SectionHeader({
  title,
  subtitle,
  action,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-stone-900 leading-tight">{title}</h3>
        {subtitle && <p className="text-xs text-stone-500 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

/* ── Pill / badge ─────────────────────────────────────────────────────── */
type Tone = "neutral" | "accent" | "success" | "warn" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-600",
  success: "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
  accent: "", // styled inline with the club accent
};

export function Pill({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const accentStyle: CSSProperties =
    tone === "accent"
      ? { background: "var(--club-accent-soft)", color: "var(--club-accent)" }
      : {};
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${TONE_CLASS[tone]} ${className}`}
      style={accentStyle}
    >
      {children}
    </span>
  );
}

/* ── Accent button (link or button) ───────────────────────────────────── */
export function AccentButton({
  children,
  href,
  onClick,
  disabled,
  type = "button",
  className = "",
  full = false,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  full?: boolean;
}) {
  const cls = `pbtn-accent inline-flex items-center justify-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl ${
    full ? "w-full" : ""
  } ${className}`;
  if (href && !disabled) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  href,
  onClick,
  disabled,
  type = "button",
  className = "",
  full = false,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  full?: boolean;
}) {
  const cls = `inline-flex items-center justify-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl border border-stone-300 text-stone-700 bg-white hover:bg-stone-50 disabled:opacity-50 transition ${
    full ? "w-full" : ""
  } ${className}`;
  if (href && !disabled) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

/* ── Avatar (initials or photo) ───────────────────────────────────────── */
export function Avatar({
  name,
  src,
  size = 40,
  active = false,
}: {
  name: string;
  src?: string | null;
  size?: number;
  active?: boolean;
}) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  const ring: CSSProperties = active
    ? { boxShadow: "0 0 0 2px var(--club-accent)" }
    : {};
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size, ...ring }}
      />
    );
  }
  return (
    <span
      className="rounded-full flex items-center justify-center font-bold flex-shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, size * 0.36),
        background: "var(--club-accent-soft)",
        color: "var(--club-accent)",
        ...ring,
      }}
    >
      {initials || "?"}
    </span>
  );
}

/* ── Empty state ──────────────────────────────────────────────────────── */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-10 px-6">
      {icon && (
        <div
          className="mx-auto mb-3 w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{ background: "var(--club-accent-soft)", color: "var(--club-accent)" }}
        >
          {icon}
        </div>
      )}
      <p className="text-[15px] font-semibold text-stone-900">{title}</p>
      {description && <p className="text-sm text-stone-500 mt-1 max-w-xs mx-auto">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/* ── Skeleton ─────────────────────────────────────────────────────────── */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`pskeleton ${className}`} />;
}

/** A full-card loading placeholder for portal pages. */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <Card>
      <Skeleton className="h-4 w-1/3 mb-3" />
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={`h-3 ${i % 2 ? "w-2/3" : "w-full"}`} />
        ))}
      </div>
    </Card>
  );
}

/* ── Stat tile ────────────────────────────────────────────────────────── */
export function StatTile({
  label,
  value,
  icon,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="pcard p-4">
      <div className="flex items-center gap-2 mb-1.5">
        {icon && (
          <span
            className="w-6 h-6 rounded-lg flex items-center justify-center"
            style={{ background: "var(--club-accent-soft)", color: "var(--club-accent)" }}
          >
            {icon}
          </span>
        )}
        <p className="text-[11px] text-stone-500 uppercase tracking-wide font-medium">{label}</p>
      </div>
      <p
        className="text-[15px] font-semibold leading-tight"
        style={accent ? { color: "var(--club-accent)" } : { color: "#1c1917" }}
      >
        {value}
      </p>
    </div>
  );
}
