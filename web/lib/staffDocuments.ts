// Phase 12.1 Part 4 — staff documents and e-signatures, PURE rules.
//
// No prisma, no next, no clock beyond what is passed in, so
// scripts/staff-documents-tests.ts can prove the rules without a database.
//
// ── WHAT IS REUSED, AND WHAT IS NEW ─────────────────────────────────────────
// The DOCUMENT is the existing `Document` model: same title, same sanitised
// rich-text body, same editor, same renderer. The SIGNING is the existing
// mechanic: a typed name or a drawn PNG from the same SignaturePad component,
// recorded with who, when, and the IP and user agent.
//
// What is new is the LINK — who owes a signature, and who gave one. The
// existing `DocumentSignature.memberId` is a REQUIRED foreign key to Member
// with a unique on (documentId, memberId), and staff are Users with a
// StaffProfile; they have no Member row. Making that column nullable would
// turn it into `string | null` across twenty files, among them member
// onboarding, migration activation, event-document gating and member deletion
// — the paths this repo's guardrails single out. So the link table is
// staff-specific and nothing else is.
//
// ── VERSIONS ────────────────────────────────────────────────────────────────
// A staff document carries a version. A signature records the version it was
// given against, so "needs signing" is "no signature at the current version".
// Publishing a new version therefore asks everyone again, and every earlier
// signature is kept exactly as it was — which is the point of keeping them.

export const ASSIGNMENT_SCOPES = ["ALL", "ROLE", "STAFF"] as const;
export type AssignmentScope = (typeof ASSIGNMENT_SCOPES)[number];

export function isAssignmentScope(v: string | null | undefined): v is AssignmentScope {
  return v === "ALL" || v === "ROLE" || v === "STAFF";
}

export type Assignment = {
  id: string;
  scope: AssignmentScope;
  staffUserId: string | null;
  role: string | null;
  /// Date-only `YYYY-MM-DD`, or null.
  dueDate: string | null;
};

export type StaffPerson = {
  userId: string;
  name: string;
  email: string | null;
  /// StaffProfile.title — what a ROLE assignment matches on.
  title: string | null;
};

export type SignatureRow = {
  staffUserId: string;
  documentVersion: number;
  signedAt: string;
  signerName: string;
};

/// Who a document is assigned to, as a set of staff user ids.
///
/// The union of its assignments: a document assigned to everyone AND to one
/// person is assigned to everyone, and listing the same person twice is not an
/// error — it is just the same answer.
export function assignedStaffIds(assignments: Assignment[], staff: StaffPerson[]): Set<string> {
  const out = new Set<string>();
  for (const a of assignments) {
    if (a.scope === "ALL") {
      for (const s of staff) out.add(s.userId);
    } else if (a.scope === "ROLE" && a.role) {
      // Matched case-insensitively and trimmed: a club that typed "Coach" in
      // one place and "coach " in another means the same role, and a document
      // nobody gets because of a stray capital is worse than a loose match.
      const want = a.role.trim().toLowerCase();
      for (const s of staff) if ((s.title ?? "").trim().toLowerCase() === want) out.add(s.userId);
    } else if (a.scope === "STAFF" && a.staffUserId) {
      // Only if they are actually staff of this club — an assignment left
      // behind by a departed colleague must not resurrect them into the list.
      if (staff.some((s) => s.userId === a.staffUserId)) out.add(a.staffUserId);
    }
  }
  return out;
}

/// The soonest due date that applies to one person, or null.
export function dueDateFor(
  assignments: Assignment[],
  staff: StaffPerson[],
  staffUserId: string,
): string | null {
  let soonest: string | null = null;
  for (const a of assignments) {
    if (!a.dueDate) continue;
    const applies = assignedStaffIds([a], staff).has(staffUserId);
    if (!applies) continue;
    if (soonest === null || a.dueDate < soonest) soonest = a.dueDate;
  }
  return soonest;
}

export type SignStatus = "SIGNED" | "OUTSTANDING" | "SUPERSEDED";

