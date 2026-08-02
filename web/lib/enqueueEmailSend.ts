// Fast "enqueue without dispatch" for bulk email sends.
//
// Why this exists: the Members-page bulk send used to run render +
// provider dispatch inline in a per-recipient for-loop. At ~400ms per
// recipient (Prisma personalization fetch + mjml render + Resend HTTP
// call + row update) the request comfortably clears 60s at ~150
// recipients. Netlify kills the process, and any recipient not yet
// REACHED in the loop never gets an EmailSend row — silently dropped.
// The first real campaign here targets ~292 families from a domain
// with no sending history, where a half-send is materially worse than
// a delayed send.
//
// The fix: for anything above INLINE_DISPATCH_MAX recipients, insert
// EmailSend rows with status='QUEUED' + the fully rendered body, and
// return immediately. The /api/cron/email-queue worker picks them up
// (batches of 50 every 5 minutes) and dispatches via
// dispatchExistingRow, which is idempotent (transactional delete +
// re-invoke sendClubEmail; the M16 partial unique index rejects any
// double-insert). No inline dispatch means no provider double-fire
// window mid-timeout.
//
// Below INLINE_DISPATCH_MAX the caller keeps the inline path so
// senders get immediate feedback on small blasts.

import { prisma } from "@/lib/prisma";
import type { EmailKind } from "@/lib/sendClubEmail";

// Threshold above which the bulk route skips inline dispatch entirely
// and hands the batch to the cron worker. 100 = ~40s headroom at
// 400ms/row (comfortably below 60s Netlify limit). Kept exported so
// tests + UI can read it.
export const INLINE_DISPATCH_MAX = 100;

export interface EnqueueRow {
  kind: EmailKind;
  recipientEmail: string;         // lower-cased at write
  recipientUserId?: string | null;
  recipientMemberId?: string | null;
  subject: string;
  bodyHtml: string;                // pre-rendered snapshot
  bodyText?: string | null;
  bodyJson?: unknown;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  sendBatchId: string;             // required — all rows share one batch id
  dedupeKey: string;               // required — (batch, key) partial unique gate
  idempotencyKey?: string | null;
  announcementId?: string | null;
  campaignId?: string | null;
  templateId?: string | null;
  sentByUserId?: string | null;
  relatedEventId?: string | null;
  relatedMembershipId?: string | null;
  personalization?: unknown;
  listUnsubscribeUrl?: string | null;
}

export interface EnqueueResult {
  enqueued: number;
  duplicate: number;      // (sendBatchId, dedupeKey) already existed
  failed: number;         // insert threw for a non-collision reason
  failures: Array<{ email: string; error: string }>;
}

// Batch insert with per-row error isolation. createMany + skipDuplicates
// is faster but silently drops without telling us which rows collided;
// we WANT the {enqueued, duplicate} breakdown so the sender's receipt
// matches the pre-send review.
export async function enqueueEmailSendRows(clubId: string, rows: EnqueueRow[]): Promise<EnqueueResult> {
  const result: EnqueueResult = { enqueued: 0, duplicate: 0, failed: 0, failures: [] };

  // Concurrency: 20 parallel inserts. Higher risks tripping the pooler's
  // connection cap on shared Supabase plans; 20 is comfortable and cuts
  // wall time to ~15s for 300 rows.
  const BATCH = 20;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (r) => {
      try {
        await prisma.emailSend.create({
          data: {
            clubId,
            kind: r.kind,
            announcementId: r.announcementId ?? null,
            campaignId: r.campaignId ?? null,
            templateId: r.templateId ?? null,
            sentByUserId: r.sentByUserId ?? null,
            relatedEventId: r.relatedEventId ?? null,
            relatedMembershipId: r.relatedMembershipId ?? null,
            recipientEmail: r.recipientEmail.trim().toLowerCase(),
            recipientUserId: r.recipientUserId ?? null,
            recipientMemberId: r.recipientMemberId ?? null,
            subject: r.subject,
            bodyJson: (r.bodyJson ?? undefined) as never,
            bodyHtml: r.bodyHtml,
            bodyText: r.bodyText ?? null,
            fromName: r.fromName ?? null,
            fromEmail: r.fromEmail ?? null,
            replyTo: r.replyTo ?? null,
            personalization: (r.personalization ?? undefined) as never,
            status: "QUEUED",
            sendBatchId: r.sendBatchId,
            dedupeKey: r.dedupeKey,
            idempotencyKey: r.idempotencyKey ?? null,
          },
          select: { id: true },
        });
        result.enqueued++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          result.duplicate++;
        } else {
          result.failed++;
          result.failures.push({ email: r.recipientEmail, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }));
  }

  return result;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}
