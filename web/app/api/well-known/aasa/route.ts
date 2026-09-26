import { NextResponse } from "next/server";
import { appleAppSiteAssociation } from "@/lib/appLinks";

// Served at /.well-known/apple-app-site-association (next.config rewrite).
// Apple fetches it with no extension and requires application/json.
export const dynamic = "force-static";
export function GET() {
  return NextResponse.json(appleAppSiteAssociation(), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}
