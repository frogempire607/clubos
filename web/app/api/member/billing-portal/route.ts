import { NextResponse } from "next/server";

// POST /api/member/billing-portal
//
// DISABLED: billing behavior (cancel / change plan / pause) is controlled by
// the club owner or staff from the member's profile page in the dashboard.
// Members can't change their own billing — they must contact their club.
// Kept as a stub so old bookmarks/links fail cleanly with a clear message
// instead of unexpectedly opening a self-serve cancellation portal.
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Billing changes are handled by your club. Please contact them to update your payment method, pause, or cancel.",
    },
    { status: 403 },
  );
}
