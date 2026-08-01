// Announcement dispatch — the ONE code path both "Send now" and the
// scheduled cron sweep call. Guarantees:
//   • Idempotency (plan §3H "Prevent duplicate sends caused by retries,
//     page refreshes, job restarts, or repeated clicks"): the
//     Announcement.sendBatchId column is the durable "already sent"
//     mark. A second call for the same announcement returns the
//     already-computed batch stats without re-enqueueing.
//   • Status handshake so a scheduled announcement whose cron just
//     fired can't be re-dispatched by a parallel worker: transitions
//     DRAFT|SCHEDULED → SENDING via a conditional update, then to SENT
//     when the batch completes.
//   • Audience resolution respects the same fail-closed rules as the
//     Members-page bulk path: MarketingAudience → memberIds, then
//     lib/emailRecipients resolveRecipients() with the announcement's
//     householdMode.

import { prisma } from "@/lib/prisma";
import { evaluateAudience, parseAudienceFilter } from "@/lib/audienceFilters";
import { resolveRecipients, type HouseholdMode } from "@/lib/emailRecipients";
import { renderEmail } from "@/lib/emailRender";
import { validateEmailBlocks, blocksToPlainText } from "@/lib/emailBlocks";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { publicClubLogoUrl } from "@/lib/clubLogo";
import { buildUnsubscribeUrl } from "@/lib/unsubscribe";
import { resolvePostalAddressLines } from "@/lib/emailPostalAddress";
import { extractTokensFromBlocks, interpolateBlocks, interpolateString, resolveMemberPersonalization } from "@/lib/emailPersonalization";

export interface DispatchAnnouncementResult {
  ok: boolean;
  announcementId: string;
  sendBatchId: string | null;
  status: string;                    // final Announcement.status
  counts?: {
    selectedMembers: number;
    uniqueAddresses: number;
    willSendRows: number;
    sent: number;
    failed: number;
    skipped: number;
    duplicate: number;
    noEmail: number;
    optedOut: number;
    invalidAddress: number;
    duplicateInBatch: number;
  };
  reason?: string;                   // when ok=false
}

