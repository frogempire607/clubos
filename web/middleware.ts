import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import { canAccessPath } from "@/lib/permissions";
import { PREVIEW_COOKIE, isValidPreviewMode } from "@/lib/preview";

// Public routes that live under a protected prefix but must be reachable
// while logged OUT (e.g. prospective members creating an account).
function isPublicPath(pathname: string) {
  return pathname === "/member/signup" || pathname.startsWith("/member/signup/");
}

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;

    // Let the public member-signup page render without a session.
    if (isPublicPath(pathname)) return NextResponse.next();

    const role = req.nextauth.token?.role as string | undefined;
    const permissions = (req.nextauth.token as any)?.permissions ?? null;

    // Owner/staff dashboard: members should not access
    if (pathname.startsWith("/dashboard")) {
      if (role !== "OWNER" && role !== "STAFF") {
        if (role === "MEMBER") {
          return NextResponse.redirect(new URL("/member", req.url));
        }
        return NextResponse.redirect(new URL("/unauthorized", req.url));
      }

      // Staff: enforce per-section permissions. Owners bypass. Lacking
      // access bounces back to the dashboard home (always allowed) rather
      // than a dead-end, so the staff view never shows a broken page.
      if (role === "STAFF" && !canAccessPath(role, permissions, pathname)) {
        return NextResponse.redirect(new URL("/dashboard?denied=1", req.url));
      }
    }

    // Member portal: route real members here. Owners/staff belong in the
    // dashboard; the member APIs are scoped to MEMBER sessions and would not
    // render a useful preview for staff roles — UNLESS preview mode is on,
    // in which case we let the layout render and the member portal APIs
    // serve a sanitized PREVIEW payload (see lib/preview + /api/member/*).
    if (pathname.startsWith("/member")) {
      const previewRaw = req.cookies.get(PREVIEW_COOKIE)?.value;
      const previewing = isValidPreviewMode(previewRaw) && previewRaw === "member";
      if ((role === "OWNER" || role === "STAFF") && !previewing) {
        return NextResponse.redirect(new URL("/dashboard", req.url));
      }
      if (role !== "MEMBER" && role !== "OWNER" && role !== "STAFF") {
        return NextResponse.redirect(new URL("/login", req.url));
      }
    }

    if (pathname.startsWith("/admin") && role !== "OWNER") {
      return NextResponse.redirect(new URL("/unauthorized", req.url));
    }

    return NextResponse.next();
  },
  {
    // Logged-out visitors go to our styled login (with callbackUrl preserved,
    // which the login page forwards for safe /member deep links) instead of
    // NextAuth's default /api/auth/signin page.
    pages: { signIn: "/login" },
    callbacks: {
      // `/member/signup` is public; everything else under the matcher needs a token.
      authorized: ({ token, req }) =>
        isPublicPath(req.nextUrl.pathname) ? true : !!token,
    },
  }
);

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/member/:path*"],
};