/// One person's position on one document.
///
///   SIGNED      — signed at the CURRENT version.
///   SUPERSEDED  — signed an earlier version; a new one is owed. The old
///                 signature is kept and reported, because "they signed v1 on
///                 3 March" is the useful answer, not "unsigned".
///   OUTSTANDING — never signed it.
export function statusFor(
  signatures: SignatureRow[],
  staffUserId: string,
  currentVersion: number,
): { status: SignStatus; signedAt: string | null; signedVersion: number | null } {
  const mine = signatures
    .filter((s) => s.staffUserId === staffUserId)
    .sort((a, b) => b.documentVersion - a.documentVersion);
  if (mine.length === 0) return { status: "OUTSTANDING", signedAt: null, signedVersion: null };
  const latest = mine[0];
  return {
    status: latest.documentVersion >= currentVersion ? "SIGNED" : "SUPERSEDED",
    signedAt: latest.signedAt,
    signedVersion: latest.documentVersion,
  };
}

export type PersonStatus = StaffPerson & {
  status: SignStatus;
  signedAt: string | null;
  signedVersion: number | null;
  dueDate: string | null;
};

/// Everybody who owes this document, and where each of them stands.
/// Outstanding first — that is the list an owner is looking for.
export function documentStatus(
  assignments: Assignment[],
  staff: StaffPerson[],
  signatures: SignatureRow[],
  currentVersion: number,
): { people: PersonStatus[]; signed: number; outstanding: number } {
  const ids = assignedStaffIds(assignments, staff);
  const people: PersonStatus[] = staff
    .filter((s) => ids.has(s.userId))
    .map((s) => ({
      ...s,
      ...statusFor(signatures, s.userId, currentVersion),
      dueDate: dueDateFor(assignments, staff, s.userId),
    }));

  const rank: Record<SignStatus, number> = { OUTSTANDING: 0, SUPERSEDED: 1, SIGNED: 2 };
  people.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

  return {
    people,
    signed: people.filter((p) => p.status === "SIGNED").length,
    outstanding: people.filter((p) => p.status !== "SIGNED").length,
  };
}

/// Whether editing a document's content should publish a new version.
///
/// Only the TITLE and the BODY — those are what somebody signed. Changing an
/// assignment, a due date or the document's type does not invalidate a
/// signature, and bumping the version for those would ask the whole team to
/// re-sign because a date moved.
export function needsNewVersion(
  before: { title: string; body: string | null },
  after: { title?: string; body?: string | null },
): boolean {
  if (after.title !== undefined && after.title.trim() !== before.title.trim()) return true;
  if (after.body !== undefined && (after.body ?? "").trim() !== (before.body ?? "").trim()) return true;
  return false;
}

export type SignDraft = { signerName: string; signatureDataUrl?: string | null };

/// What a signature needs to be valid. A typed name is enough — the member
/// flow accepts the same — and a drawn image is optional.
export function validateSignature(draft: SignDraft, expectedName: string | null): string[] {
  const errs: string[] = [];
  const typed = (draft.signerName ?? "").trim();
  if (!typed) errs.push("Type your name to sign.");
  else if (typed.length > 200) errs.push("That signature is too long.");
  else if (typed.length < 2) errs.push("Type your full name to sign.");

  if (draft.signatureDataUrl && !/^data:image\/png;base64,/.test(draft.signatureDataUrl)) {
    errs.push("That drawn signature could not be read.");
  }
  // A mismatch is NOT an error. People sign "Dan" when the record says
  // "Daniel", and refusing that would block a genuine signature over a
  // nickname. The typed name is recorded exactly as given, and `expectedName`
  // is here so a caller can show a gentle note if it wants one.
  void expectedName;
  return errs;
}

/// Documents one person owes, soonest due first. Drives both the staff card
/// and the reminder email.
export function outstandingFor(
  docs: { id: string; title: string; version: number; assignments: Assignment[] }[],
  staff: StaffPerson[],
  signaturesByDoc: Record<string, SignatureRow[]>,
  staffUserId: string,
): { id: string; title: string; dueDate: string | null; status: SignStatus }[] {
  const out: { id: string; title: string; dueDate: string | null; status: SignStatus }[] = [];
  for (const d of docs) {
    if (!assignedStaffIds(d.assignments, staff).has(staffUserId)) continue;
    const { status } = statusFor(signaturesByDoc[d.id] ?? [], staffUserId, d.version);
    if (status === "SIGNED") continue;
    out.push({ id: d.id, title: d.title, dueDate: dueDateFor(d.assignments, staff, staffUserId), status });
  }
  return out.sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.title.localeCompare(b.title);
  });
}
