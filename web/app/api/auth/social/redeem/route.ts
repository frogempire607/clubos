import { NextResponse } from "next/server";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { challengeMatches, PENDING_TTL_MS, readToken, SOCIAL_ERROR_TEXT, type HandoffPayload } from "@/lib/socialAuth";
import { sha256b64u, signInGate } from "@/lib/socialAuthServer";
import { PENDING_COOKIE, pendingCookieOptions, withSession } from "@/lib/socialAuthHttp";
import { prisma } from "@/lib/prisma";

// POST /api/auth/social/redeem { code, verifier }
//
// The app's half of a Google / Apple sign-in. The browser sheet ends on the
// app's own address with a one-time `code`; the app's web view posts it here
// together with the secret it generated before opening the sheet. Only the
// app that started the flow holds that secret, so a code read off the screen,
// a log or another app is useless on its own. The session (or the "which
// account?" choice) is then set in the web view, where the app lives.
export async function POST(req: Request) {
  const rl = rateLimit({ key: `auth:social-redeem:${ipFromRequest(req)}`, limit: 20, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, SOCIAL_ERROR_TEXT.rate);

  const body = (await req.json().catch(() => null)) as { code?: unknown; verifier?: unknown } | null;
  const handoff = readToken<HandoffPayload>("handoff", typeof body?.code === "string" ? body.code : null, new Date(), process.env.NEXTAUTH_SECRET);
  const verifier = typeof body?.verifier === "string" ? body.verifier : null;
  if (!handoff || !challengeMatches(handoff.a, verifier, sha256b64u)) {
    return NextResponse.json({ error: SOCIAL_ERROR_TEXT.state }, { status: 400 });
  }

  if (handoff.k === "pending") {
    const res = NextResponse.json({ next: "/login/social" });
    res.cookies.set(PENDING_COOKIE, handoff.pending, pendingCookieOptions(Math.floor(PENDING_TTL_MS / 1000)));
    return res;
  }

  const user = await prisma.user.findUnique({ where: { id: handoff.userId }, select: { clubId: true } });
  if (!user) return NextResponse.json({ error: SOCIAL_ERROR_TEXT.removed }, { status: 400 });
  const gate = await signInGate(handoff.userId, user.clubId);
  if (!gate.ok) return NextResponse.json({ error: SOCIAL_ERROR_TEXT[gate.error] }, { status: 403 });
  return withSession(NextResponse.json({ next: `/post-login?fromRole=${gate.user.role === "MEMBER" ? "member" : "staff"}` }), gate.user);
}
