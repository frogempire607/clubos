import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { rateLimit, ipFromRequest } from "@/lib/ratelimit";
import {
  appReturnUrl,
  decideSocialSignIn,
  HANDOFF_TTL_MS,
  isSocialProvider,
  PENDING_TTL_MS,
  readToken,
  signToken,
  type AccountRole,
  type HandoffPayload,
  type PendingPayload,
  type SocialProvider,
  type StatePayload,
} from "@/lib/socialAuth";
import {
  afterProviderProof,
  attachIdentity,
  exchangeAndVerify,
  findLinked,
  providerConfigured,
  sealAppleRefreshToken,
  signInGate,
  touchIdentity,
} from "@/lib/socialAuthServer";
import {
  BROWSER_COOKIE,
  PENDING_COOKIE,
  bounce,
  clearCookie,
  loginErrorPath,
  pendingCookieOptions,
  withSession,
} from "@/lib/socialAuthHttp";

// GET  /api/auth/social/callback/google   (Google answers with a redirect)
// POST /api/auth/social/callback/apple    (Apple answers with a form POST)
//
// The provider sends the person back here with a one-time code. We trade it
// for their signed identity and apply the rules in lib/socialAuth
// (decideSocialSignIn). Every outcome ends on a page of ours: signed in, the
// "which account?" choice, My account, or the login page with a plain error.
// In the app it ends on the app's own address instead, carrying a one-time
// code only that app can redeem (POST /api/auth/social/redeem).

export const dynamic = "force-dynamic";

const secret = () => process.env.NEXTAUTH_SECRET;

function sameValue(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return undefined;
}

async function params(req: Request): Promise<URLSearchParams> {
  if (req.method === "POST") {
    const text = await req.text().catch(() => "");
    return new URLSearchParams(text);
  }
  return new URL(req.url).searchParams;
}

function appleUserName(raw: string | null): { firstName?: string | null; lastName?: string | null } | null {
  // Apple sends the name once, on the very first authorization, as JSON.
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as { name?: { firstName?: string; lastName?: string } };
    return { firstName: u.name?.firstName ?? null, lastName: u.name?.lastName ?? null };
  } catch {
    return null;
  }
}

