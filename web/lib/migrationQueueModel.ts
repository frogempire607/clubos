// B6 — the migration queue's chrome, as pure rules.
//
//   · whose turn it is (the segmented control above the queue)
//   · what "Needs you" is made of (the 4-up cards)
//   · why someone was skipped by a bulk send (the §1k success / error states)
//   · the empty-search sentence and its spelling suggestion
//
// NO PRISMA, NO REACT. The funnel route, the list route, the send route and the
// page all call these, and scripts/migration-b6-tests.ts runs them with no
// database. The segment rule is the funnel's rule — if the two ever disagreed,
// a segment count and the list it opens would differ.

import { MIGRATION_STEP_COUNT, WAITING_ON, type WaitingOn } from "./memberTracks";

/** Just the parts of MigrationMeter these rules read. */
export type MeterLike = { step: number; waitingOn: WaitingOn | string };

// ─────────────────────────────────────────────────────────────────────────────
// Whose turn
// ─────────────────────────────────────────────────────────────────────────────

export const QUEUE_TURNS = ["needs_you", "waiting_member", "in_setup", "done"] as const;
export type QueueTurn = (typeof QUEUE_TURNS)[number];

export const QUEUE_TURN_LABELS: Record<QueueTurn, string> = {
  needs_you: "Needs you",
  waiting_member: "Waiting on member",
  in_setup: "In setup",
  done: "Done",
};

export function asQueueTurn(v: string | null | undefined): QueueTurn | null {
  return v && (QUEUE_TURNS as readonly string[]).includes(v) ? (v as QueueTurn) : null;
}

/**
 * Identical to the funnel route's bucket rule: finished outranks everything;
 * blocked and staff are both "needs you"; member is "waiting on member"; the
 * rest (snoozed, nobody's move) is "in setup".
 */
export function turnOf(m: MeterLike): QueueTurn {
  if (m.step >= MIGRATION_STEP_COUNT) return "done";
  if (m.waitingOn === WAITING_ON.BLOCKED || m.waitingOn === WAITING_ON.STAFF) return "needs_you";
  if (m.waitingOn === WAITING_ON.MEMBER) return "waiting_member";
  return "in_setup";
}

// ─────────────────────────────────────────────────────────────────────────────
// What "Needs you" is made of
// ─────────────────────────────────────────────────────────────────────────────

export const NEEDS = ["review", "invite", "approve", "blocked"] as const;
export type Need = (typeof NEEDS)[number];

export const NEED_COPY: Record<Need, { title: string; body: string; action: string }> = {
  review: {
    title: "Review imported info",
    body: "Check what came over before anyone is invited.",
    action: "Review",
  },
  invite: {
    title: "Send invitations",
    body: "Reviewed, but nobody has pressed send yet.",
    action: "Invite",
  },
  approve: {
    title: "Approve memberships",
    body: "Profile done — their billing needs your yes.",
    action: "Approve",
  },
  blocked: {
    title: "Fix blocked people",
    body: "Bounced, missing or never-opened email.",
    action: "Fix",
  },
};

export function asNeed(v: string | null | undefined): Need | null {
  return v && (NEEDS as readonly string[]).includes(v) ? (v as Need) : null;
}

/**
 * Which card a "needs you" person belongs to, or null (not needs-you, or a
 * staff step with no card — step 6 "finish the migration").
 *
 * `step` is the number of COMPLETED steps, so step 1 means "Information
 * reviewed" is the current one, step 2 means "Invitation sent" is, and step 5
 * means "Membership confirmed" is.
 */
export function needOf(m: MeterLike): Need | null {
  if (turnOf(m) !== "needs_you") return null;
  if (m.waitingOn === WAITING_ON.BLOCKED) return "blocked";
  if (m.step <= 1) return "review";
  if (m.step === 2) return "invite";
  if (m.step === 5) return "approve";
  return null;
}

export type TurnCounts = Record<QueueTurn, number>;
export type NeedCounts = Record<Need, number>;

