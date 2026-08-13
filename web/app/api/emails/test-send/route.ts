import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { validateEmailBlocks, blocksToPlainText } from "@/lib/emailBlocks";
import { renderEmail } from "@/lib/emailRender";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { publicClubLogoUrl } from "@/lib/clubLogo";
import { resolvePostalAddressLines } from "@/lib/emailPostalAddress";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

// POST /api/emails/test-send
//
// Renders composer blocks through the exact same emailRender path a real
// bulk send uses and delivers ONE copy to the LOGGED-IN USER'S own email
// address. Not to a caller-supplied address — a test-send that accepted a
// `to` field would be an open relay for anyone with a session, and there's
// no legitimate use case for "test-send this to somebody else's inbox".
//
// Auth: session required + messages:view (same gate the composer preview
// uses; the send itself needs messages:send). No tier gate here — a Growth
// club owner can still verify how their draft looks before considering the
// upgrade the real send would prompt.
//
// Rate-limited to 10 per minute per user because this actually ships email
// through the configured provider.
//
// The row lands on EmailSend like any other send but with kind='TEMPLATE'
// so it doesn't pollute BULK/ANNOUNCEMENT campaign counts. No sendBatchId
// so the partial unique index doesn't fire — two identical test sends land
// as two separate rows, which is what you want when iterating.

// Messages are written for the person who will read them, not for a validator.
// The bare Zod defaults surfaced "String must contain at least 1 character(s)"
// on the one thing a composer is guaranteed to hit — pressing Send test before
// typing a subject.
const schema = z.object({
  subject: z.string().min(1, "Add a subject before sending a test — it's the first thing the recipient sees.").max(300, "Subject is too long (300 characters max)."),
  previewText: z.string().max(200, "Preview text is too long (200 characters max).").optional().nullable(),
  blocks: z.array(z.unknown()).min(1, "Add some content before sending a test — the email is currently empty."),
});

export const maxDuration = 30;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  // The caller's own inbox is the ONLY delivery target. A session with no
  // stored email address (shouldn't happen for OWNER/STAFF, but guard it)
  // means we have nowhere to send.
  const recipientEmail = session.user.email?.trim().toLowerCase();
  if (!recipientEmail) {
    return NextResponse.json(
      { error: "Your account has no email address on file — cannot send a test." },
      { status: 400 },
    );
  }

  const rl = rateLimit({
    key: `email-test:${session.user.id}`,
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many test sends. Wait a minute and try again.");

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const blocksResult = validateEmailBlocks(data.blocks);
  if (!blocksResult.ok) {
    return NextResponse.json({ error: "Invalid message blocks.", details: blocksResult.errors }, { status: 400 });
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      id: true, name: true, primaryColor: true, timezone: true,
      contactEmail: true, contactPhone: true, websiteUrl: true,
      publicEmail: true, publicPhone: true,
      mailingAddress: true, mailingAddress2: true, mailingCity: true,
      mailingState: true, mailingZip: true, mailingCountry: true,
      logoUrl: true, emailFromName: true, emailReplyTo: true,
    },
  });
  if (!club) return NextResponse.json({ error: "Club not found." }, { status: 404 });

  const rendered = await renderEmail(blocksResult.blocks, {
    clubName: club.name,
    clubLogoUrl: publicClubLogoUrl(club.id, club.logoUrl),
    clubContact: {
      // Same public-first / contact-fallback as the bulk path so what an
      // owner sees in a test send exactly matches what members receive.
      email: club.publicEmail ?? club.contactEmail,
      phone: club.publicPhone ?? club.contactPhone,
      website: club.websiteUrl,
      address: null, // renderContact fills this from club mailing* below
    },
    club,
    // A test send never gets a real unsubscribe URL — it's not marketing
    // to the caller. Omit so the marketing footer just shows the postal
    // address without a self-unsubscribe link the tester would trip on.
    unsubscribeUrl: null,
    postalAddress: resolvePostalAddressLines(club),
    accentColor: club.primaryColor,
  });

  // Prefix the subject so the tester can distinguish this from a real
  // announcement in their own inbox — critical when an owner sends
  // themselves a test AND is also on a real audience.
  const subject = `[Test] ${data.subject}`;
  const bodyText = rendered.text || blocksToPlainText(blocksResult.blocks);

  const result = await sendClubEmail({
    clubId: club.id,
    // TRANSACTIONAL bypasses opt-out — the caller might have opted their
    // own address out of marketing globally, but a test-send is not
    // marketing; it's the sender verifying their own draft.
    kind: "TRANSACTIONAL",
    recipientEmail,
    recipientUserId: session.user.id,
    recipientMemberId: null,
    subject,
    bodyHtml: rendered.html,
    bodyText,
    bodyJson: blocksResult.blocks,
    fromName: club.emailFromName ?? club.name,
    replyTo: club.emailReplyTo ?? club.contactEmail ?? undefined,
  });

  if (result.status === "FAILED") {
    return NextResponse.json({ error: result.error ?? "Send failed." }, { status: 502 });
  }
  if (result.status === "SKIPPED") {
    // Most likely NO_PROVIDER in local dev (no RESEND_API_KEY / SMTP).
    return NextResponse.json({
      ok: false,
      code: "SKIPPED",
      skippedReason: result.skippedReason ?? "unknown",
      hint: result.skippedReason === "NO_PROVIDER"
        ? "No email provider is configured. Set RESEND_API_KEY or SMTP_HOST in .env before test-sending."
        : undefined,
    }, { status: 202 });
  }

  return NextResponse.json({
    ok: true,
    emailSendId: result.emailSendId,
    deliveredTo: recipientEmail,
  });
}
