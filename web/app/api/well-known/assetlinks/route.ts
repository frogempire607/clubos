import { NextResponse } from "next/server";
import { androidAssetLinks } from "@/lib/appLinks";

// Served at /.well-known/assetlinks.json (next.config rewrite).
export const dynamic = "force-dynamic";
export function GET() {
  return NextResponse.json(androidAssetLinks(), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}
