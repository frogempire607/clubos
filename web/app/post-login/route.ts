import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Post-credentials-signin landing. Reads the JWT cookie server-side and
// 307s to the right surface based on the account's real role. Used by the
// login page as a single hard-navigation target so we never depend on
// client-side session hydration — important for Capacitor iOS WKWebView
// and Safari, where next-auth/react's getSession can race the cookie
// write.
//
// `fromRole` is purely a UX hint: a MEMBER who tried the staff tab is
// redirected to /member?from=staff-login so the portal can show a banner.
//
// Safari sometimes hasn't committed the Set-Cookie from the signIn POST
// by the time it issues this GET. The `?retry=N` param lets us re-check
// once with a fresh request before giving up.
// Every response from this route must be uncacheable. Browsers can and do
// cache 307 redirects, and if a previous OWNER login left a cached
// /post-login → /dashboard in the cache, a subsequent MEMBER login would
// jump straight to /dashboard without re-checking the session.
function noStore(res: NextResponse) {
  res.headers.set("cache-control", "no-store, no-cache, must-revalidate");
  res.headers.set("pragma", "no-cache");
  return res;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const role = (session?.user as { role?: string } | undefined)?.role;
  const fromRole = req.nextUrl.searchParams.get("fromRole");
  const retry = Number(req.nextUrl.searchParams.get("retry") ?? "0");

  if (role === "OWNER" || role === "STAFF") {
    return noStore(NextResponse.redirect(new URL("/dashboard", req.url)));
  }

  if (role === "MEMBER") {
    // Deep-link continuation (attendance-QR check-in, etc). Path-only,
    // /member-scoped values are accepted; anything else falls back to the
    // portal home so this can never become an open redirect.
    const next = req.nextUrl.searchParams.get("next");
    const safeNext =
      next && next.startsWith("/member") && !next.startsWith("//") && !next.includes("://") ? next : null;
    const target = safeNext ?? (fromRole === "staff" ? "/member?from=staff-login" : "/member");
    return noStore(NextResponse.redirect(new URL(target, req.url)));
  }

  // No session on the server yet. In Safari this can happen on the very
  // first request after sign-in because the cookie commit hasn't flushed.
  // Return a tiny HTML page that meta-refreshes back to /post-login with
  // a retry counter; by the time the refresh fires, the cookie is in the
  // jar. Bail to /login after two attempts so a real auth failure doesn't
  // spin forever.
  if (retry < 2) {
    const next = new URL(req.url);
    next.searchParams.set("retry", String(retry + 1));
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=${next.pathname}${next.search}" />
    <title>Signing in…</title>
    <style>
      html, body { margin: 0; height: 100%; background: #f5f5f4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .wrap { display: flex; align-items: center; justify-content: center; height: 100%; color: #57534e; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="wrap">Signing in…</div>
    <script>setTimeout(function(){ location.replace(${JSON.stringify(next.pathname + next.search)}); }, 80);</script>
  </body>
</html>`;
    return noStore(
      new NextResponse(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }

  return noStore(NextResponse.redirect(new URL("/login", req.url)));
}
