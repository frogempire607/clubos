import crypto from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { TERMS_VERSION, PRIVACY_VERSION, PARENTAL_CONSENT_VERSION } from "@/legal/versions";

export { PARENTAL_CONSENT_VERSION } from "@/legal/versions";

// Works for both the base client and a `prisma.$transaction` client.
type Db = PrismaClient | Prisma.TransactionClient;

export type ConsentSource =
  | "SIGNUP"
  | "ACTIVATION"
  | "LINK_CHILD"
  | "PARENT_CREATE"
  | "GUARDIAN_APPROVAL"
  | "PORTAL_GATE"
  | "OWNER_INVITE"
  | "PARENT_INVITE";

// Error code returned by member-portal APIs when a guardian tries to touch a
// minor's data without a current parental consent on file. The client uses
// this to render the blocking consent screen.
export const CONSENT_REQUIRED_CODE = "PARENTAL_CONSENT_REQUIRED";

// Master switch for COPPA ENFORCEMENT (the blocking behavior: minor login
// block + guardian portal gate). Off by default so this can ship dark and be
// enabled per-environment once the consent UI + flows are verified. Recording
// a consent is always allowed; only the gates are flag-guarded, so turning the
// flag off can never lock anyone out. Mirrors the FEATURE_INVOICE_SPLIT pattern.
export function parentalConsentEnforced(): boolean {
  const v = process.env.FEATURE_PARENTAL_CONSENT;
  return v === "1" || v === "true";
}

// ---------------------------------------------------------------------------
// Age / minor resolution — DOB is authoritative when present, so an owner or
// guardian cannot mark a 10-year-old as an adult to dodge the consent gate.
// ---------------------------------------------------------------------------

