import { NextResponse } from "next/server";

// INERT / superseded before use. Bulk onboarding intentionally reuses the
// existing single implementation at /api/members/bulk
//   { action: "send_registration_link", memberIds }
// so there is exactly one bulk-onboarding code path. This file is a leftover
// that the sandbox could not delete; it is safe to remove from the repo:
//   rm -rf web/app/api/members/onboarding-invites
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Use /api/members/bulk with { action: 'send_registration_link' } instead.",
    },
    { status: 410 },
  );
}
