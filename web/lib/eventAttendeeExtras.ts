// The three Attendees-screen extras from the design handoff §3 header actions
// (Export / Check-in mode) and the per-row sent-link history — as PURE rules.
//
// PURE. No prisma, no Date.now(), no DOM. Every number here is read off the
// ONE ledger (lib/eventAttendees.buildAttendeeLedger) plus the small per-row
// facts the loader attaches (lib/eventAttendeesServer.loadEventAttendees):
// nothing below recomputes money. Exercised in
// scripts/event-attendees-extras-tests.ts.

import { rowHoldsSpot, type AttendeeFilter, type AttendeeRow } from "@/lib/eventAttendees";
import { visibleRows } from "@/lib/eventAttendeeActions";
import { checkinPaymentBlock } from "@/lib/eventPayments";
import type { AttendeeLedger } from "@/lib/eventAttendees";

// ── Per-row facts the loader attaches (not money — the money is the ledger) ──

/** Settlement + link facts off the EventRegistration row, keyed by registration id. */
export type RowExtras = {
  paymentMethod: string | null;
  paidVia: string | null;
  /** How many payment links bill-registrants has emailed (EventRegistration.invoiceCount). */
  invoiceCount: number;
  /** When the last one went (EventRegistration.invoicedAt), ISO. */
  invoicedAt: string | null;
  /** The live Stripe Checkout link from the last send, if any. */
  paymentUrl: string | null;
};

/** An AttendanceRecord already on this event. */
export type CheckInRecord = {
  recordId: string;
  memberId: string;
  status: string;
  checkedInAt: string | null;
};

/** One EmailSend row about a registration. */
export type SendEntry = {
  id: string;
  subject: string;
  status: string;
  recipientEmail: string;
  /** sentAt ?? queuedAt, ISO. */
  at: string;
  deliveredAt: string | null;
  bouncedAt: string | null;
  note: string | null;
};

type DateFmt = (iso: string) => string;
const defaultFmt: DateFmt = (iso) => iso.slice(0, 10);

// ── Status text — the pill's words, shared by the screen and the export ─────

export function attendeeStatusText(r: AttendeeRow, fmt: DateFmt = defaultFmt): string {
  if (r.status === "SCHEDULED") return r.scheduledAt ? `Card charge ${fmt(r.scheduledAt)}` : r.label;
  if (r.waitingOn === "PARENT" && !r.removed) return "Waiting on the parent";
  return r.label;
}

const PAID_VIA: Record<string, string> = { STRIPE: "Card", CASH: "Cash", CHECK: "Check" };
const METHOD: Record<string, string> = {
  CARD: "Card",
  AUTO_CARD: "Saved card",
  SAVED_CARD: "Saved card",
  CASH: "Cash",
  CHECK: "Check",
  INVOICE: "Payment link",
  PAY_LATER: "Pay later",
};

/** How they paid (settled) or chose to pay (not yet). Blank when unknown. */
export function paymentMethodText(x: Pick<RowExtras, "paidVia" | "paymentMethod"> | null | undefined): string {
  if (!x) return "";
  if (x.paidVia) return PAID_VIA[x.paidVia] ?? x.paidVia;
  if (x.paymentMethod) return METHOD[x.paymentMethod] ?? x.paymentMethod;
  return "";
}

// ── Export ──────────────────────────────────────────────────────────────────

export const EXPORT_FILTERS: AttendeeFilter[] = ["all", "owes", "waiting", "scheduled", "settled"];

export function parseExportFilter(v: string | null | undefined): AttendeeFilter {
  return (EXPORT_FILTERS as string[]).includes(v ?? "") ? (v as AttendeeFilter) : "all";
}

export type ExportCell = string | number;
export type ExportTable = { headers: string[]; rows: ExportCell[][] };

/**
 * The Attendees list as a table — the SAME rows the screen shows for this
 * filter (visibleRows over the one ledger), in the screen's column order.
 * Money is the ledger's: Owes = recorded balance, Paid = recorded paid.
 */
