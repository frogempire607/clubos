import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Post-credentials-signin landing. Reads the JWT cookie server-side and
// 307s to the right surface based on the account's real role. Used by the
// login page as a single hard-navigation target so we never depend on
// client-side session hydration — important for Capacitor iOS WKWebView
// where next-auth/react's getSession can race the cookie write.
//
// `fromRole` is purely a UX hint: a MEMBER who tried the staff tab is
// redirected to /member?from=staff-login so the portal can show a banner.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const role = (session?.user as { role?: string } | undefined)?.role;

  if (!role) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (role === "OWNER" || role === "STAFF") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (role === "MEMBER") {
    const fromRole = req.nextUrl.searchParams.get("fromRole");
    const target = fromRole === "staff" ? "/member?from=staff-login" : "/member";
    return NextResponse.redirect(new URL(target, req.url));
  }

  return NextResponse.redirect(new URL("/login", req.url));
}
