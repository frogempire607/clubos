import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { filterMemberIdsByCoachAudience } from "@/lib/coachAudience";
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
import { resolvePostalAddressLines } from "@/lib/emailPostalAddress";
import {
  extractTokensFromBlocks,
  interpolateBlocks,
  interpolateString,
  resolveMemberPersonalization,
  type PersonalizationContext,
} from "@/lib/emailPersonalization";
import { enqueueEmailSendRows, INLINE_DISPATCH_MAX, type EnqueueRow } from "@/lib/enqueueEmailSend";

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
      mode: z.enum([
        "HOUSEHOLD",
        "PER_MEMBER",
        "PER_ATHLETE_PRIMARY",
        "ATHLETE_ONLY",
        "PRIMARY_GUARDIAN",
        "ALL_GUARDIANS",
        "PAYER",
        "ACCOUNT_HOLDER",
      ]).default("HOUSEHOLD"),
      subject: z.string().min(1).max(300),
      previewText: z.string().max(200).optional().nullable(),
      blocks: z.array(z.unknown()).min(1),
      fromName: z.string().max(120).optional().nullable(),
      replyTo: z.string().email().optional().nullable(),
      // Client-generated idempotency key. When present, retries with the
      // same key resolve to the same sendBatchId + return the same
      // response — no double-send, no double-count.
      clientKey: z.string().min(8).max(128).optional(),
      // Personalization context (plan §3F). Owner-supplied "the event is
      // X" / "the class is Y" values are the same for every recipient in
      // the batch; per-member auto-resolved tokens (guardian_first_name,
      // outstanding_balance, membership_end_date, …) fill in the rest.
      personalization: z
        .object({
          eventName: z.string().max(200).nullable().optional(),
          className: z.string().max(200).nullable().optional(),
          coachName: z.string().max(200).nullable().optional(),
          registrationLink: z.string().max(500).nullable().optional(),
          paymentLink: z.string().max(500).nullable().optional(),
          overrides: z.record(z.string().nullable()).optional(),
        })
        .optional(),
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
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
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
  // 3L — messages.bulk is the gate for the Members-page bulk composer.
  // A coach with plain messages:send can still DM one member; only staff
  // with the bulk sub-scope can address the whole roster.
  const bulkDenied = requireMessagesSubScope(session, "bulk");
  if (bulkDenied) return bulkDenied;

  // 3L coach-restricted audience — a coach without audience_all_club may
  // only address members enrolled in classes/events they teach. Filter
  // the requested id list BEFORE we build the recipient set so a
  // fabricated memberId in the payload can't cross the coach's boundary.
  const audienceFilter = await filterMemberIdsByCoachAudience(
    { role: session.user.role, userId: session.user.id, clubId: session.user.clubId, permissions: session.user.permissions ?? null },
    memberIds,
  );
  const scopedMemberIds = audienceFilter.allowed;
  const droppedByAudience = audienceFilter.dropped;

  if (scopedMemberIds.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "OUTSIDE_COACH_AUDIENCE",
        error: "You can only email members enrolled in a class or event you teach. None of the selected members qualified.",
        droppedByAudience: droppedByAudience.length,
      },
      { status: 403 },
    );
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      id: true, name: true, tier: true, timezone: true, primaryColor: true,
      contactEmail: true, contactPhone: true, websiteUrl: true, hoursOfOperation: true,
      publicEmail: true, publicPhone: true,
      mailingAddress: true, mailingAddress2: true, mailingCity: true,
      mailingState: true, mailingZip: true, mailingCountry: true,
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
    memberIds: scopedMemberIds,
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

  // Personalization (plan §3F): every recipient gets a fresh interpolate
  // pass so a token like {{guardian_first_name}} resolves to THIS
  // guardian, never bleeding across families. If the body has no
  // {{tokens}}, the loop is byte-identical to the pre-3F path.
  const referencedTokens = new Set(extractTokensFromBlocks(blocksResult.blocks));
  for (const m of email.subject.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    referencedTokens.add(m[1]);
  }
  const bodyHasTokens = referencedTokens.size > 0;
  const context: PersonalizationContext = email.personalization ?? {};

  // 3M safety net for large sends: above INLINE_DISPATCH_MAX recipients
  // we render + enqueue QUEUED rows and let the cron worker (drains
  // every 5min, batches of 50) handle dispatch. Inline dispatch of 292
  // recipients averaged ~117s vs Netlify's 60s ceiling — the tail
  // silently disappears because rows past the timeout never get
  // inserted. The enqueue path completes in ~15s for 300 rows and
  // guarantees every recipient at least has a row.
  const useQueueOnly = recipients.send.length > INLINE_DISPATCH_MAX;

  if (useQueueOnly) {
    // Render (per-recipient) + enqueue only. sendClubEmail's own opt-out
    // gate ran during resolveRecipients (respectMarketingOptOut=true),
    // so QUEUED rows shipping to the cron are already opt-out-safe.
    const enqueueRows: EnqueueRow[] = [];
    for (const r of recipients.send) {
      let subjectForRow = email.subject;
      let blocksForRow = blocksResult.blocks;
      if (bodyHasTokens && r.recipientMemberId) {
        const resolved = await resolveMemberPersonalization({
          clubId: club.id,
          memberId: r.recipientMemberId,
          referencedTokens: Array.from(referencedTokens),
          context,
        });
        const values = resolved.values as Record<string, string>;
        subjectForRow = interpolateString(email.subject, values);
        blocksForRow = interpolateBlocks(blocksResult.blocks, values);
      }
      const unsubscribeUrl = buildUnsubscribeUrl(club.id, r.recipientEmail);
      const rendered = await renderEmail(blocksForRow, {
        clubName: club.name,
        clubLogoUrl: publicClubLogoUrl(club.id, club.logoUrl),
        clubContact: {
          email: club.publicEmail ?? club.contactEmail,
          phone: club.publicPhone ?? club.contactPhone,
          website: club.websiteUrl,
          address: null,
        },
        club,
        unsubscribeUrl,
        postalAddress: resolvePostalAddressLines(club),
        accentColor: club.primaryColor,
      });
      enqueueRows.push({
        kind: "BULK",
        recipientEmail: r.recipientEmail,
        recipientUserId: r.recipientUserId,
        recipientMemberId: r.recipientMemberId,
        subject: subjectForRow,
        bodyHtml: rendered.html,
        bodyText: rendered.text || blocksToPlainText(blocksForRow),
        bodyJson: blocksForRow,
        fromName,
        replyTo,
        sendBatchId,
        dedupeKey: r.dedupeKey,
        idempotencyKey: email.clientKey,
        sentByUserId: session.user.id,
        listUnsubscribeUrl: unsubscribeUrl,
      });
    }
    const enq = await enqueueEmailSendRows(club.id, enqueueRows);
    return NextResponse.json({
      ok: true,
      sendBatchId,
      // Naming: `queued` = rows enqueued but not yet dispatched. The UI
      // renders "Send queued — will finish within a few minutes" in
      // this branch. `sent` stays 0 because dispatch runs later.
      results: {
        queued: enq.enqueued,
        sent: 0,
        skipped: 0,
        failed: enq.failed,
        duplicate: enq.duplicate,
      },
      queueOnly: true,
      skippedResolvers: recipients.skipped.slice(0, 200),
      failures: enq.failures.slice(0, 200),
      counts: recipients.counts,
    });
  }

  for (const r of recipients.send) {
    // Resolve personalization for THIS recipient's underlying member
    // (recipientMemberId). Skip the DB round-trip when the body has no
    // tokens at all — a subtle but real perf win on plain broadcasts.
    let subjectForRow = email.subject;
    let blocksForRow = blocksResult.blocks;
    if (bodyHasTokens && r.recipientMemberId) {
      const resolved = await resolveMemberPersonalization({
        clubId: club.id,
        memberId: r.recipientMemberId,
        referencedTokens: Array.from(referencedTokens),
        context,
      });
      const values = resolved.values as Record<string, string>;
      subjectForRow = interpolateString(email.subject, values);
      blocksForRow = interpolateBlocks(blocksResult.blocks, values);
    }

    const unsubscribeUrl = buildUnsubscribeUrl(club.id, r.recipientEmail);
    const rendered = await renderEmail(blocksForRow, {
      clubName: club.name,
      clubLogoUrl: publicClubLogoUrl(club.id, club.logoUrl),
      clubContact: {
        // Prefer the member-facing public* values; fall back to the
        // admin contact* so nothing regresses on the day M21 landed.
        // renderContact handles the same fallback centrally, but
        // passing the resolved values here keeps the contract explicit
        // and gives the Contact block address access to mailing*.
        email: club.publicEmail ?? club.contactEmail,
        phone: club.publicPhone ?? club.contactPhone,
        website: club.websiteUrl,
        address: null, // renderContact will build this from mailing* on the club
      },
      club,
      unsubscribeUrl,
      // Club-first with AthletixOS entity fallback. Two-line USPS
      // layout (street / city-state-zip) beats Gmail's smart-link
      // heuristic that used to auto-link the whole comma-joined line.
      // The completeness gate is enforced inside the helper —
      // partial addresses fall back to the entity address.
      postalAddress: resolvePostalAddressLines(club),
      accentColor: club.primaryColor,
    });

    const bodyText = rendered.text || blocksToPlainText(blocksForRow);
    const result = await sendClubEmail({
      clubId: club.id,
      kind: "BULK",
      recipientEmail: r.recipientEmail,
      recipientUserId: r.recipientUserId,
      recipientMemberId: r.recipientMemberId,
      subject: subjectForRow,
      bodyHtml: rendered.html,
      bodyText,
      bodyJson: blocksForRow,
      fromName,
      replyTo,
      sendBatchId,
      dedupeKey: r.dedupeKey,
      idempotencyKey: email.clientKey,
      // Without this the batch results page can't say who sent it. The
      // queue-only branch above has always set it; the inline branch
      // did not, so small sends lost their author.
      sentByUserId: session.user.id,
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
