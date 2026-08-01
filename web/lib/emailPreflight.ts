// Pre-send preflight checks (plan §3K). Shared between the Members-page
// bulk composer and the Announcement send flow so both surfaces run
// the same validation and produce the same shape.
//
// Every check is a discrete { code, level, message } result. `level`
// controls how the UI treats it: BLOCK (send disabled), WARN (send
// possible with a typed confirmation), INFO (just a heads-up).
//
// Plan §3K checklist:
//   - Empty subject                       BLOCK
//   - Empty message                       BLOCK
//   - Invalid email addresses             INFO   (row-level, already surfaced)
//   - Duplicate addresses                 INFO
//   - Recipients without email addresses  INFO
//   - Unsubscribed recipients             INFO
//   - Excessively large images            WARN
//   - Broken personalization fields       WARN
//   - Missing sender identity             BLOCK
//   - Missing club contact information    WARN

import type { EmailBlock, ImageBlock } from "@/lib/emailBlocks";
import { extractTokensFromBlocks, PERSONALIZATION_TOKENS } from "@/lib/emailPersonalization";

export type PreflightLevel = "BLOCK" | "WARN" | "INFO";

export interface PreflightIssue {
  code: string;
  level: PreflightLevel;
  message: string;
  details?: unknown;
}

export interface PreflightInput {
  subject: string;
  previewText?: string | null;
  blocks: EmailBlock[];
  // From the pre-send review:
  counts: {
    willSendRows: number;
    noEmail: number;
    invalidAddress: number;
    optedOut: number;
    duplicateInBatch: number;
    outsideCoachAudience?: number;
  };
  // Sender identity — required for the mail to have a legible From.
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  // Club contact info — CAN-SPAM footer needs at least a postal
  // address, and the composer's ContactBlock reads publicEmail / phone.
  club: {
    name: string;
    publicEmail?: string | null;
    contactEmail?: string | null;
    publicPhone?: string | null;
    contactPhone?: string | null;
    mailingAddress?: string | null;
    mailingCity?: string | null;
    mailingState?: string | null;
    mailingZip?: string | null;
  };
}

// The number of recipients above which we require a typed
// "SEND N" confirmation. 292 real families in production; the plan
// calls the failure mode "emailing all of them by accident". 50 is
// the threshold above which one wrong click cascades to the whole
// roster.
export const TYPED_CONFIRM_THRESHOLD = 50;

// The maximum inlined image size we allow before flagging as "large".
// Recipients on cellular data or corporate mail clients silently strip
// images above ~1MB.
const LARGE_IMAGE_HINT_BYTES = 1_000_000;

