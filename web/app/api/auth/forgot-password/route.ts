import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

const schema = z.object({ email: z.string().email(), clubSlug: z.string() });

export async function POST(req: Request) {
  try {
    const { email, clubSlug } = schema.parse(await req.json());
    const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
    if (!club) return NextResponse.json({ ok: true });

    const user = await prisma.user.findUnique({
      where: { clubId_email: { clubId: club.id, email: email.toLowerCase() } },
    });

    if (user) {
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
