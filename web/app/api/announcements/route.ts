import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail, isEmailConfigured, smtpMissingVars } from "@/lib/email";
import { getTierFeatures } from "@/lib/tier";
import { z } from "zod";

const schema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  channels: z.string().optional().default("app"),
  publishAt: z.string().optional().nullable(),
  unpublishAt: z.string().optional().nullable(),
  sendNow: z.boolean().optional().default(false),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const announcements = await prisma.announcement.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(announcements);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = schema.parse(await req.json());

    const channels = data.channels.split(",").map((c) => c.trim()).filter(Boolean);
    const wantsEmail = channels.includes("email");
    const wantsSms   = channels.includes("sms");

    // Tier gate: email/SMS blasts require Pro+
    if (wantsEmail || wantsSms) {
      const club = await prisma.club.findUnique({
        where: { id: session.user.clubId },
        select: { tier: true },
      });
      const features = getTierFeatures(club?.tier ?? "starter");
      if (!features.emailSms) {
        return NextResponse.json(
          {
            error: "Your current plan does not include email or SMS blasts. Upgrade to Pro to send announcements by email.",
            code: "UPGRADE_REQUIRED",
            upgradeRequired: "pro",
          },
          { status: 403 },
        );
      }
    }

    // If admin asked us to send email RIGHT NOW, fail loudly when SMTP is missing.
    // Silent no-op was the previous behavior and made it impossible to tell why
    // members never received an announcement.
    const isPublishingNow = !data.publishAt || new Date(data.publishAt) <= new Date();
    if (data.sendNow && isPublishingNow && wantsEmail && !isEmailConfigured()) {
      return NextResponse.json(
        {
          error: `Email isn't configured yet. Add the missing SMTP env vars: ${smtpMissingVars().join(", ")}.`,
          code: "EMAIL_NOT_CONFIGURED",
          missing: smtpMissingVars(),
        },
        { status: 400 },
      );
    }

    const announcement = await prisma.announcement.create({
      data: {
        clubId: session.user.clubId,
        title: data.title,
        body: data.body,
        channels: data.channels,
        publishAt: data.publishAt ? new Date(data.publishAt) : null,
        unpublishAt: data.unpublishAt ? new Date(data.unpublishAt) : null,
      },
    });

    let emailDelivery: { attempted: number; succeeded: number; failed: number } | null = null;

    if (data.sendNow && isPublishingNow && wantsEmail) {
      const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
      const members = await prisma.member.findMany({
        where: { clubId: session.user.clubId, deletedAt: null, status: "ACTIVE" },
        select: { email: true, guardianEmail: true, isMinor: true, guardian: { select: { email: true } } },
      });

      // Deduplicate: minors route to guardian email; siblings sharing a guardian
      // collapse to one address. Adults route to their own email.
      const recipients = new Set<string>();
      for (const m of members) {
        if (m.isMinor) {
          const ge = (m.guardian?.email ?? m.guardianEmail ?? "").trim().toLowerCase();
          if (ge) recipients.add(ge);
        } else if (m.email) {
          recipients.add(m.email.trim().toLowerCase());
        }
      }

      let succeeded = 0;
      let failed = 0;
      const subject = `${club?.name ?? "Your Club"}: ${data.title}`;
      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#1c1917">${data.title}</h2>
          <div style="color:#57534e;line-height:1.6;white-space:pre-wrap">${data.body}</div>
          <hr style="border:none;border-top:1px solid #e7e5e4;margin:24px 0"/>
          <p style="color:#a8a29e;font-size:12px">
            Sent by ${club?.name ?? "your club"} via ClubOS
          </p>
        </div>
      `;

      for (const to of recipients) {
        try {
          await sendEmail({ to, subject, html });
          succeeded++;
        } catch {
          failed++;
        }
      }

      emailDelivery = {
        attempted: recipients.size,
        succeeded,
        failed,
      };
    }

    return NextResponse.json({ ...announcement, emailDelivery }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
}