async function handle(req: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const q = await params(req);
  const state = readToken<StatePayload>("state", q.get("state"), new Date(), secret());
  const inApp = !!state?.a;
  // A failed "Connect" goes back to the account page the person came from.
  const connectRole =
    state?.m === "connect" && state.u ? (await prisma.user.findUnique({ where: { id: state.u }, select: { role: true } }))?.role ?? null : null;
  const accountPage = connectRole && connectRole !== "MEMBER" ? "/dashboard/my-account" : "/member/profile";

  // Where a failure goes: the app's own address in the app, the login page on the web.
  const fail = (code: string) => {
    const target = inApp ? appReturnUrl({ error: code }) : state?.m === "connect" ? `${accountPage}?social_error=${code}` : loginErrorPath(code, state?.c);
    return clearCookie(bounce(target), BROWSER_COOKIE, "/api/auth/social");
  };

  const rl = rateLimit({ key: `auth:social-callback:${ipFromRequest(req)}`, limit: 30, windowMs: 10 * 60_000 });
  if (!rl.allowed) return fail("rate");
  if (!isSocialProvider(provider) || !state || state.p !== provider) return fail("state");
  if (!providerConfigured(provider)) return fail("not_configured");
  // Website flow: the answer must come back to the browser that asked.
  if (!inApp && !sameValue(readCookie(req, BROWSER_COOKIE), state.b)) return fail("state");
  if (q.get("error")) return fail(q.get("error") === "access_denied" || q.get("error") === "user_cancelled_authorize" ? "cancelled" : "provider");
  const code = q.get("code");
  if (!code) return fail("provider");

  const answer = await exchangeAndVerify(provider as SocialProvider, {
    code,
    redirectUri: state.r,
    nonce: state.n,
    appleUser: provider === "apple" ? appleUserName(q.get("user")) : null,
  });
  if (!answer.ok) {
    console.error("[social] provider answer refused:", answer.reason);
    return fail("provider");
  }
  const { profile } = answer;
  const refreshTokenEnc = sealAppleRefreshToken(profile.provider, answer.refreshToken);

  const club = await prisma.club.findUnique({ where: { slug: state.c }, select: { id: true, slug: true } });
  if (!club) return fail("club");

  // ── Connect a method to the account that asked (My account) ───────────────
  if (state.m === "connect") {
    const user = state.u ? await prisma.user.findFirst({ where: { id: state.u, clubId: club.id, deletedAt: null }, select: { id: true, role: true } }) : null;
    if (!user) return fail("removed");
    const attached = await attachIdentity({ userId: user.id, clubId: club.id, profile, refreshTokenEnc });
    if (!attached.ok) return fail("taken");
    await afterProviderProof(user.id, profile);
    const page = user.role === "MEMBER" ? "/member/profile" : "/dashboard/my-account";
    const target = inApp ? appReturnUrl({ result: "connected", provider }) : `${page}?connected=${provider}`;
    return clearCookie(bounce(target), BROWSER_COOKIE, "/api/auth/social");
  }

  // ── Sign in ───────────────────────────────────────────────────────────────
  const [linked, emailMatch] = await Promise.all([
    findLinked(club.id, profile.provider, profile.subject),
    profile.email
      ? prisma.user.findUnique({ where: { clubId_email: { clubId: club.id, email: profile.email } }, select: { id: true, role: true, deletedAt: true } })
      : Promise.resolve(null),
  ]);
  const decision = decideSocialSignIn({
    profile,
    linked: linked ? { userId: linked.userId, deleted: !!linked.user.deletedAt } : null,
    emailMatch: emailMatch ? { userId: emailMatch.id, role: emailMatch.role as AccountRole, deleted: !!emailMatch.deletedAt } : null,
  });

  if (decision.action === "CHOOSE") {
    const pending: PendingPayload = {
      provider: profile.provider,
      subject: profile.subject,
      clubId: club.id,
      clubSlug: club.slug,
      email: profile.email,
      emailVerified: profile.emailVerified,
      emailIsRelay: profile.emailIsRelay,
      firstName: profile.firstName,
      lastName: profile.lastName,
      rt: refreshTokenEnc,
    };
    const pendingToken = signToken("pending", pending, PENDING_TTL_MS, new Date(), secret());
    if (inApp) {
      const handoff = signToken<HandoffPayload>("handoff", { k: "pending", pending: pendingToken, a: state.a as string }, HANDOFF_TTL_MS, new Date(), secret());
      return bounce(appReturnUrl({ code: handoff }));
    }
    const res = bounce(`/login/social${state.x ? `?next=${encodeURIComponent(state.x)}` : ""}`);
    res.cookies.set(PENDING_COOKIE, pendingToken, pendingCookieOptions(Math.floor(PENDING_TTL_MS / 1000)));
    return clearCookie(res, BROWSER_COOKIE, "/api/auth/social");
  }

  // SIGN_IN or LINK_AND_SIGN_IN
  const gate = await signInGate(decision.userId, club.id);
  if (!gate.ok) return fail(gate.error);
  if (decision.action === "LINK_AND_SIGN_IN") {
    const attached = await attachIdentity({ userId: decision.userId, clubId: club.id, profile, refreshTokenEnc });
    if (!attached.ok) return fail("taken");
    await afterProviderProof(decision.userId, profile);
  } else {
    await touchIdentity(club.id, profile, refreshTokenEnc);
  }

  if (inApp) {
    const handoff = signToken<HandoffPayload>("handoff", { k: "session", userId: gate.user.id, a: state.a as string }, HANDOFF_TTL_MS, new Date(), secret());
    return bounce(appReturnUrl({ code: handoff }));
  }
  const next = state.x ? `&next=${encodeURIComponent(state.x)}` : "";
  const res = await withSession(bounce(`/post-login?fromRole=${gate.user.role === "MEMBER" ? "member" : "staff"}${next}`), gate.user);
  return clearCookie(res, BROWSER_COOKIE, "/api/auth/social");
}

export const GET = handle;
export const POST = handle;
