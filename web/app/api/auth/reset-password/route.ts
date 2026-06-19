import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";

const schema = z.object({ token: z.string(), password: z.string().min(8) });

export async function POST(req: Request) {
  // 10 attempts per 10 minutes per IP. Lets a legit user fumble the
  // new-password field a few times; blocks token-guessing scripts.
  const rl = rateLimit({ key: `auth:reset:${ipFromRequest(req)}`, limit: 10, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many reset attempts. Try again in a few minutes.");

  try {
    const { token, password } = schema.parse(await req.json());
    const user = await prisma.user.findUnique({ where: { resetToken: token } });
    // Reject soft-deleted (revoked) logins too: resetting their hash would not
    // let them sign in (NextAuth rejects deletedAt), so treat the token as dead.
    if (!user || user.deletedAt || !user.resetExpires || user.resetExpires < new Date()) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 400 });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetExpires: null },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Reset failed" }, { status: 400 });
  }
}
