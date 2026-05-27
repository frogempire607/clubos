import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { PREVIEW_COOKIE, canStartPreview, isValidPreviewMode } from "@/lib/preview";

// POST /api/preview { mode: "member" | "public" }
// Sets the preview cookie for the current owner/staff session. The cookie is
// HttpOnly so client JS can't tamper with it; the value tells the server
// which preview surface to render. Member portal API routes honor it.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session || !canStartPreview(role)) {
    return NextResponse.json({ error: "Owner or staff session required" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const mode = body?.mode;
  if (!isValidPreviewMode(mode)) {
    return NextResponse.json({ error: "mode must be 'member' or 'public'" }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, mode });
  res.cookies.set({
    name: PREVIEW_COOKIE,
    value: mode,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Preview is a working session — expire after 8h or until the owner exits.
    maxAge: 60 * 60 * 8,
  });
  return res;
}

// DELETE /api/preview — clears the cookie ("Exit preview").
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: PREVIEW_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

// GET /api/preview — small endpoint the member layout polls so it knows when
// to render the preview banner. Returns { mode } or { mode: null }.
export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${PREVIEW_COOKIE}=([^;]+)`));
  const value = match ? decodeURIComponent(match[1]) : null;
  const mode = isValidPreviewMode(value || undefined) ? value : null;
  return NextResponse.json({ mode });
}
