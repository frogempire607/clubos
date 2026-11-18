import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { isSocialProvider, safeMemberNext, signToken, STATE_TTL_MS, SOCIAL_ERROR_TEXT, type StatePayload } from "@/lib/socialAuth";
import { authorizationUrl, callbackUrl, providerConfigured } from "@/lib/socialAuthServer";
import { BROWSER_COOKIE, browserCookieOptions } from "@/lib/socialAuthHttp";

// POST /api/auth/social/start
//   { provider: "google"|"apple", club: "<slug>", mode?: "signin"|"connect",
//     app?: "<sha256 of a secret only the app holds>", next?: "/member/..." }
// → { url } — where to send the person (the page, or the app's browser sheet).
//
// "connect" adds a method to the signed-in account (My account). The account
// is named inside the signed state, so the callback never needs the session —
// which matters in the app, where the browser sheet has no session cookie.
export async function POST(req: Request) {
  const rl = rateLimit({ key: `auth:social-start:${ipFromRequest(req)}`, limit: 20, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, SOCIAL_ERROR_TEXT.rate);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const provider = body?.provider;
  if (!isSocialProvider(provider)) return NextResponse.json({ error: "Unknown sign-in option." }, { status: 400 });
  if (!providerConfigured(provider)) return NextResponse.json({ error: SOCIAL_ERROR_TEXT.not_configured }, { status: 503 });
  const mode = body?.mode === "connect" ? "connect" : "signin";
  const app = typeof body?.app === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.app) ? body.app : undefined;

  let clubSlug = typeof body?.club === "string" ? body.club.trim().toLowerCase() : "";
  let userId: string | undefined;
  if (mode === "connect") {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { slug: true } });
    if (!club) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    clubSlug = club.slug;
    userId = session.user.id;
  } else {
    if (!clubSlug) return NextResponse.json({ error: "Enter your club code first." }, { status: 400 });
    const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
    if (!club) return NextResponse.json({ error: SOCIAL_ERROR_TEXT.club }, { status: 404 });
  }

  const redirectUri = callbackUrl(provider, baseUrlFromRequest(req));
  const browser = randomBytes(18).toString("base64url");
  const payload: StatePayload = {
    p: provider,
    c: clubSlug,
    m: mode,
    n: randomBytes(18).toString("base64url"),
    b: browser,
    r: redirectUri,
    ...(app ? { a: app } : {}),
    ...(userId ? { u: userId } : {}),
    ...(safeMemberNext(typeof body?.next === "string" ? body.next : null) ? { x: body?.next as string } : {}),
  };
  const state = signToken("state", payload, STATE_TTL_MS, new Date(), process.env.NEXTAUTH_SECRET);
  const res = NextResponse.json({ url: authorizationUrl(provider, { state, nonce: payload.n, redirectUri }) });
  // In the app the sheet is a different browser with its own cookies; the
  // app's secret binds the flow instead (checked when the app redeems).
  if (!app) res.cookies.set(BROWSER_COOKIE, browser, browserCookieOptions(Math.floor(STATE_TTL_MS / 1000)));
  res.headers.set("cache-control", "no-store");
  return res;
}
