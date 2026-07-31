import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendMemberMessage } from "@/lib/memberMessaging";
import { sendJoinInvite } from "@/lib/migrationServer";
import { deleteOrphanedMemberLogins } from "@/lib/memberLink";
import { getTierFeatures } from "@/lib/tier";
import { validateEmailBlocks, blocksToPlainText } from "@/lib/emailBlocks";
import { renderEmail } from "@/lib/emailRender";
import { resolveRecipients, type HouseholdMode } from "@/lib/emailRecipients";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { buildUnsubscribeUrl } from "@/lib/unsubscribe";
import { publicClubLogoUrl } from "@/lib/clubLogo";

// The email path can enqueue up to MAX_IDS EmailSend rows in one request
// (each is a single insert). Actual dispatch runs inline for now (Resend
// batch API will replace the loop in checkpoint E along with the cron
// worker); a serverless timeout during the loop leaves already-inserted
// rows visible so nothing is lost.
const MAX_IDS = 5000;
const LOOP_ACTION_LIMIT = 200;
const EMAIL_ACTION_LIMIT = 2000;
export const maxDuration = 60;

const schema = z.object({
  action: z.enum(["delete", "message", "send_registration_link", "email"]),
  memberIds: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  body: z.string().min(1).max(4000).optional(),
  // action=email fields
  email: z
    .object({
      mode: z.enum(["HOUSEHOLD", "PER_MEMBER", "PER_ATHLETE_PRIMARY"]).default("HOUSEHOLD"),
      subject: z.string().min(1).max(300),
      previewText: z.string().max(200).optional().nullable(),
      blocks: z.array(z.unknown()).min(1),
      fromName: z.string().max(120).optional().nullable(),
      replyTo: z.string().email().optional().nullable(),
      // Client-generated idempotency key. When present, retries with the
      // same key resolve to the same sendBatchId + return the same
      // response — no double-send, no double-count.
      clientKey: z.string().min(8).max(128).optional(),
    })
    .optional(),
});

// POST /api/members/bulk
// Owner/staff bulk action over selected members:
//   { action: "delete", memberIds }                     → soft-delete each
//   { action: "message", memberIds, body }              → DM each
//   { action: "send_registration_link", memberIds }     → invite each
//   { action: "email", memberIds, email: {…} }          → bulk email (Phase 3A)
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Scope to this club only.
  const owned = await prisma.member.findMany({
    where: { id: { in: data.memberIds }, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, userId: true },
  });
  const ids = owned.map((m) => m.id);
  if (ids.length === 0) return NextResponse.json({ error: "No matching members." }, { status: 404 });

  // Per-action size caps.
  if (
    (data.action === "message" || data.action === "send_registration_link") &&
    ids.length > LOOP_ACTION_LIMIT
  ) {
    return NextResponse.json(
      { error: `You can only do that for up to ${LOOP_ACTION_LIMIT} members at once. Select fewer and try again.` },
      { status: 400 },
    );
  }
  if (data.action === "email" && ids.length > EMAIL_ACTION_LIMIT) {
    return NextResponse.json(
      { error: `You can only email up to ${EMAIL_ACTION_LIMIT} members at once. Select fewer and try again.` },
      { status: 400 },
    );
  }

  if (data.action === "delete") {
    await prisma.member.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: new Date(), userId: null },
    });
    await deleteOrphanedMemberLogins(owned.map((m) => m.userId), session.user.clubId);
    return NextResponse.json({ ok: true, deleted: ids.length });
  }

  if (data.action === "send_registration_link") {
    let sent = 0;
    const skipped: { memberId: string; reason: string }[] = [];
    for (const memberId of ids) {
      const r = await sendJoinInvite(memberId, session.user.clubId, session.user.id);
      if (r.ok) sent++;
      else skipped.push({ memberId, reason: r.reason ?? "Could not send" });
    }
    return NextResponse.json({ ok: true, sent, skipped });
  }

  if (data.action === "email") {
    return handleBulkEmail(session, ids, data);
  }

  // action === "message"
  if (!data.body?.trim()) {
    return NextResponse.json({ error: "Message body is required." }, { status: 400 });
  }

  let sent = 0;
  const skipped: { memberId: string; reason: string }[] = [];
  for (const memberId of ids) {
    const result = await sendMemberMessage({
      clubId: session.user.clubId,
      senderId: session.user.id,
      memberId,
      body: data.body.trim(),
    });
    if (result.ok) sent++;
    else skipped.push({ memberId, reason: result.error ?? "Could not deliver" });
  }

  return NextResponse.json({ ok: true, sent, skipped });
}

