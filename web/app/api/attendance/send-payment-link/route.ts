import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendEmail } from "@/lib/email";

// POST /api/attendance/send-payment-link
// Emails a Stripe Checkout link to a member's payer (guardian for minors).
// The URL itself always comes from an existing server-created Checkout
// session (e.g. /api/classes/[id]/charge) — this endpoint only delivers it,
// it never builds or alters pricing (no second billing engine). Used when a
// family has no saved card at the desk.
const schema = z.object({
  memberId: z.string().min(1),
  url: z.string().url(),
  amountLabel: z.string().max(40), // display only, e.g. "$40.00"
  contextLabel: z.string().max(120), // e.g. "Sunday Funday drop-in"
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "attendance", "edit");
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { memberId, url, amountLabel, contextLabel } = parsed.data;

  // Only checkout URLs our own server minted may be delivered.
  if (!/^https:\/\/checkout\.stripe\.com\//.test(url)) {
    return NextResponse.json({ error: "Only Stripe Checkout links can be sent" }, { status: 400 });
  }

  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId: session.user.clubId },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      isMinor: true,
      guardianEmail: true,
      guardian: { select: { email: true } },
      user: { select: { email: true } },
      club: { select: { name: true } },
    },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const to = member.isMinor
    ? member.guardian?.email || member.guardianEmail || member.email || member.user?.email
    : member.email || member.user?.email || member.guardianEmail;
  if (!to) return NextResponse.json({ error: "No email on file for this member's payer" }, { status: 409 });

  const clubName = member.club?.name ?? "your club";
  await sendEmail({
    to,
    subject: `Payment link from ${clubName} — ${amountLabel}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto">
        <h2 style="color:#1c1917;margin:0 0 8px">Complete your payment</h2>
        <p style="color:#57534e;line-height:1.6;margin:0 0 16px">
          ${clubName} sent you a secure payment link for <strong>${contextLabel}</strong>
          (${amountLabel}) for ${member.firstName}.
        </p>
        <a href="${url}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
          Pay securely with Stripe
        </a>
        <p style="color:#a8a29e;font-size:13px;margin:20px 0 0">
          Payment is processed by Stripe on a secure page. This link expires after 24 hours.
        </p>
      </div>
    `,
  });

  return NextResponse.json({ ok: true, sentTo: to });
}
