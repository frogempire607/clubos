// Cookies and page hops shared by the Google / Apple sign-in routes.

import { NextResponse } from "next/server";
import { sessionCookieFor } from "@/lib/socialAuthServer";

const isProd = process.env.NODE_ENV === "production";

/** Ties the provider's answer to the browser that asked (website flow only). */
export const BROWSER_COOKIE = "aox_social_b";
/** "Signed in with Google/Apple, but which account?" while the person chooses. */
export const PENDING_COOKIE = "aox_social_pending";

// Apple answers with a cross-site form POST, which never carries a Lax
// cookie, so the browser-binding cookie must be SameSite=None (and so Secure).
// Local http has no Secure cookies; Lax is the most that works there, and
// Apple has no local return address anyway.
export function browserCookieOptions(maxAgeSec: number) {
  return isProd
    ? { httpOnly: true, secure: true, sameSite: "none" as const, path: "/api/auth/social", maxAge: maxAgeSec }
    : { httpOnly: true, secure: false, sameSite: "lax" as const, path: "/api/auth/social", maxAge: maxAgeSec };
}

export function pendingCookieOptions(maxAgeSec: number) {
  return { httpOnly: true, secure: isProd, sameSite: "lax" as const, path: "/", maxAge: maxAgeSec };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * A tiny page that moves on to `target`. Used instead of a redirect because
 * Apple's answer is a cross-site POST: a page loaded from our own origin makes
 * the next request same-site, so the session cookie set here is sent with it.
 */
export function bounce(target: string, status = 200): NextResponse {
  const t = esc(target);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0; url=${t}"><title>Signing in…</title><style>html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#F7F7F9;color:#6B7280}.w{display:flex;align-items:center;justify-content:center;height:100%;font-size:15px}a{color:#6D5DF6}</style></head><body><div class="w"><p>Signing in… <a href="${t}">Continue</a></p></div><script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")});</script></body></html>`;
  const res = new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  res.headers.set("cache-control", "no-store");
  return res;
}

export async function withSession(res: NextResponse, user: Parameters<typeof sessionCookieFor>[0]): Promise<NextResponse> {
  const c = await sessionCookieFor(user);
  res.cookies.set(c.name, c.value, c.options);
  return res;
}

export function clearCookie(res: NextResponse, name: string, path: string): NextResponse {
  res.cookies.set(name, "", { path, maxAge: 0 });
  return res;
}

export function loginErrorPath(code: string, clubSlug?: string | null): string {
  const q = new URLSearchParams({ social_error: code });
  if (clubSlug) q.set("club", clubSlug);
  return `/login?${q.toString()}`;
}
