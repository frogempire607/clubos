import { NextResponse } from "next/server";
import { availableProviders } from "@/lib/socialAuthServer";

// GET /api/auth/social/providers → { providers: ["google", "apple"] }
// Which buttons to draw. A provider whose keys are not set is not listed, so
// the feature switches on by adding the Netlify variables.
export async function GET() {
  return NextResponse.json({ providers: availableProviders() }, { headers: { "cache-control": "public, max-age=300" } });
}
