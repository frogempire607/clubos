// Shared tally over EmailSend rows.
//
// Two surfaces need the same arithmetic: the announcement results page
// (3G, keyed on announcementId) and the batch results page (keyed on
// sendBatchId — the Members-tab bulk send, which has no Announcement
// row at all). Before this module they were the same twelve filters
// typed twice; the D-3 lesson is that a count and the list it links to
// must come from ONE predicate, or they drift.
//
// Pure: no prisma, no IO. Tested by scripts/email-results-tests.ts.

export interface TallyRow {
  status: string;
  skippedReason: string | null;
  providerMessageId: string | null;
  sentAt: Date | string | null;
  deliveredAt: Date | string | null;
  bouncedAt: Date | string | null;
  openedAt: Date | string | null;
  clickedAt: Date | string | null;
}

export interface EmailCounts {
  intended: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
  queued: number;
  skipped: number;
  skippedNoEmail: number;
  skippedOptedOut: number;
  skippedInvalid: number;
  skippedDuplicate: number;
  skippedNoProvider: number;
  // Only rows the provider accepted carry a providerMessageId, and only
  // those can ever report an open. SMTP sends never fire one. This is
  // the divisor the UI must use — "opened by 12 of 40 trackable" is
  // honest; "12 of 300" reads as a 4% open rate that never existed.
  trackingCapable: number;
}

export function tallyEmailSends(rows: TallyRow[]): EmailCounts {
  const n = (pred: (r: TallyRow) => boolean) => rows.filter(pred).length;
  return {
    intended: rows.length,
    // A row that has been delivered/opened/clicked was sent, whatever
    // the status column happens to say after later webhook writes.
    sent: n((r) => r.status === "SENT" || !!r.deliveredAt || !!r.openedAt || !!r.clickedAt || !!r.sentAt),
    delivered: n((r) => !!r.deliveredAt),
    opened: n((r) => !!r.openedAt),
    clicked: n((r) => !!r.clickedAt),
    bounced: n((r) => !!r.bouncedAt),
    failed: n((r) => r.status === "FAILED"),
    queued: n((r) => r.status === "QUEUED"),
    skipped: n((r) => r.status === "SKIPPED"),
    skippedNoEmail: n((r) => r.skippedReason === "NO_EMAIL"),
    skippedOptedOut: n((r) => r.skippedReason === "OPTED_OUT"),
    skippedInvalid: n((r) => r.skippedReason === "INVALID_ADDRESS"),
    skippedDuplicate: n((r) => r.skippedReason === "DUPLICATE_IN_BATCH"),
    skippedNoProvider: n((r) => r.skippedReason === "NO_PROVIDER"),
    trackingCapable: n((r) => r.providerMessageId != null),
  };
}

export function trackingCapableRatio(counts: EmailCounts): number {
  return counts.intended ? counts.trackingCapable / counts.intended : 0;
}

// What the batch is still doing, in one word, for the list view.
// QUEUED rows are the 3M large-send path: the cron worker has not
// drained them yet. "Sending" is the truth there, not "sent".
export type BatchState = "SENDING" | "SENT" | "PROBLEMS" | "NOTHING_SENT";

export function batchState(counts: EmailCounts): BatchState {
  if (counts.queued > 0) return "SENDING";
  if (counts.sent === 0) return "NOTHING_SENT";
  if (counts.failed > 0 || counts.bounced > 0) return "PROBLEMS";
  return "SENT";
}

export function batchStateLabel(state: BatchState): string {
  switch (state) {
    case "SENDING": return "Sending";
    case "SENT": return "Sent";
    case "PROBLEMS": return "Sent with problems";
    case "NOTHING_SENT": return "Nothing sent";
  }
}
