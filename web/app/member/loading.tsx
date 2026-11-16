// Shown inside the portal frame the instant a tab is tapped, while the next
// screen is on its way. Without it a tap did nothing visible until the new
// screen was ready — which reads as a freeze, most of all on a phone.
import { CardSkeleton, Skeleton } from "@/components/member/ui";

export default function MemberLoading() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-5 space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-40" />
      <CardSkeleton lines={3} />
      <CardSkeleton lines={4} />
    </div>
  );
}
