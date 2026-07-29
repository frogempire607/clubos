"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, RefreshCw, AlertCircle, Info } from "lucide-react";

type ReliabilityState =
  | "COMPLETE"
  | "MISSING_BANK_CONNECTION"
  | "AWAITING_CATEGORIZATION"
  | "HISTORICAL_DATA_INCOMPLETE"
  | "CASH_DATA_NOT_INCLUDED"
  | "ESTIMATED"
  | "NEEDS_REVIEW"
  | "STALE";

type ReliabilitySection = {
  key: string;
  label: string;
  state: ReliabilityState;
  detail: string;
  count: number | null;
  lastUpdatedAt: string | null;
  href: string;
};

function stateBadge(state: ReliabilityState) {
  switch (state) {
    case "COMPLETE":
      return { dot: "bg-lime-accent", icon: <CheckCircle2 size={12} strokeWidth={2.25} className="text-charcoal" /> };
    case "MISSING_BANK_CONNECTION":
    case "STALE":
      return { dot: "bg-orange-accent", icon: <RefreshCw size={12} strokeWidth={2.25} className="text-orange-accent" /> };
    case "NEEDS_REVIEW":
    case "AWAITING_CATEGORIZATION":
      return { dot: "bg-orange-accent", icon: <AlertTriangle size={12} strokeWidth={2.25} className="text-orange-accent" /> };
    case "HISTORICAL_DATA_INCOMPLETE":
    case "CASH_DATA_NOT_INCLUDED":
      return { dot: "bg-app-bg", icon: <Info size={12} strokeWidth={2.25} className="text-text-muted" /> };
    case "ESTIMATED":
    default:
      return { dot: "bg-app-bg", icon: <AlertCircle size={12} strokeWidth={2.25} className="text-text-muted" /> };
  }
}

export default function ReliabilityStrip({
  sections,
  generatedAt,
}: {
  sections: ReliabilitySection[];
  generatedAt?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const ago = generatedAt
    ? Math.max(0, Math.floor((now - new Date(generatedAt).getTime()) / 60_000))
    : null;
  if (sections.length === 0) return null;
  return (
    <div className="bg-surface border border-app-border rounded-lg py-2.5 px-3.5 mb-5 flex items-center gap-4 flex-wrap">
      {sections.map((s, i) => {
        const badge = stateBadge(s.state);
        return (
          <div key={`${s.key}-${i}`} className="flex items-center gap-2">
            {i > 0 && <div className="hidden sm:block w-px h-3.5 bg-app-border" />}
            <Link
              href={s.href}
              className="flex items-center gap-2 text-xs font-medium text-text-primary hover:text-brand transition-colors"
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${badge.dot}`} />
              <span>{s.label}</span>
              <span className="text-text-muted font-normal">{s.detail}</span>
            </Link>
          </div>
        );
      })}
      {ago != null && (
        <span className="ml-auto text-[11px] text-text-muted">
          Updated {ago === 0 ? "just now" : `${ago}m ago`}
        </span>
      )}
    </div>
  );
}