export function countTurnsAndNeeds(meters: Iterable<MeterLike>): { turns: TurnCounts; needs: NeedCounts } {
  const turns: TurnCounts = { needs_you: 0, waiting_member: 0, in_setup: 0, done: 0 };
  const needs: NeedCounts = { review: 0, invite: 0, approve: 0, blocked: 0 };
  for (const m of meters) {
    turns[turnOf(m)]++;
    const n = needOf(m);
    if (n) needs[n]++;
  }
  return { turns, needs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send results — skipped vs undelivered
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SKIPPED = we chose not to send (nothing to fix about the send itself).
 * UNDELIVERED = we tried and the mail provider refused — the address or the
 * mailer needs attention, which is the §1k error surface, not the success one.
 */
export type SendReasonCode = "NO_EMAIL" | "ALREADY_COMPLETE" | "NOT_FOUND" | "SEND_FAILED" | "OTHER";

export type SendOutcome = { memberId: string; name: string; reason: SendReasonCode; detail?: string | null };

/** Map sendActivation()'s free-text reason onto a closed code. */
export function classifySendReason(raw: string | null | undefined): SendReasonCode {
  const r = (raw ?? "").toLowerCase();
  if (r.includes("no email")) return "NO_EMAIL";
  if (r.includes("already completed") || r.includes("already complete")) return "ALREADY_COMPLETE";
  if (r.includes("not found")) return "NOT_FOUND";
  if (r.startsWith("email failed")) return "SEND_FAILED";
  return "OTHER";
}

export function isUndelivered(code: SendReasonCode): boolean {
  return code === "SEND_FAILED";
}

/** Plural phrase per reason — "2 have no email on file". */
const REASON_PHRASE: Record<SendReasonCode, [string, string]> = {
  NO_EMAIL: ["has no email on file", "have no email on file"],
  ALREADY_COMPLETE: ["already finished moving over", "already finished moving over"],
  NOT_FOUND: ["is no longer on the roster", "are no longer on the roster"],
  SEND_FAILED: ["couldn't be delivered", "couldn't be delivered"],
  OTHER: ["couldn't be sent", "couldn't be sent"],
};

/** Single-person label, for the expander row. */
export function reasonLabel(code: SendReasonCode): string {
  switch (code) {
    case "NO_EMAIL":
      return "No email on file";
    case "ALREADY_COMPLETE":
      return "Already finished moving over";
    case "NOT_FOUND":
      return "No longer on the roster";
    case "SEND_FAILED":
      return "Mail provider refused the message";
    default:
      return "Couldn't be sent";
  }
}

/**
 * "3 people were skipped: 2 have no email on file, 1 already finished moving
 * over." Largest group first; ties in a fixed order so the sentence is stable.
 * Empty string when nothing was skipped.
 */
export function summarizeSkipped(skipped: ReadonlyArray<{ reason: SendReasonCode }>): string {
  if (skipped.length === 0) return "";
  const order: SendReasonCode[] = ["NO_EMAIL", "ALREADY_COMPLETE", "NOT_FOUND", "SEND_FAILED", "OTHER"];
  const counts = new Map<SendReasonCode, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([code, n]) => `${n} ${REASON_PHRASE[code][n === 1 ? 0 : 1]}`);
  const head = skipped.length === 1 ? "1 person was skipped" : `${skipped.length} people were skipped`;
  return `${head}: ${parts.join(", ")}.`;
}

/** "21 invitations sent" / "1 reminder sent". */
export function sentHeadline(sent: number, reminder: boolean): string {
  const noun = reminder ? "reminder" : "invitation";
  return `${sent} ${noun}${sent === 1 ? "" : "s"} sent`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "No one matches 'jon' with Step 3 · Invited". Every label passed is an
 * active filter already rendered for humans; blanks are dropped.
 */
export function emptySearchSentence(q: string, filterLabels: ReadonlyArray<string | null | undefined>): string {
  const labels = filterLabels.filter((l): l is string => !!l && l.trim().length > 0);
  const query = q.trim();
  const head = query ? `No one matches ‘${query}’` : "No one matches";
  if (labels.length === 0) return query ? head : "No one here yet";
  return `${head} with ${labels.join(" · ")}`;
}

/** Classic two-row Levenshtein. Inputs are short names; no early exit needed. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A close name for a query that found nobody. Compares against each first
 * name, last name and full name (case-insensitive) and returns the closest
 * candidate within `maxDistance`, or null. Queries under 3 characters get no
 * suggestion — everything is within 2 edits of "jo".
 */
export function suggestName(q: string, names: Iterable<string>, maxDistance = 2): string | null {
  const query = q.trim().toLowerCase();
  if (query.length < 3) return null;
  let best: { word: string; d: number } | null = null;
  const seen = new Set<string>();
  for (const full of names) {
    const clean = full.trim().replace(/\s+/g, " ");
    if (!clean) continue;
    const words = [clean, ...clean.split(" ")];
    for (const w of words) {
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (key === query) return null; // it exists — the miss was the filters, not the spelling
      const d = levenshtein(query, key);
      if (d <= maxDistance && (!best || d < best.d || (d === best.d && w.length < best.word.length))) {
        best = { word: w, d };
      }
    }
  }
  return best ? best.word : null;
}

/** What the client accumulates across chunked calls to /api/members/migration/send. */
export type SendResult = {
  reminder: boolean;
  sent: number;
  /** Siblings covered by a guardian's single email. */
  covered: number;
  skipped: SendOutcome[];
  undelivered: SendOutcome[];
};

export function emptySendResult(reminder: boolean): SendResult {
  return { reminder, sent: 0, covered: 0, skipped: [], undelivered: [] };
}

/**
 * Fold one API response into the running result. Tolerates an older server
 * that returns no `skipped` / `undelivered` arrays (counts still add up), and
 * dedupes by member so a person retried across chunks is listed once.
 */
export function accumulateSendResult(
  prev: SendResult,
  d: { sent?: number; membersInvited?: number; skipped?: SendOutcome[]; undelivered?: SendOutcome[] },
): SendResult {
  const merge = (a: SendOutcome[], b: SendOutcome[] | undefined) => {
    if (!b?.length) return a;
    const seen = new Set(a.map((x) => x.memberId));
    return [...a, ...b.filter((x) => !seen.has(x.memberId) && (seen.add(x.memberId), true))];
  };
  return {
    reminder: prev.reminder,
    sent: prev.sent + (d.sent ?? 0),
    covered: prev.covered + (d.membersInvited ?? 0),
    skipped: merge(prev.skipped, d.skipped),
    undelivered: merge(prev.undelivered, d.undelivered),
  };
}
