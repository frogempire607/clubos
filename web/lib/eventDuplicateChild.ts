// "Is this child already registered for this event?" — the pure decision the
// public registration route (/e/<slug> and the private /e/s-<token>) asks
// before it writes a second row for the same athlete.
//
// PURE — no prisma, no IO, no clock. scripts/event-duplicate-child-tests.ts
// exercises every branch.
//
// ── Who is "the same child" ─────────────────────────────────────────────────
//   1. The same matched member record. Two signups that both resolved to one
//      member are one athlete, whatever was typed.
//   2. Otherwise the same NAME (case- and whitespace-insensitive, the same key
//      lib/registrationLink matches members on) AND
//        · the same birthdate, when the form asks for one and both rows have
//          it — the email is then irrelevant (mum registered, then dad did);
//        · else the same email. An email is a household, not an athlete, so
//          the email ALONE never matches: two siblings on one parent's address
//          are two children and both register.
//   Two rows linked to two DIFFERENT member records are never the same child.
//
// ── Which existing rows count ───────────────────────────────────────────────
// Only a registration that is still live: the ACTIVE_REGISTRATION_STATUSES
// (lib/eventPayments — the one membership test) plus a request still waiting
// on the coach. Never CANCELED, never a declined request, and never
// PENDING_PAYMENT: a card checkout that was not finished holds nothing and
// owes nothing (CHECKOUT_HOLD_MS), and a parent whose checkout failed must be
// able to try again straight away. The public route has no "resume this
// checkout" path, so an in-flight one is allowed through rather than blocked.

import { ACTIVE_REGISTRATION_STATUSES } from "@/lib/eventPayments";
import { nameKey } from "@/lib/registrationLink";
import type { EventFormField } from "@/lib/eventForm";

export const ALREADY_REGISTERED = "ALREADY_REGISTERED";

export type ChildIdentity = {
  memberId: string | null;
  name: string;
  email: string | null;
  /** Normalized by `normalizeBirthdate`, or null when none was collected. */
  birthdate: string | null;
};

export type ExistingChildRegistration = ChildIdentity & {
  id: string;
  status: string;
  approvalStatus?: string | null;
};

/** Does this existing row still stand in the way of a second signup? */
export function registrationIsLive(reg: { status: string; approvalStatus?: string | null }): boolean {
  if (reg.approvalStatus === "DECLINED") return false;
  if ((ACTIVE_REGISTRATION_STATUSES as string[]).includes(reg.status)) return true;
  // A request the coach hasn't answered yet: no spot, but very much a signup.
  return reg.status === "PENDING_REVIEW";
}

const emailKey = (e: string | null | undefined): string => (e ?? "").trim().toLowerCase();

/**
 * A birthdate as one comparable string (YYYY-MM-DD when it can be read as a
 * date). Free text that cannot be read stays as typed, lowercased with the
 * spacing removed — two different spellings then simply don't match, which
 * fails OPEN (the signup goes through) rather than blocking a real child.
 */
export function normalizeBirthdate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (y: number, m: number, d: number): string | null =>
    m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (iso) {
    const out = ymd(+iso[1], +iso[2], +iso[3]);
    if (out) return out;
  }
  const us = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
  if (us) {
    const out = ymd(+us[3], +us[1], +us[2]);
    if (out) return out;
  }
  // "March 5, 2014" and friends. Only when the text names a month — a bare
  // number must not be read as a date.
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(v) && /\b\d{1,2}\b/.test(v) && /\b\d{4}\b/.test(v)) {
    const t = new Date(v);
    if (!Number.isNaN(t.getTime())) return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  return v.toLowerCase().replace(/\s+/g, "");
}

/** Is this signup question the athlete's birthdate? Decided by its label. */
export function isBirthdateField(f: Pick<EventFormField, "label" | "type" | "perEntry">): boolean {
  if (f.perEntry || f.type === "checkbox") return false;
  return /\b(date of birth|birth ?date|birth ?day|d\.?o\.?b\.?)\b/i.test(f.label);
}

/**
 * The birthdate a signup gave, when this event's form asks for one. Reads the
 * same formResponses shape for the new signup and for the rows already stored.
 */
export function birthdateFromForm(fields: readonly EventFormField[], responses: unknown): string | null {
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) return null;
  const field = fields.find(isBirthdateField);
  if (!field) return null;
  return normalizeBirthdate((responses as Record<string, unknown>)[field.id]);
}

/** Are these two signups the same child? See the rules at the top. */
export function sameChild(a: ChildIdentity, b: ChildIdentity): boolean {
  if (a.memberId && b.memberId) return a.memberId === b.memberId;
  const key = nameKey(a.name);
  if (!key || key !== nameKey(b.name)) return false;
  if (a.birthdate && b.birthdate) return a.birthdate === b.birthdate;
  const email = emailKey(a.email);
  return !!email && email === emailKey(b.email);
}

/** "  eli   FASULO " → "Eli" is not attempted — the name is shown as typed. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

export function alreadyRegisteredMessage(name: string): string {
  const first = firstNameOf(name);
  return `${first || "This athlete"} is already registered for this event.`;
}

export type DuplicateChildDecision =
  | { duplicate: false }
  | { duplicate: true; code: typeof ALREADY_REGISTERED; registrationId: string | null; message: string };

/**
 * The decision. `existing` = this event's other registrations (any status —
 * liveness is decided here, not by the caller's query). `memberHasBooking` =
 * the matched member already holds a non-canceled Booking on this event (a
 * member registered from the app, or added by staff, may have no
 * registration row at all).
 */
export function findDuplicateChild(args: {
  candidate: ChildIdentity;
  existing: readonly ExistingChildRegistration[];
  memberHasBooking?: boolean;
}): DuplicateChildDecision {
  const hit = args.existing.find((r) => registrationIsLive(r) && sameChild(args.candidate, r));
  if (hit) {
    return { duplicate: true, code: ALREADY_REGISTERED, registrationId: hit.id, message: alreadyRegisteredMessage(args.candidate.name) };
  }
  if (args.candidate.memberId && args.memberHasBooking) {
    return { duplicate: true, code: ALREADY_REGISTERED, registrationId: null, message: alreadyRegisteredMessage(args.candidate.name) };
  }
  return { duplicate: false };
}
