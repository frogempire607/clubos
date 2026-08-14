// Bulk-email drafts.
//
// A draft is an Announcement with status DRAFT whose audience is a
// hand-picked member list. That is not a workaround — Announcement already
// carries subject, previewText, bodyJson, householdMode, fromName/replyTo,
// sender, and the whole DRAFT → SCHEDULED → SENT → CANCELED lifecycle with
// its dispatch and results pages. A second EmailDraft table would duplicate
// all of it and need its own migration, its own send path, and its own
// results view, and the two would drift.
//
// Pure helpers only — no prisma, no IO. Tested by scripts/email-drafts-tests.ts.

export const DRAFT_CHANNEL = "email";

/** The audience shape a hand-picked selection serialises to. */
export interface PickedAudience {
  match: "ALL";
  rules: never[];
  alwaysIncludeMemberIds: string[];
}

export function pickedAudience(memberIds: string[]): PickedAudience {
  // De-duplicated and sorted so re-saving an unchanged selection produces an
  // identical filter, which keeps "has this draft changed?" answerable.
  return {
    match: "ALL",
    rules: [],
    alwaysIncludeMemberIds: Array.from(new Set(memberIds)).sort(),
  };
}

/**
 * Read a hand-picked selection back out of a stored audience filter.
 *
 * Returns null when the filter is NOT a pure hand-picked list — a
 * rule-driven audience is a different thing and must not be silently
 * flattened into a member list the sender never chose.
 */
export function readPickedAudience(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const rules = Array.isArray(f.rules) ? f.rules : null;
  if (rules === null || rules.length > 0) return null;
  const ids = f.alwaysIncludeMemberIds;
  if (!Array.isArray(ids)) return null;
  const clean = ids.filter((v): v is string => typeof v === "string");
  return clean.length ? clean : null;
}

/**
 * A draft's display name. The subject is the honest label, but an empty
 * subject is a legitimate half-written draft and must still be findable.
 */
export function draftTitle(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  return s || "Untitled draft";
}

/**
 * Only a DRAFT may be edited. A scheduled send is already promised to
 * recipients at a time, and a sent one is history — rewriting either would
 * make the results page describe something that was never sent.
 */
export function draftIsEditable(status: string): boolean {
  return status === "DRAFT";
}

export function notEditableReason(status: string): string {
  switch (status) {
    case "SCHEDULED":
      return "This send is scheduled. Cancel it first if you want to change the message.";
    case "QUEUED":
    case "SENDING":
      return "This send is going out right now and can no longer be changed.";
    case "SENT":
      return "This has already been sent. Duplicate it if you want to send something similar.";
    case "CANCELED":
      return "This send was canceled. Duplicate it to start again.";
    default:
      return "This message can no longer be edited.";
  }
}
