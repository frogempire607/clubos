"use client";

// Shared loading-skeleton primitives for dashboard pages. Replaces the
// "Loading…" text placeholders each section hand-rolls so the dashboard
// feels alive while data fetches.

export function SkeletonLine({
  width = "100%",
  height = 12,
  className,
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return (
    <div
      className={`rounded bg-app-bg animate-pulse ${className ?? ""}`}
      style={{ width, height }}
    />
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={`bg-surface rounded-xl border border-app-border p-4 ${className ?? ""}`}>
      <div className="flex items-center justify-between mb-3">
        <SkeletonLine width={90} height={10} />
        <SkeletonLine width={8} height={8} className="rounded-full" />
      </div>
      <SkeletonLine width={64} height={24} className="mb-2" />
      <SkeletonLine width={110} height={10} />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-app-border last:border-0">
      <SkeletonLine width={32} height={32} className="rounded-full shrink-0" />
      <div className="flex-1 min-w-0">
        <SkeletonLine width="60%" height={12} className="mb-1.5" />
        <SkeletonLine width="40%" height={10} />
      </div>
      <SkeletonLine width={48} height={16} className="rounded-full shrink-0" />
    </div>
  );
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
