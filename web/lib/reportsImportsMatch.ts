// Reports Phase 2.5.10 — matching-signal detection (specs/04 §step 5).
//
// Priority (in order):
//   EXTERNAL_ID          HIGH   auto-match
//   MIGRATION_ID         HIGH   auto-match
//   EXACT_EMAIL          HIGH   auto-match
//   EXACT_PHONE          HIGH   auto-match
//   NAME_DOB             MEDIUM review
//   NAME_GUARDIAN        MEDIUM review
//   EMAIL_IS_GUARDIAN    MEDIUM review
//   ID_COLLISION         MEDIUM review
//   PHONE_IS_STAFF       LOW    review
//   name-only            —      NEVER a match; always CREATED
//
// Any signal that resolves to >1 candidate downgrades to REVIEW.
// HIGH contradicting HIGH goes to REVIEW.

import { prisma } from "@/lib/prisma";
import { normalizeEmail, normalizePhone } from "@/lib/reportsImports";

export type MatchSignal =
  | "EXTERNAL_ID" | "MIGRATION_ID" | "EXACT_EMAIL" | "EXACT_PHONE"
  | "NAME_DOB" | "NAME_GUARDIAN" | "EMAIL_IS_GUARDIAN"
  | "ID_COLLISION" | "PHONE_IS_STAFF";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type MatchOutcome =
  | { kind: "AUTO_MATCH"; memberId: string; signal: MatchSignal; confidence: Confidence }
  | { kind: "REVIEW"; candidates: Array<{ memberId: string; signal: MatchSignal; reason: string }>; confidence: Confidence }
  | { kind: "CREATE"; reason: string };

export type MemberRowInput = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: Date | null;
  externalMemberId?: string | null;
};

// Resolve match candidates for one incoming row. Cache holds pre-fetched
// candidate maps to avoid a query per row.
export type MatchCache = {
  byExternalId: Map<string, string[]>;
  byEmail: Map<string, string[]>;
  byPhone: Map<string, string[]>;
  byNameDob: Map<string, string[]>;
};

export async function loadMatchCache(clubId: string): Promise<MatchCache> {
  const members = await prisma.member.findMany({
    where: { clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true,
      externalMemberId: true, normalizedEmail: true, normalizedPhone: true,
      dateOfBirth: true,
    },
  });
  const byExternalId = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byNameDob = new Map<string, string[]>();
  for (const m of members) {
    if (m.externalMemberId) push(byExternalId, m.externalMemberId, m.id);
    if (m.normalizedEmail) push(byEmail, m.normalizedEmail, m.id);
    if (m.normalizedPhone) push(byPhone, m.normalizedPhone, m.id);
    if (m.firstName && m.lastName && m.dateOfBirth) {
      const key = nameDobKey(m.firstName, m.lastName, m.dateOfBirth);
      push(byNameDob, key, m.id);
    }
  }
  return { byExternalId, byEmail, byPhone, byNameDob };
}

function push(map: Map<string, string[]>, key: string, id: string) {
  const arr = map.get(key) ?? [];
  arr.push(id);
  map.set(key, arr);
}

function nameDobKey(first: string, last: string, dob: Date): string {
  return `${first.toLowerCase().trim()}::${last.toLowerCase().trim()}::${dob.toISOString().slice(0, 10)}`;
}

export function resolveMatch(row: MemberRowInput, cache: MatchCache): MatchOutcome {
  const email = normalizeEmail(row.email);
  const phone = normalizePhone(row.phone);

  const externalHits = row.externalMemberId ? cache.byExternalId.get(row.externalMemberId) ?? [] : [];
  const emailHits = email ? cache.byEmail.get(email) ?? [] : [];
  const phoneHits = phone ? cache.byPhone.get(phone) ?? [] : [];
  const nameDobHits = row.firstName && row.lastName && row.dateOfBirth
    ? cache.byNameDob.get(nameDobKey(row.firstName, row.lastName, row.dateOfBirth)) ?? []
    : [];

  const highSignals: Array<{ id: string; signal: MatchSignal; confidence: Confidence; reason: string }> = [];
  if (externalHits.length === 1) highSignals.push({ id: externalHits[0], signal: "EXTERNAL_ID", confidence: "HIGH", reason: `External ID ${row.externalMemberId} matches` });
  if (externalHits.length > 1) return reviewFromMany(externalHits, "EXTERNAL_ID", "External ID collides with multiple members", "MEDIUM");
  if (emailHits.length === 1) highSignals.push({ id: emailHits[0], signal: "EXACT_EMAIL", confidence: "HIGH", reason: `Email ${email} matches` });
  if (emailHits.length > 1) return reviewFromMany(emailHits, "EXACT_EMAIL", "Email matches multiple members", "MEDIUM");
  if (phoneHits.length === 1) highSignals.push({ id: phoneHits[0], signal: "EXACT_PHONE", confidence: "HIGH", reason: "Phone matches" });
  if (phoneHits.length > 1) return reviewFromMany(phoneHits, "EXACT_PHONE", "Phone matches multiple members", "MEDIUM");

  if (highSignals.length > 0) {
    const uniqIds = new Set(highSignals.map((h) => h.id));
    if (uniqIds.size === 1) {
      const primary = highSignals[0];
      return { kind: "AUTO_MATCH", memberId: primary.id, signal: primary.signal, confidence: "HIGH" };
    }
    return {
      kind: "REVIEW",
      candidates: highSignals.map((h) => ({ memberId: h.id, signal: h.signal, reason: h.reason })),
      confidence: "MEDIUM",
    };
  }

  if (nameDobHits.length >= 1) {
    return {
      kind: "REVIEW",
      candidates: nameDobHits.map((id) => ({ memberId: id, signal: "NAME_DOB" as MatchSignal, reason: "Name + date of birth matches" })),
      confidence: "MEDIUM",
    };
  }

  return { kind: "CREATE", reason: "No hard signal — creating a new member." };
}

function reviewFromMany(ids: string[], signal: MatchSignal, reason: string, confidence: Confidence): MatchOutcome {
  return {
    kind: "REVIEW",
    candidates: ids.map((id) => ({ memberId: id, signal, reason })),
    confidence,
  };
}