// ─────────────────────────────────────────────────────────────────────────
// action === "email" — Phase 3A bulk send.
//
// Contract:
//   1. Require messages:send (bulk == send-tier action).
//   2. Tier-gate on features.emailSms (Pro+) — email blasts are a paid
//      feature; the members-page bulk bar hides the button on Growth but
//      the API MUST re-check.
//   3. Validate the composer blocks (client-side normalizer is not
//      authoritative — never trust JSON off the wire).
//   4. Resolve recipients through lib/emailRecipients — same code path
//      the preview endpoint uses, so the counts on the confirm button
//      match the counts on the receipt.
//   5. Enqueue one EmailSend row per recipient through lib/sendClubEmail.
//      That library is the ONLY place opt-out check, sanitize, dedup
//      insert, and provider dispatch live — the bulk route is a caller.
//   6. If the same clientKey is submitted twice (double-click, refresh,
//      retry), the second call reuses the sendBatchId — the partial
//      unique index rejects the duplicate inserts and returns DUPLICATE
//      per row without hitting the provider a second time.
// ─────────────────────────────────────────────────────────────────────────
async function handleBulkEmail(
  // Loose type to match the app's Session augmentation pattern (see
  // lib/apiGuard.ts). requirePermission uses `any`-style casts internally.
  session: {
    user: {
      id: string;
      clubId: string;
      role?: string;
      permissions?: Record<string, unknown> | null;
    };
  },
  memberIds: string[],
  data: z.infer<typeof schema>,
) {
  const email = data.email;
  if (!email) return NextResponse.json({ error: "Email payload required." }, { status: 400 });

  const denied = requirePermission(session, "messages", "send");
  if (denied) return denied;

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      id: true, name: true, tier: true, timezone: true, primaryColor: true,
      contactEmail: true, contactPhone: true, websiteUrl: true, hoursOfOperation: true,
      logoUrl: true, emailFromName: true, emailReplyTo: true,
    },
  });
  if (!club) return NextResponse.json({ error: "Club not found." }, { status: 404 });

  const features = getTierFeatures(club.tier ?? "growth");
  if (!features.emailSms) {
    return NextResponse.json(
      {
        error: "Your current plan does not include email blasts. Upgrade to Pro to email your members.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "pro",
      },
      { status: 403 },
    );
  }

  const blocksResult = validateEmailBlocks(email.blocks);
  if (!blocksResult.ok) {
    return NextResponse.json({ error: "Invalid message blocks.", details: blocksResult.errors }, { status: 400 });
  }

  const recipients = await resolveRecipients({
    clubId: club.id,
    memberIds,
    mode: email.mode as HouseholdMode,
    respectMarketingOptOut: true,
  });

  if (recipients.send.length === 0) {
    return NextResponse.json(
      { ok: false, code: "NO_ELIGIBLE_RECIPIENTS", counts: recipients.counts, skipped: recipients.skipped },
      { status: 400 },
    );
  }

  // Deterministic sendBatchId when a clientKey is present so retries land
  // on the SAME batch and the (sendBatchId, dedupeKey) partial unique
  // index does its job. Without a clientKey we generate a fresh UUID and
  // rely on the caller not to retry.
  const sendBatchId = email.clientKey
    ? `batch-${session.user.clubId}-${email.clientKey}`
    : `batch-${randomUUID()}`;

  const fromName = email.fromName ?? club.emailFromName ?? club.name;
  const replyTo = email.replyTo ?? club.emailReplyTo ?? club.contactEmail ?? undefined;

  const results = { queued: 0, sent: 0, skipped: 0, failed: 0, duplicate: 0 };
  const failures: { email: string; error: string }[] = [];

  // Per-recipient loop — each one owns its own render (personalization is
  // per-recipient in a later checkpoint; today the render is identical
  // per row but each recipient still gets a fresh unsubscribe token).
  for (const r of recipients.send) {
    const unsubscribeUrl = buildUnsubscribeUrl(club.id, r.recipientEmail);
    const rendered = await renderEmail(blocksResult.blocks, {
      clubName: club.name,
      clubLogoUrl: publicClubLogoUrl(club.id, club.logoUrl),
      clubContact: {
        email: club.contactEmail,
        phone: club.contactPhone,
        website: club.websiteUrl,
      },
      unsubscribeUrl,
      // TODO: club.postalAddress isn't on Club today — we hardcode the
      // AthletixOS entity address for CAN-SPAM until Phase 3.6 lands a
      // per-club postal field. Every marketing footer today uses the
      // same string.
      postalAddress: "AthletixOS · MC Technologies Group LLC · 981 Dryden Rd, Ithaca, NY 14850",
      accentColor: club.primaryColor,
    });

    const bodyText = rendered.text || blocksToPlainText(blocksResult.blocks);
    const result = await sendClubEmail({
      clubId: club.id,
      kind: "BULK",
      recipientEmail: r.recipientEmail,
      recipientUserId: r.recipientUserId,
      recipientMemberId: r.recipientMemberId,
      subject: email.subject,
      bodyHtml: rendered.html,
      bodyText,
      bodyJson: blocksResult.blocks,
      fromName,
      replyTo,
      sendBatchId,
      dedupeKey: r.dedupeKey,
      idempotencyKey: email.clientKey,
      listUnsubscribeUrl: unsubscribeUrl,
    });

    switch (result.status) {
      case "SENT": results.sent++; break;
      case "SKIPPED": results.skipped++; break;
      case "DUPLICATE": results.duplicate++; break;
      case "FAILED":
        results.failed++;
        failures.push({ email: r.recipientEmail, error: result.error ?? "unknown" });
        break;
    }
    results.queued++;
  }

  return NextResponse.json({
    ok: true,
    sendBatchId,
    results,
    // Skipped rows resolved by resolveRecipients (no-email, opt-out,
    // invalid, in-batch dupes) are surfaced here so the receipt UI can
    // show the same categories as the preview modal.
    skippedResolvers: recipients.skipped.slice(0, 200),
    failures: failures.slice(0, 200),
    counts: recipients.counts,
  });
}
