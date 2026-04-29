import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
    const role = req.nextauth.token?.role;

    // Owner/staff dashboard: members should not access
    if (pathname.startsWith("/dashboard")) {
      if (role !== "OWNER" && role !== "STAFF") {
        if (role === "MEMBER") {
          return NextResponse.redirect(new URL("/member", req.url));
        }
        return NextResponse.redirect(new URL("/unauthorized", req.url));
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
