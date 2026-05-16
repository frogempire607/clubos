import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import { canAccessPath } from "@/lib/permissions";

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
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

    // Member portal: only members (owners/staff can preview)
    if (pathname.startsWith("/member")) {
      if (role !== "MEMBER" && role !== "OWNER" && role !== "STAFF") {
        return NextResponse.redirect(new URL("/login", req.url));
      }
    }

    if (pathname.startsWith("/admin") && role !== "OWNER") {
      return NextResponse.redirect(new URL("/unauthorized", req.url));
    }

    return NextResponse.next();
  },
  { callbacks: { authorized: ({ token }) => !!token } }
);

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/member/:path*"],
};
