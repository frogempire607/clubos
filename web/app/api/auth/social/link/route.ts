import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { passwordIsUsable, readToken, SOCIAL_ERROR_TEXT, type PendingPayload } from "@/lib/socialAuth";
import { afterProviderProof, attachIdentity, signInGate } from "@/lib/socialAuthServer";
import { PENDING_COOKIE, clearCookie, withSession } from "@/lib/socialAuthHttp";

// POST /api/auth/social/link { email, password }
//
// "Link to my existing account": the person signed in with Google or Apple
// and it matched no account (a hidden Apple address, an unverified address,
// a staff login, or simply a different address). They prove which account is
// theirs by signing in to it ONCE with its password; then the Google/Apple
// identity is attached and they are signed in. After that it works alone.
//
// Same rate limit bucket and same timing equaliser as the password login, so
// this is not a second way to guess passwords or probe for accounts.

const DUMMY_HASH = bcrypt.hashSync("athletixos-social-link-timing", 12);
const BAD = "That email and password don't match an account at this club.";

export async function POST(req: Request) {
  const rl = rateLimit({ key: `auth:login:${ipFromRequest(req)}`, limit: 10, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, SOCIAL_ERROR_TEXT.rate);

  const pending = readToken<PendingPayload>("pending", cookies().get(PENDING_COOKIE)?.value, new Date(), process.env.NEXTAUTH_SECRET);
  if (!pending) return NextResponse.json({ error: SOCIAL_ERROR_TEXT.state }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return NextResponse.json({ error: "Enter the email and password for your account." }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { clubId_email: { clubId: pending.clubId, email } },
    select: { id: true, passwordHash: true, deletedAt: true },
  });
  const hash = user && !user.deletedAt && passwordIsUsable(user.passwordHash) ? user.passwordHash : null;
  const valid = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  if (!user || !hash || !valid) return NextResponse.json({ error: BAD }, { status: 401 });

  const gate = await signInGate(user.id, pending.clubId);
  if (!gate.ok) return NextResponse.json({ error: SOCIAL_ERROR_TEXT[gate.error] }, { status: 403 });

  const profile = {
    provider: pending.provider,
    subject: pending.subject,
    email: pending.email,
    emailVerified: pending.emailVerified,
    emailIsRelay: pending.emailIsRelay,
    firstName: pending.firstName,
    lastName: pending.lastName,
  };
  const attached = await attachIdentity({ userId: user.id, clubId: pending.clubId, profile, refreshTokenEnc: pending.rt ?? null });
  if (!attached.ok) return NextResponse.json({ error: SOCIAL_ERROR_TEXT.taken }, { status: 409 });
  // The password proved the account; the provider may also prove its address.
  await afterProviderProof(user.id, profile);

  const res = NextResponse.json({ next: `/post-login?fromRole=${gate.user.role === "MEMBER" ? "member" : "staff"}` });
  clearCookie(res, PENDING_COOKIE, "/");
  return withSession(res, gate.user);
}