export function ageFromDOB(dob: Date | string | null | undefined): number | null {
  if (!dob) return null;
  const d = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

// Authoritative minor test. If a DOB is on file it wins (<18 = minor);
// otherwise fall back to the stored isMinor flag.
export function resolveIsMinor(m: {
  isMinor?: boolean | null;
  dateOfBirth?: Date | string | null;
}): boolean {
  const age = ageFromDOB(m.dateOfBirth ?? null);
  if (age !== null) return age < 18;
  return !!m.isMinor;
}

// ---------------------------------------------------------------------------
// Consent statement — rendered verbatim and stored on every consent row so the
// audit trail preserves exactly what the guardian agreed to.
// ---------------------------------------------------------------------------

export function buildParentalConsentText(opts: { childName?: string | null; clubName?: string | null }): string {
  const child = (opts.childName || "").trim() || "my child";
  const club = (opts.clubName || "").trim() || "the club";
  return (
    `I am the parent or legal guardian of ${child}. I am at least 18 years old and have the ` +
    `authority to consent on their behalf. I give my consent for ${club} and AthletixOS to ` +
    `collect, store, and use ${child}'s personal information (including name, date of birth, ` +
    `contact details, guardian details, and activity/attendance records) to provide club ` +
    `services, as described in the Terms of Service and Privacy Policy. I understand this ` +
    `consent is recorded with a timestamp, that I can request the information be reviewed or ` +
    `deleted, and that I may withdraw consent by contacting ${club}.`
  );
}

// ---------------------------------------------------------------------------
// Recording consent — APPEND-ONLY. This is the ONLY writer of parental_consents.
// It never updates or deletes; a fresh consent (e.g. after a version bump) is a
// new row. The database also enforces immutability with a trigger.
// ---------------------------------------------------------------------------

export interface RecordConsentInput {
  clubId: string;
  memberId: string; // the child (minor)
  childUserId?: string | null; // the minor's own login, if any
  guardianUserId?: string | null; // the consenting guardian's account, if any
  guardianName: string;
  guardianEmail: string;
  relationship?: string | null;
  clubName?: string | null; // used to render the stored consentText
  childName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  source: ConsentSource;
  // Optional overrides — default to the current live versions.
  termsVersion?: string;
  privacyVersion?: string;
  consentVersion?: string;
  consentText?: string;
}

export async function recordParentalConsent(db: Db, input: RecordConsentInput) {
  const consentText =
    input.consentText ??
    buildParentalConsentText({ childName: input.childName, clubName: input.clubName });
  return db.parentalConsent.create({
    data: {
      clubId: input.clubId,
      memberId: input.memberId,
      childUserId: input.childUserId ?? null,
      guardianUserId: input.guardianUserId ?? null,
      guardianName: input.guardianName,
      guardianEmail: input.guardianEmail.toLowerCase(),
      relationship: input.relationship ?? null,
      termsVersion: input.termsVersion ?? TERMS_VERSION,
      privacyVersion: input.privacyVersion ?? PRIVACY_VERSION,
      consentVersion: input.consentVersion ?? PARENTAL_CONSENT_VERSION,
      consentText,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      source: input.source,
    },
  });
}

// ---------------------------------------------------------------------------
// Currency checks — a consent is "current" only when it matches ALL live
// versions. Any Terms / Privacy / consent-statement bump makes it stale and
// re-prompts. Returning guardians are otherwise never asked again.
// ---------------------------------------------------------------------------

const CURRENT_VERSION_WHERE = {
  termsVersion: TERMS_VERSION,
  privacyVersion: PRIVACY_VERSION,
  consentVersion: PARENTAL_CONSENT_VERSION,
};

// True if a version tuple matches the live versions. Exported for tests.
export function consentIsCurrent(c: {
  termsVersion: string;
  privacyVersion: string;
  consentVersion: string;
}): boolean {
  return (
    c.termsVersion === TERMS_VERSION &&
    c.privacyVersion === PRIVACY_VERSION &&
    c.consentVersion === PARENTAL_CONSENT_VERSION
  );
}

// Does this child have ANY current parental consent (from any guardian)? This
// is the CHILD-ACCOUNT gate — true means the minor's own login may be used and
// their data may be surfaced.
export async function childHasCurrentConsent(memberId: string, db: Db = prisma): Promise<boolean> {
  const row = await db.parentalConsent.findFirst({
    where: { memberId, ...CURRENT_VERSION_WHERE },
    select: { id: true },
  });
  return !!row;
}

// Does THIS guardian have a current consent for THIS child? This is the
// GUARDIAN-PORTAL gate — each guardian attests for each minor they manage.
export async function guardianHasCurrentConsentForChild(
  guardianUserId: string,
  memberId: string,
  db: Db = prisma,
): Promise<boolean> {
  const row = await db.parentalConsent.findFirst({
    where: { memberId, guardianUserId, ...CURRENT_VERSION_WHERE },
    select: { id: true },
  });
  return !!row;
}

// Guard for member-portal routes. Should this actor be blocked from touching
// this child's data right now? True only when enforcement is ON, the target is
// a minor, the actor is NOT the child themselves (their own login is already
// gated at sign-in), and no CURRENT consent by this actor/guardian exists.
//
// Self-sufficient: it re-reads the member's minor status + own-login from the
// DB by id, so a caller that didn't `select` isMinor/dateOfBirth can't
// accidentally open a hole. Costs one indexed lookup, and only when enforcement
// is ON (returns immediately otherwise).
export async function guardianActionBlocked(
  actorUserId: string,
  memberId: string,
  db: Db = prisma,
): Promise<boolean> {
  if (!parentalConsentEnforced()) return false;
  const m = await db.member.findUnique({
    where: { id: memberId },
    select: { id: true, userId: true, isMinor: true, dateOfBirth: true },
  });
  if (!m) return false;
  if (!resolveIsMinor(m)) return false;
  if (m.userId && m.userId === actorUserId) return false; // the minor's own session
  return !(await guardianHasCurrentConsentForChild(actorUserId, m.id, db));
}

// Standard 403 body a route returns when guardianActionBlocked is true. The
// member client keys on `code` to show the blocking consent screen.
export const CONSENT_BLOCK_BODY = {
  error: "A parent or guardian must complete consent for this child before continuing.",
  code: CONSENT_REQUIRED_CODE,
};

export interface UnconsentedChild {
  memberId: string;
  firstName: string;
  lastName: string;
  clubId: string;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianRelationship: string | null;
}

// Minor children this guardian manages that still need a (current) consent from
// this guardian. Drives the portal consent gate + pending list. Owners/staff
// never call this — the gate is member-portal-only, so club operations are
// never blocked.
export async function listChildrenNeedingConsent(
  guardianUserId: string,
  db: Db = prisma,
): Promise<UnconsentedChild[]> {
  const links = await db.memberGuardianUser.findMany({
    where: { userId: guardianUserId },
    select: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          clubId: true,
          isMinor: true,
          dateOfBirth: true,
          deletedAt: true,
          guardianName: true,
          guardianEmail: true,
          guardianRelationship: true,
        },
      },
    },
  });

  const out: UnconsentedChild[] = [];
  for (const link of links) {
    const m = link.member;
    if (!m || m.deletedAt) continue;
    if (!resolveIsMinor(m)) continue;
    const ok = await guardianHasCurrentConsentForChild(guardianUserId, m.id, db);
    if (ok) continue;
    out.push({
      memberId: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      clubId: m.clubId,
      guardianName: m.guardianName,
      guardianEmail: m.guardianEmail,
      guardianRelationship: m.guardianRelationship,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emailed consent-link tokens (guardian_consent_requests). Mutable operational
// record; fulfilling it writes an immutable ParentalConsent and consumes it.
// ---------------------------------------------------------------------------

const CONSENT_TOKEN_TTL_DAYS = 30;

export async function createGuardianConsentRequest(
  db: Db,
  input: {
    clubId: string;
    memberId: string;
    guardianName?: string | null;
    guardianEmail: string;
    relationship?: string | null;
    source: "SIGNUP" | "OWNER_INVITE" | "PARENT_INVITE";
    createdByUserId?: string | null;
    ttlDays?: number;
  },
) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = input.ttlDays ?? CONSENT_TOKEN_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttl * 24 * 60 * 60 * 1000);
  return db.guardianConsentRequest.create({
    data: {
      clubId: input.clubId,
      memberId: input.memberId,
      guardianName: input.guardianName ?? null,
      guardianEmail: input.guardianEmail.toLowerCase(),
      relationship: input.relationship ?? null,
      token,
      source: input.source,
      createdByUserId: input.createdByUserId ?? null,
      expiresAt,
    },
  });
}

export type ConsentTokenStatus = "valid" | "expired" | "used" | "invalid";

export async function resolveGuardianConsentToken(token: string, db: Db = prisma) {
  const request = await db.guardianConsentRequest.findUnique({
    where: { token },
    include: {
      member: {
        select: { id: true, firstName: true, lastName: true, clubId: true, isMinor: true, dateOfBirth: true, userId: true, deletedAt: true },
      },
      club: { select: { id: true, name: true, slug: true } },
    },
  });
  let status: ConsentTokenStatus = "valid";
  if (!request || request.member?.deletedAt) status = "invalid";
  else if (request.consumedAt) status = "used";
  else if (request.expiresAt.getTime() < Date.now()) status = "expired";
  return { status, request };
}
