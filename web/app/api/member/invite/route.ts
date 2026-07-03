import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { sendClubJoinInviteEmail } from "@/lib/email";
import { publicClubLogoUrl } from "@/lib/clubLogo";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { normalizeEmail } from "@/lib/memberValidation";

const schema = z.object({
  email: z.string().min(3),
  name: z.string().max(120).optional().nullable(),
});

// POST /api/member/invite
// Any member can share their club's public join link with someone by email. No
// account is created here (keeps it spam-resistant) — the recipient lands on the
// club's branded /join/<slug> page and signs up themselves.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 10 invites per hour per member.
  const rl = rateLimit({ key: `member:invite:${session.user.id}`, limit: 10, windowMs: 60 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "You've sent a lot of invites. Try again a bit later.");

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const email = normalizeEmail(data.email);
  if (!email) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { name: true, slug: true, logoUrl: true, primaryColor: true, emailFromName: true, emailReplyTo: true },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  const baseUrl = getAppBaseUrl();
  try {
    await sendClubJoinInviteEmail({
      to: email,
      firstName: (data.name || "").trim().split(/\s+/)[0] || "there",
      clubName: club.name,
      clubLogoUrl: publicClubLogoUrl(session.user.clubId, club.logoUrl),
      clubPrimaryColor: club.primaryColor,
      registrationUrl: `${baseUrl}/join/${club.slug}`,
      fromName: club.emailFromName || club.name,
      replyTo: club.emailReplyTo || null,
    });
  } catch (e) {
    console.error("member invite email failed", e);
    return NextResponse.json({ error: "Could not send the invite. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, message: `Invite sent to ${email}.` });
}
