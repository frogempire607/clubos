// Which QUEUED emails the queue worker may pick up. PURE.
//
// `sendClubEmail` writes its row as QUEUED *before* it calls the provider, then
// flips it to SENT / FAILED. The worker (app/api/cron/email-queue) claims a row
// by deleting it and re-sending. Until 2026-11-15 the worker took ANY queued
// row — including one an inline send was in the middle of delivering. When a
// worker tick landed in that window:
//   - the family got the email twice;
//   - the inline send's own "mark it SENT" then failed (its row was gone),
//     threw out of the send loop, and the rest of that announcement's
//     recipients were never emailed.
// (It also showed up in the database as the one slow statement in the whole
// app: the worker's delete waiting ~1.6 s on the inline send's row.)
//
// So the worker leaves a row alone until it is old enough that no inline send
// can still be working on it. A send that genuinely died mid-flight is picked
// up after the grace period, which is the recovery we want.

/** Longer than the slowest inline send (provider pacing + rate-limit waits). */
export const QUEUE_PICKUP_GRACE_MS = 3 * 60 * 1000;

/** The newest `queuedAt` the worker may touch at `now`. */
export function queuePickupCutoff(now: Date): Date {
  return new Date(now.getTime() - QUEUE_PICKUP_GRACE_MS);
}

/** Prisma `where` for rows the worker may claim at `now`. */
export function queuePickupWhere(now: Date): { status: "QUEUED"; queuedAt: { lt: Date } } {
  return { status: "QUEUED", queuedAt: { lt: queuePickupCutoff(now) } };
}

/** True when a row queued at `queuedAt` may be claimed at `now`. */
export function isPickable(queuedAt: Date, now: Date): boolean {
  return queuedAt.getTime() < queuePickupCutoff(now).getTime();
}
