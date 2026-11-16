// Shown inside the dashboard frame the instant a menu item is tapped, while
// the next screen's code and data are on their way. Without it a tap did
// nothing visible until the new screen was ready — which reads as a freeze.
import { SkeletonCard, SkeletonLine, SkeletonList } from "@/components/LoadingSkeleton";

export default function DashboardLoading() {
  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-4" aria-busy="true" aria-label="Loading">
      <SkeletonLine width={200} height={28} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard className="hidden md:block" />
        <SkeletonCard className="hidden md:block" />
      </div>
      <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
        <SkeletonList rows={6} />
      </div>
    </div>
  );
}