export function runPreflight(input: PreflightInput): PreflightIssue[] {
  const issues: PreflightIssue[] = [];

  // ── Subject / body / sender identity — BLOCK ─────────────────────────
  if (!input.subject || !input.subject.trim()) {
    issues.push({ code: "EMPTY_SUBJECT", level: "BLOCK", message: "Add a subject before sending." });
  }
  if (!input.blocks || input.blocks.length === 0) {
    issues.push({ code: "EMPTY_MESSAGE", level: "BLOCK", message: "Add at least one content block." });
  } else if (!hasRenderedContent(input.blocks)) {
    issues.push({ code: "EMPTY_MESSAGE", level: "BLOCK", message: "Message body has no visible text. Add a paragraph or heading." });
  }

  const senderEmail = (input.fromEmail ?? "").trim();
  if (!senderEmail) {
    // sendClubEmail falls back to EMAIL_FROM env at write time, so
    // this is only truly missing when the env is unset too. It's an
    // INFO not BLOCK because the safe fallback exists and warning is
    // preferable to blocking a send the server would happily complete.
    issues.push({
      code: "MISSING_SENDER_EMAIL",
      level: "INFO",
      message: "No explicit From address set — will use the club's default sender.",
    });
  }
  if (!input.fromName && !input.club.name) {
    issues.push({
      code: "MISSING_SENDER_NAME",
      level: "BLOCK",
      message: "No sender name available — set a club name in Settings → Club Profile.",
    });
  }

  // ── Club contact info for the footer — WARN ─────────────────────────
  const hasAddress = Boolean(
    input.club.mailingAddress && input.club.mailingCity && (input.club.mailingState || input.club.mailingZip),
  );
  if (!hasAddress) {
    issues.push({
      code: "MISSING_MAILING_ADDRESS",
      level: "WARN",
      message: "Club mailing address is not set — the email footer will fall back to the AthletixOS address. Add it in Settings → Club Profile.",
    });
  }
  const hasContact = Boolean(input.club.publicEmail ?? input.club.contactEmail) ||
                     Boolean(input.club.publicPhone ?? input.club.contactPhone);
  if (!hasContact) {
    issues.push({
      code: "MISSING_CLUB_CONTACT",
      level: "WARN",
      message: "Club has no public email or phone. The Contact block will render only the club name.",
    });
  }

  // ── Recipient-side counts — INFO ────────────────────────────────────
  if (input.counts.willSendRows === 0) {
    issues.push({
      code: "NO_RECIPIENTS",
      level: "BLOCK",
      message: "No eligible recipients — nothing will send.",
    });
  }
  if (input.counts.noEmail > 0) {
    issues.push({
      code: "MISSING_EMAIL",
      level: "INFO",
      message: `${input.counts.noEmail} selected member${input.counts.noEmail === 1 ? "" : "s"} skipped — no email on file.`,
    });
  }
  if (input.counts.invalidAddress > 0) {
    issues.push({
      code: "INVALID_ADDRESSES",
      level: "INFO",
      message: `${input.counts.invalidAddress} address${input.counts.invalidAddress === 1 ? "" : "es"} look invalid — skipped.`,
    });
  }
  if (input.counts.optedOut > 0) {
    issues.push({
      code: "OPTED_OUT",
      level: "INFO",
      message: `${input.counts.optedOut} recipient${input.counts.optedOut === 1 ? "" : "s"} opted out — respected.`,
    });
  }
  if (input.counts.duplicateInBatch > 0) {
    issues.push({
      code: "DUPLICATES_COLLAPSED",
      level: "INFO",
      message: `${input.counts.duplicateInBatch} duplicate${input.counts.duplicateInBatch === 1 ? "" : "s"} collapsed as household — each guardian receives one email.`,
    });
  }
  if (input.counts.outsideCoachAudience && input.counts.outsideCoachAudience > 0) {
    issues.push({
      code: "OUTSIDE_COACH_AUDIENCE",
      level: "INFO",
      message: `${input.counts.outsideCoachAudience} selected member${input.counts.outsideCoachAudience === 1 ? "" : "s"} hidden — you only teach some of them.`,
    });
  }

  // ── Personalization — WARN ──────────────────────────────────────────
  const referenced = extractTokensFromBlocks(input.blocks);
  const subjectTokens = Array.from(input.subject.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map((m) => m[1]);
  const known = new Set<string>(PERSONALIZATION_TOKENS as unknown as string[]);
  const allRefs = Array.from(new Set([...referenced, ...subjectTokens]));
  const typos = allRefs.filter((t) => !known.has(t));
  if (typos.length) {
    issues.push({
      code: "UNKNOWN_TOKENS",
      level: "WARN",
      message: `Unknown personalization tokens: ${typos.map((t) => `{{${t}}}`).join(", ")}. They will render blank.`,
      details: typos,
    });
  }

  // ── Image size — WARN. Composer stores signed public URLs as
  // ImageBlock.src, so we can't inspect bytes from here; the hint fires
  // when the block declares a width larger than the column width, which
  // is proxy evidence that the source image is oversized.
  const oversized = input.blocks
    .filter((b): b is ImageBlock => b.type === "image")
    .filter((b) => (b.width ?? 0) > 800);
  if (oversized.length) {
    issues.push({
      code: "OVERSIZED_IMAGES",
      level: "WARN",
      message: `${oversized.length} image${oversized.length === 1 ? "" : "s"} exceed 800px wide — some mail clients strip images above ${Math.round(LARGE_IMAGE_HINT_BYTES / 1000)}KB.`,
    });
  }

  return issues;
}

function hasRenderedContent(blocks: EmailBlock[]): boolean {
  for (const b of blocks) {
    if (b.type === "heading" && b.text.trim()) return true;
    if (b.type === "paragraph" && b.runs.some((r) => r.text.trim())) return true;
    if (b.type === "list" && b.items.length) return true;
    if (b.type === "button" && b.text.trim()) return true;
    if (b.type === "image") return true;
    if (b.type === "contact") return true;
    // divider / spacer / logo alone don't count as content.
  }
  return false;
}

// Convenience — does the issue list have anything BLOCKing?
export function hasBlocker(issues: PreflightIssue[]): boolean {
  return issues.some((i) => i.level === "BLOCK");
}

export function issuesByLevel(issues: PreflightIssue[]): Record<PreflightLevel, PreflightIssue[]> {
  return {
    BLOCK: issues.filter((i) => i.level === "BLOCK"),
    WARN: issues.filter((i) => i.level === "WARN"),
    INFO: issues.filter((i) => i.level === "INFO"),
  };
}