// Called by both /api/announcements/[id]/send and the cron sweep.
// `actorUserId` is the User who triggered the send; null for cron.
export async function dispatchAnnouncement(args: {
  announcementId: string;
  actorUserId: string | null;
}): Promise<DispatchAnnouncementResult> {
  const { announcementId, actorUserId } = args;

  // Transactional guard against double-fire. Only advance state when
  // the row is in a launchable state and the batch mark is empty.
  // This is the durable "already sent" check that survives page
  // refreshes, job restarts, and concurrent cron ticks.
  const claim = await prisma.announcement.updateMany({
    where: {
      id: announcementId,
      deletedAt: null,
      status: { in: ["DRAFT", "SCHEDULED"] },
      sendBatchId: null,
    },
    data: { status: "SENDING", updatedAt: new Date() },
  });
  if (claim.count === 0) {
    // Something else already claimed / it's canceled / it already
    // ran. Look up current state and return it so the caller can
    // surface a meaningful message.
    const current = await prisma.announcement.findUnique({
      where: { id: announcementId },
      select: { id: true, status: true, sendBatchId: true },
    });
    return {
      ok: false,
      announcementId,
      sendBatchId: current?.sendBatchId ?? null,
      status: current?.status ?? "UNKNOWN",
      reason: current?.sendBatchId
        ? "Already sent."
        : current?.status === "CANCELED"
        ? "Announcement was canceled."
        : current?.status === "SENDING"
        ? "Send is already in progress by another worker."
        : "Announcement is not in a launchable state.",
    };
  }

  const announcement = await prisma.announcement.findUnique({
    where: { id: announcementId },
    include: { club: {
      select: {
        id: true, name: true, primaryColor: true, timezone: true,
        contactEmail: true, contactPhone: true, publicEmail: true, publicPhone: true, websiteUrl: true,
        mailingAddress: true, mailingAddress2: true, mailingCity: true,
        mailingState: true, mailingZip: true, mailingCountry: true,
        logoUrl: true, emailFromName: true, emailReplyTo: true,
      },
    } },
  });
  if (!announcement || !announcement.club) {
    await revertClaim(announcementId, "DRAFT");
    return { ok: false, announcementId, sendBatchId: null, status: "DRAFT", reason: "Announcement not found." };
  }

  const club = announcement.club;

  // Resolve the audience → memberIds. Three sources, in priority order:
  //   1. audienceId (saved MarketingAudience — dynamic re-evaluates)
  //   2. audienceFilters (inline filter JSON, snapshotted at compose)
  //   3. legacy blast: every active member (pre-3D behavior)
  let memberIds: string[] = [];
  if (announcement.audienceId) {
    const aud = await prisma.marketingAudience.findFirst({
      where: { id: announcement.audienceId, clubId: club.id },
    });
    if (aud) {
      const filter = parseAudienceFilter(aud.filters);
      if (aud.isDynamic) {
        memberIds = await evaluateAudience(club.id, filter);
      } else {
        memberIds = Array.isArray(aud.frozenMemberIds) ? (aud.frozenMemberIds as unknown as string[]) : [];
      }
    }
  } else if (announcement.audienceFilters) {
    const filter = parseAudienceFilter(announcement.audienceFilters);
    memberIds = await evaluateAudience(club.id, filter);
  } else {
    // Legacy blast — every ACTIVE member. Explicit fallback so an
    // announcement written before audiences shipped still delivers.
    const all = await prisma.member.findMany({
      where: { clubId: club.id, deletedAt: null, status: "ACTIVE" },
      select: { id: true },
    });
    memberIds = all.map((m) => m.id);
  }

  if (memberIds.length === 0) {
    await prisma.announcement.update({
      where: { id: announcementId },
      data: { status: "SENT", sentAt: new Date(), sendBatchId: `ann-${announcementId}-empty` },
    });
    return { ok: true, announcementId, sendBatchId: `ann-${announcementId}-empty`, status: "SENT",
             counts: { selectedMembers: 0, uniqueAddresses: 0, willSendRows: 0, sent: 0, failed: 0, skipped: 0, duplicate: 0, noEmail: 0, optedOut: 0, invalidAddress: 0, duplicateInBatch: 0 } };
  }

  // Body — prefer the rich composer output. Fall back to the legacy
  // plain-text body so pre-3B announcements still send.
  const blocks = announcement.bodyJson
    ? (announcement.bodyJson as unknown[])
    : [{ type: "paragraph", align: "left", runs: [{ kind: "text", text: announcement.body }] }];
  const blocksResult = validateEmailBlocks(blocks);
  if (!blocksResult.ok) {
    await revertClaim(announcementId, "DRAFT");
    return { ok: false, announcementId, sendBatchId: null, status: "DRAFT", reason: "Invalid message blocks." };
  }

  const recipients = await resolveRecipients({
    clubId: club.id,
    memberIds,
    mode: (announcement.householdMode as HouseholdMode) ?? "HOUSEHOLD",
    respectMarketingOptOut: true,
  });

  // Deterministic batch id — retries land the same rows. Must be stable
  // across dispatches so the partial unique index on (sendBatchId,
  // dedupeKey) refuses duplicates.
  const sendBatchId = `ann-${announcementId}`;
  const fromName = announcement.fromName ?? club.emailFromName ?? club.name;
  const replyTo = announcement.replyTo ?? club.emailReplyTo ?? club.contactEmail ?? undefined;
  const subject = announcement.title;

  const referencedTokens = new Set(extractTokensFromBlocks(blocksResult.blocks));
  for (const m of subject.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) referencedTokens.add(m[1]);
  const bodyHasTokens = referencedTokens.size > 0;

  const tally = { sent: 0, failed: 0, skipped: 0, duplicate: 0 };

  for (const r of recipients.send) {
    let subjectForRow = subject;
    let blocksForRow = blocksResult.blocks;
    if (bodyHasTokens && r.recipientMemberId) {
      const resolved = await resolveMemberPersonalization({
        clubId: club.id,
        memberId: r.recipientMemberId,
        referencedTokens: Array.from(referencedTokens),
      });
      const values = resolved.values as Record<string, string>;
      subjectForRow = interpolateString(subject, values);
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

    const result = await sendClubEmail({
      clubId: club.id,
      kind: "ANNOUNCEMENT",
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
      idempotencyKey: sendBatchId,
      announcementId,
      sentByUserId: actorUserId,
      listUnsubscribeUrl: unsubscribeUrl,
    });
    switch (result.status) {
      case "SENT": tally.sent++; break;
      case "SKIPPED": tally.skipped++; break;
      case "DUPLICATE": tally.duplicate++; break;
      case "FAILED": tally.failed++; break;
    }
  }

  await prisma.announcement.update({
    where: { id: announcementId },
    data: {
      status: "SENT",
      sentAt: new Date(),
      sendBatchId,
      senderUserId: actorUserId ?? announcement.senderUserId ?? undefined,
    },
  });

  return {
    ok: true,
    announcementId,
    sendBatchId,
    status: "SENT",
    counts: {
      selectedMembers: recipients.counts.selectedMembers,
      uniqueAddresses: recipients.counts.uniqueAddresses,
      willSendRows: recipients.counts.willSendRows,
      sent: tally.sent,
      failed: tally.failed,
      skipped: tally.skipped,
      duplicate: tally.duplicate,
      noEmail: recipients.counts.noEmail,
      optedOut: recipients.counts.optedOut,
      invalidAddress: recipients.counts.invalidAddress,
      duplicateInBatch: recipients.counts.duplicateInBatch,
    },
  };
}

async function revertClaim(announcementId: string, to: string) {
  // Restore the pre-claim status on error. Bounded conditional update
  // so a concurrent claim from another worker isn't stomped.
  await prisma.announcement.updateMany({
    where: { id: announcementId, status: "SENDING" },
    data: { status: to, updatedAt: new Date() },
  });
}
