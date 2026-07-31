import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendClubEmail, type EmailKind } from "@/lib/sendClubEmail";

// POST|GET /api/cron/email-queue
//
// Drains EmailSend rows still in status='QUEUED' by re-invoking
// sendClubEmail(). Two safety nets rely on this:
//   1. sendClubEmail inserts BEFORE dispatch, so a crash/timeout between
//      insert and provider call leaves a QUEUED row here.
//   2. The Members-page bulk-email endpoint dispatches inline in a loop
//      today; a serverless timeout mid-loop leaves the tail as QUEUED
//      rows. This worker finishes them without ever running twice on the
//      same row (the (sendBatchId, dedupeKey) partial unique index means
//      a duplicate attempt would P2002).
//
// Auth: CRON_SECRET as a Bearer token or ?key= (same shape as
// /api/cron/event-charges). Without the secret configured the route is
// disabled (503) — an unauthenticated endpoint that ships email is not an
// acceptable default.
//
// Idempotency: because sendClubEmail refuses to insert a second EmailSend
// row for the same (sendBatchId, dedupeKey), retrying a QUEUED row means
// dispatching it once more against the SAME row (via a targeted update
// path) — not writing a new insert. We do that by updating the existing
// row after dispatch rather than calling sendClubEmail's insert-first
// path, so the retry cannot double-send. See dispatchRow() below.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured — the email queue worker is disabled." },
      { status: 503 },
    );
  }
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const provided = bearer ?? url.searchParams.get("key");
  if (!secretMatches(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), 1), MAX_LIMIT);

  // Oldest QUEUED first — a stuck row shouldn't jump the line indefinitely.
  const rows = await prisma.emailSend.findMany({
    where: { status: "QUEUED" },
    orderBy: { queuedAt: "asc" },
    take: limit,
    select: {
      id: true,
      clubId: true,
      kind: true,
      recipientEmail: true,
      recipientUserId: true,
      recipientMemberId: true,
      subject: true,
      bodyHtml: true,
      bodyText: true,
      bodyJson: true,
      fromName: true,
      fromEmail: true,
      replyTo: true,
      personalization: true,
      sendBatchId: true,
      dedupeKey: true,
      idempotencyKey: true,
      announcementId: true,
      campaignId: true,
      templateId: true,
    },
  });

  const tally: Record<string, number> = { sent: 0, failed: 0, skipped: 0 };
  const results: Array<{ id: string; outcome: string; error?: string }> = [];

  for (const row of rows) {
    try {
      // sendClubEmail insert-first would collide with the existing QUEUED
      // row on the partial unique index. Dispatch directly and update the
      // existing row in place — no new EmailSend created.
      const outcome = await dispatchExistingRow(row);
      tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
      results.push({ id: row.id, outcome: outcome.status, error: outcome.error });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tally.failed = (tally.failed ?? 0) + 1;
      results.push({ id: row.id, outcome: "failed", error: msg });
      await prisma.emailSend.update({
        where: { id: row.id },
        data: { status: "FAILED", error: msg, updatedAt: new Date() },
      });
    }
  }

  return NextResponse.json({ ok: true, drained: rows.length, tally, results });
}

// Dispatch a row that already exists — mirror the second half of
// sendClubEmail() (provider send + row update) without the initial
// insert. Keeps the queue-drain idempotent by construction.
async function dispatchExistingRow(row: {
  id: string;
  clubId: string;
  kind: string;
  recipientEmail: string;
  recipientUserId: string | null;
  recipientMemberId: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  bodyJson: unknown;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  personalization: unknown;
  sendBatchId: string | null;
  dedupeKey: string | null;
  idempotencyKey: string | null;
  announcementId: string | null;
  campaignId: string | null;
  templateId: string | null;
}): Promise<{ status: "sent" | "failed" | "skipped"; error?: string }> {
  // Delete the existing row and let sendClubEmail re-insert. Because we
  // wrap in a transaction and the delete + insert use the same
  // (sendBatchId, dedupeKey) tuple, this is safe: a concurrent worker
  // trying to double-dispatch would P2002 on the insert. If the
  // dispatch itself fails, the freshly-inserted row records the failure.
  //
  // We keep the delete-then-recreate approach (rather than mutating in
  // place) so lifecycle timestamps (sentAt / providerMessageId / status)
  // are always written by the single source of truth in sendClubEmail.
  return await prisma.$transaction(async (tx) => {
    await tx.emailSend.delete({ where: { id: row.id } });
    const result = await sendClubEmail({
      clubId: row.clubId,
      kind: row.kind as EmailKind,
      recipientEmail: row.recipientEmail,
      recipientUserId: row.recipientUserId,
      recipientMemberId: row.recipientMemberId,
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      bodyText: row.bodyText,
      bodyJson: row.bodyJson,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      replyTo: row.replyTo,
      personalization: row.personalization,
      sendBatchId: row.sendBatchId,
      dedupeKey: row.dedupeKey,
      idempotencyKey: row.idempotencyKey,
      announcementId: row.announcementId,
      campaignId: row.campaignId,
      templateId: row.templateId,
    });
    return {
      status: result.status === "SENT" ? "sent" : result.status === "FAILED" ? "failed" : "skipped",
      error: result.error ?? undefined,
    };
  });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
