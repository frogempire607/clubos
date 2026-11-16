import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailLinkStatus, sendVerificationEmail } from "@/lib/emailLinkServer";
import { isEmailVerified } from "@/lib/emailVerification";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

async function account(userId: string, clubId: string) {
  return prisma.user.findFirst({
    where: { id: userId, clubId, deletedAt: null },
    select: { id: true, clubId: true, email: true, firstName: true, emailVerified: true, createdAt: true, club: { select: { name: true } } },
  });
}

// GET  → { verified, pending }  — is anything waiting on this account's email?
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await account(session.user.id, session.user.clubId);
  if (!me) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await emailLinkStatus(me));
}

// POST → send the confirmation link again, to the address on the account.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `email-verify-resend:${session.user.id}`, limit: 3, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "We just sent that. Check your inbox and spam folder, or try again in a few minutes.");

  const me = await account(session.user.id, session.user.clubId);
  if (!me) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (isEmailVerified(me)) return NextResponse.json({ ok: true, alreadyVerified: true });

  const sent = await sendVerificationEmail(me, me.club.name, baseUrlFromRequest(req));
  if (!sent) return NextResponse.json({ error: "We couldn't send the email just now. Please try again." }, { status: 502 });
  return NextResponse.json({ ok: true });
}