export function attendeeExportTable(
  ledger: AttendeeLedger,
  opts: {
    filter: AttendeeFilter;
    showRemoved: boolean;
    categoryLabel: string | null;
    extras: Record<string, RowExtras>;
  },
): ExportTable {
  const headers = [
    "Name",
    "Source",
    "Email",
    "Phone",
    opts.categoryLabel || "Category",
    "Attending",
    "Owes",
    "Status",
    "Paid",
    "Payment method",
    "Last link sent",
    "Times sent",
  ];
  const rows = visibleRows(ledger, opts.filter, opts.showRemoved).map((r): ExportCell[] => {
    const x = r.registrationId ? opts.extras[r.registrationId] : undefined;
    return [
      r.name,
      r.source === "MEMBER" ? "Member" : "Public",
      r.email ?? "",
      r.phone ?? "",
      r.categoryValue ?? "",
      r.attending,
      r.owes > 0 ? r.owes.toFixed(2) : "",
      attendeeStatusText(r) + (r.removed ? " (removed)" : ""),
      r.paid > 0 ? r.paid.toFixed(2) : "",
      paymentMethodText(x),
      x?.invoicedAt ? x.invoicedAt.slice(0, 10) : "",
      x ? x.invoiceCount : "",
    ];
  });
  return { headers, rows };
}

/**
 * Spreadsheet-safe text cell. A cell that begins with = + - @ (or a tab / CR,
 * which some spreadsheets strip before parsing) is read as a FORMULA by
 * Excel/Sheets/Numbers — a public registrant can type `=HYPERLINK(...)` as
 * their name. Prefixing an apostrophe makes it literal text (OWASP CSV
 * injection guidance). Numbers are emitted as numbers and never prefixed.
 */
