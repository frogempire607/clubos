import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";

const schema = z.object({ email: z.string().email(), clubSlug: z.string() });

export async function POST(req: Request) {
  // 5 requests per 10 minutes per IP — discourages enumeration but
  // tolerates a typo + retry.
  const rl = rateLimit({ key: `auth:forgot:${ipFromRequest(req)}`, limit: 5, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many password-reset attempts. Try again in a few minutes.");

  try {
    const { email, clubSlug } = schema.parse(await req.json());
    const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
    if (!club) return NextResponse.json({ ok: true });

    const user = await prisma.user.findUnique({
      where: { clubId_email: { clubId: club.id, email: email.toLowerCase() } },
    });

    // Skip soft-deleted (revoked) logins. A reset link can't restore access —
    // NextAuth rejects users with deletedAt — so emailing one only confuses.
    // Legitimate re-onboarding runs through the owner's activation link, which
    // resurrects the account and sets a fresh password.
    if (user && !user.deletedAt) {
      const resetToken   = crypto.randomBytes(32).toString("hex");
      const resetExpires = new Date(Date.now() + 1000 * 60 * 60);
      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken, resetExpires },
      });

      const baseUrl = getAppBaseUrl();
      const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

      await sendPasswordResetEmail({
        to: user.email,
        firstName: user.firstName,
        clubName: club.name,
        resetUrl,
      });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