export function neutralizeFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** RFC 4180 quoting: wrap when the cell holds a comma, quote or newline; double inner quotes. */
export function csvCell(v: ExportCell | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tableToCsv(t: ExportTable): string {
  // BOM so Excel opens UTF-8 names (accents) correctly.
  return "﻿" + [t.headers, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ── Check-in mode ───────────────────────────────────────────────────────────

/** Statuses that mean "they're here". ABSENT is a record, not an arrival. */
const HERE = new Set(["PRESENT", "LATE", "TRIAL", "DROP_IN"]);

export type CheckInState =
  /** Checked in. `record` is the AttendanceRecord to undo. */
  | { kind: "in"; record: CheckInRecord }
  /** Can be checked in now. */
  | { kind: "ready" }
  /** The event requires payment first and they owe. */
  | { kind: "blocked"; reason: string; canRecordCash: boolean }
  /** Public registrant with no member record — AttendanceRecord.memberId is required. */
  | { kind: "noMember"; reason: string };

export const NO_MEMBER_REASON = "No member record — add them as a member to check in.";

export type CheckInRow = { row: AttendeeRow; state: CheckInState };

/**
 * One row's door state. `cashRecordable` is passed in (lib/eventAttendeeActions)
 * so the "Record cash" shortcut offers exactly what the list's own action does.
 */
export function checkInState(
  r: AttendeeRow,
  opts: {
    requirePaymentBeforeCheckin: boolean;
    record: CheckInRecord | null;
    cashRecordable: (r: AttendeeRow) => boolean;
  },
): CheckInState {
  if (!r.memberId) return { kind: "noMember", reason: NO_MEMBER_REASON };
  if (opts.record && HERE.has(opts.record.status)) return { kind: "in", record: opts.record };
  // The one gate — the same function the member self check-in route uses, so
  // the door and the member's phone refuse the same people for the same reason.
  const block = r.registrationId
    ? checkinPaymentBlock(
        { requirePaymentBeforeCheckin: opts.requirePaymentBeforeCheckin },
        { status: r.status, amountDue: r.amountDue },
      )
    : null;
  if (block) return { kind: "blocked", reason: block, canRecordCash: opts.cashRecordable(r) };
  return { kind: "ready" };
}

/** Everyone expected at the door: not removed, holding a spot (no waitlist). Alphabetical. */
export function checkInRows(
  rows: AttendeeRow[],
  checkIns: CheckInRecord[],
  opts: { requirePaymentBeforeCheckin: boolean; cashRecordable: (r: AttendeeRow) => boolean },
): CheckInRow[] {
  const byMember = new Map<string, CheckInRecord>();
  for (const c of checkIns) {
    const prev = byMember.get(c.memberId);
    // A duplicate record for one person: an arrival beats a non-arrival.
    if (!prev || (!HERE.has(prev.status) && HERE.has(c.status))) byMember.set(c.memberId, c);
  }
  return rows
    .filter((r) => !r.removed && rowHoldsSpot(r))
    .map((row) => ({
      row,
      state: checkInState(row, {
        ...opts,
        record: row.memberId ? byMember.get(row.memberId) ?? null : null,
      }),
    }))
    .sort((a, b) => a.row.name.localeCompare(b.row.name));
}

export type CheckInCounts = { checkedIn: number; expected: number; notYet: number; noMember: number; blocked: number; label: string };

export function checkInCounts(list: CheckInRow[]): CheckInCounts {
  const checkedIn = list.filter((x) => x.state.kind === "in").length;
  const noMember = list.filter((x) => x.state.kind === "noMember").length;
  const blocked = list.filter((x) => x.state.kind === "blocked").length;
  return {
    checkedIn,
    expected: list.length,
    notYet: list.length - checkedIn,
    noMember,
    blocked,
    label: `${checkedIn} of ${list.length} checked in`,
  };
}

/** Search box + "Not yet here". Matches name, email, phone and the category value. */
export function filterCheckIn(list: CheckInRow[], query: string, notYetOnly: boolean): CheckInRow[] {
  const q = query.trim().toLowerCase();
  return list.filter((x) => {
    if (notYetOnly && x.state.kind === "in") return false;
    if (!q) return true;
    const r = x.row;
    return [r.name, r.email, r.phone, r.categoryValue].some((v) => (v ?? "").toLowerCase().includes(q));
  });
}

// ── Sent-link history ───────────────────────────────────────────────────────

/** "Link sent 3× · last Sep 20" / "Link sent once · Sep 20" / null when never sent. */
export function linkSentSummary(x: Pick<RowExtras, "invoiceCount" | "invoicedAt"> | null | undefined, fmt: DateFmt = defaultFmt): string | null {
  if (!x || x.invoiceCount <= 0) return null;
  const when = x.invoicedAt ? fmt(x.invoicedAt) : null;
  if (x.invoiceCount === 1) return when ? `Link sent · ${when}` : "Link sent";
  return when ? `Link sent ${x.invoiceCount}× · last ${when}` : `Link sent ${x.invoiceCount}×`;
}

/** Plain words for an EmailSend lifecycle status. */
export function sendStatusText(s: Pick<SendEntry, "status" | "note">): { label: string; tone: "ok" | "bad" | "muted" } {
  switch (s.status) {
    case "DELIVERED":
      return { label: "Delivered", tone: "ok" };
    case "SENT":
      return { label: "Sent", tone: "ok" };
    case "BOUNCED":
      return { label: "Bounced", tone: "bad" };
    case "COMPLAINED":
      return { label: "Marked as spam", tone: "bad" };
    case "FAILED":
      return { label: "Failed", tone: "bad" };
    case "SKIPPED":
      return { label: s.note ? `Not sent (${s.note})` : "Not sent", tone: "muted" };
    case "QUEUED":
      return { label: "Queued", tone: "muted" };
    default:
      return { label: s.status, tone: "muted" };
  }
}

/**
 * Which registration an event email belongs to. The lifecycle emails
 * (lib/eventLifecycleEmails.ledgerKeys) key every send `event-<kind>:<regId>`
 * or `event-<kind>:<regId>:<stamp>`; that id is the only reliable link — a
 * family email address is shared by siblings.
 */
export function sendRegistrationId(dedupeKey: string | null | undefined, regIds: Set<string>): string | null {
  if (!dedupeKey) return null;
  const parts = dedupeKey.split(":");
  if (parts.length < 2) return null;
  return regIds.has(parts[1]) ? parts[1] : null;
}
