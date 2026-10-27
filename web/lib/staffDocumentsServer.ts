// Phase 12.1 Part 4 — staff documents, read and written.
//
// Reuses `Document` for the document itself (title, sanitised rich-text body,
// type, the existing editor and renderer) and the existing signing mechanic.
// Only the link tables are staff-specific — see the header of
// lib/staffDocuments.ts for why.
//
// Every query is scoped by clubId.

import { prisma } from "@/lib/prisma";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";
import {
  type Assignment,
  type AssignmentScope,
  type SignatureRow,
  type StaffPerson,
  documentStatus,
  isAssignmentScope,
  needsNewVersion,
  outstandingFor,
  validateSignature,
} from "@/lib/staffDocuments";

export class StaffDocError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "StaffDocError";
    this.status = status;
  }
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const asDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/// Everyone who can be assigned a document: the club's staff and its owners.
/// Owners are included because a handbook or a policy applies to them too.
export async function clubStaff(clubId: string): Promise<StaffPerson[]> {
  const users = await prisma.user.findMany({
    where: { clubId, deletedAt: null, role: { in: ["STAFF", "OWNER"] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      staffProfile: { select: { title: true } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return users.map((u) => ({
    userId: u.id,
    name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || "Staff member",
    email: u.email,
    title: u.staffProfile?.title ?? null,
  }));
}

function toAssignments(rows: { id: string; scope: string; staffUserId: string | null; role: string | null; dueDate: Date | null }[]): Assignment[] {
  return rows.map((a) => ({
    id: a.id,
    scope: (isAssignmentScope(a.scope) ? a.scope : "ALL") as AssignmentScope,
    staffUserId: a.staffUserId,
    role: a.role,
    dueDate: a.dueDate ? ymd(a.dueDate) : null,
  }));
}

function toSignatures(rows: { staffUserId: string; documentVersion: number; signedAt: Date; signerName: string }[]): SignatureRow[] {
  return rows.map((s) => ({
    staffUserId: s.staffUserId,
    documentVersion: s.documentVersion,
    signedAt: s.signedAt.toISOString(),
    signerName: s.signerName,
  }));
}

// ── Owner side ──────────────────────────────────────────────────────────────

/// Every staff document with who has signed and who hasn't.
export async function listStaffDocuments(clubId: string) {
  const [docs, staff] = await Promise.all([
    prisma.document.findMany({
      // `audience: "STAFF"` is what separates these from member documents.
      // Member-facing reads filter the other way, and
      // scripts/staff-documents-tests.ts enumerates those files so a missed
      // filter fails the build rather than leaking a handbook to a member.
      where: { clubId, audience: "STAFF", deletedAt: null },
      include: {
        staffAssignments: {
          select: { id: true, scope: true, staffUserId: true, role: true, dueDate: true },
        },
        staffSignatures: {
          select: {
            staffUserId: true,
            documentVersion: true,
            signedAt: true,
            signerName: true,
            signatureDataUrl: true,
            ipAddress: true,
          },
          orderBy: { signedAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    clubStaff(clubId),
  ]);

  return docs.map((d) => {
    const assignments = toAssignments(d.staffAssignments);
    const status = documentStatus(assignments, staff, toSignatures(d.staffSignatures), d.version);
    return {
      id: d.id,
      title: d.title,
      type: d.type,
      body: d.body,
      version: d.version,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      assignments,
      ...status,
      // Every signature ever given, newest first, including superseded ones.
      signatures: d.staffSignatures.map((s) => ({
        staffUserId: s.staffUserId,
        signerName: s.signerName,
        documentVersion: s.documentVersion,
        signedAt: s.signedAt.toISOString(),
        hasDrawnSignature: !!s.signatureDataUrl,
        ipAddress: s.ipAddress,
      })),
    };
  });
}

export type AssignmentInput = {
  scope: AssignmentScope;
  staffUserId?: string | null;
  role?: string | null;
  dueDate?: string | null;
};

/// Replace a document's assignments. Assignments are not signatures — swapping
/// them never invalidates one, so this does NOT bump the version.
async function writeAssignments(
  clubId: string,
  documentId: string,
  assignments: AssignmentInput[],
  actorUserId: string | null,
) {
  // De-duplicate: the same shape twice is the same instruction, and the STAFF
  // unique index would reject the second anyway.
  const seen = new Set<string>();
  const clean: AssignmentInput[] = [];
  for (const a of assignments) {
    if (!isAssignmentScope(a.scope)) continue;
    if (a.scope === "STAFF" && !a.staffUserId) continue;
    if (a.scope === "ROLE" && !a.role?.trim()) continue;
    const key = `${a.scope}:${a.staffUserId ?? ""}:${(a.role ?? "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(a);
  }
  if (clean.length === 0) {
    throw new StaffDocError("Say who has to sign this — everyone, a role, or named people.");
  }

  // Named people must be staff of THIS club.
  const named = clean.filter((a) => a.scope === "STAFF").map((a) => a.staffUserId as string);
  if (named.length) {
    const found = await prisma.user.count({
      where: { id: { in: named }, clubId, deletedAt: null },
    });
    if (found !== new Set(named).size) {
      throw new StaffDocError("One of those staff members isn't in this club.", 404);
    }
  }

  await prisma.$transaction([
    prisma.staffDocumentAssignment.deleteMany({ where: { clubId, documentId } }),
    prisma.staffDocumentAssignment.createMany({
      data: clean.map((a) => ({
        clubId,
        documentId,
        scope: a.scope,
        staffUserId: a.scope === "STAFF" ? a.staffUserId ?? null : null,
        role: a.scope === "ROLE" ? a.role?.trim() ?? null : null,
        dueDate: a.dueDate ? asDate(a.dueDate) : null,
        createdByUserId: actorUserId,
      })),
    }),
  ]);
}

export async function createStaffDocument(
  clubId: string,
  input: { title: string; body: string | null; type?: string; assignments: AssignmentInput[] },
  actorUserId: string | null,
): Promise<string> {
  if (!input.title.trim()) throw new StaffDocError("Give the document a title.");

  const doc = await prisma.document.create({
    data: {
      clubId,
      title: input.title.trim(),
      type: input.type?.trim() || "POLICY",
      // Same sanitiser the member documents use — the body is rendered with
      // dangerouslySetInnerHTML, so it is cleaned on the way IN.
      body: input.body ? sanitizeRichHtml(input.body) : null,
      audience: "STAFF",
      version: 1,
      // Member-document machinery stays off: these never gate a signup, a
      // purchase or an event.
      required: false,
      requiredAt: [],
    },
    select: { id: true },
  });
  await writeAssignments(clubId, doc.id, input.assignments, actorUserId);
  return doc.id;
}

export async function updateStaffDocument(
  clubId: string,
  documentId: string,
  input: { title?: string; body?: string | null; type?: string; assignments?: AssignmentInput[] },
  actorUserId: string | null,
): Promise<{ versionBumped: boolean; version: number }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, clubId, audience: "STAFF", deletedAt: null },
    select: { id: true, title: true, body: true, version: true },
  });
  if (!doc) throw new StaffDocError("That document doesn't exist.", 404);

  // Only the title and the body are what somebody signed, so only those
  // publish a new version. Moving a due date must not ask the whole team to
  // sign again.
  const bump = needsNewVersion({ title: doc.title, body: doc.body }, {
    title: input.title,
    body: input.body === undefined ? undefined : input.body ? sanitizeRichHtml(input.body) : null,
  });

  const version = bump ? doc.version + 1 : doc.version;
  await prisma.document.update({
    where: { id: documentId },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body ? sanitizeRichHtml(input.body) : null } : {}),
      ...(input.type !== undefined ? { type: input.type.trim() || "POLICY" } : {}),
      ...(bump ? { version } : {}),
    },
  });
  if (input.assignments) await writeAssignments(clubId, documentId, input.assignments, actorUserId);

  // Earlier signatures are KEPT. They recorded a version, so they stay true
  // statements about what that person signed and when.
  return { versionBumped: bump, version };
}

/// Soft-delete, matching how member documents are removed. Signatures are
/// kept: deleting the evidence somebody signed a non-compete would be the
/// opposite of what this feature is for.
export async function deleteStaffDocument(clubId: string, documentId: string): Promise<void> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, clubId, audience: "STAFF", deletedAt: null },
    select: { id: true },
  });
  if (!doc) throw new StaffDocError("That document doesn't exist.", 404);
  await prisma.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
}

// ── Staff side ──────────────────────────────────────────────────────────────

/// The documents one staff member is assigned, and where they stand on each.
///
/// THE ONLY way staff read staff documents, and it takes the user id from the
/// session rather than a parameter — so "staff can't see other staff's
/// documents" is structural rather than a check that could be forgotten.
export async function myStaffDocuments(clubId: string, staffUserId: string) {
  const [docs, staff] = await Promise.all([
    prisma.document.findMany({
      where: { clubId, audience: "STAFF", deletedAt: null },
      include: {
        staffAssignments: {
          select: { id: true, scope: true, staffUserId: true, role: true, dueDate: true },
        },
        // ONLY MY OWN signatures are loaded. A colleague's signature is not
        // filtered out downstream — it is never fetched.
        staffSignatures: {
          where: { staffUserId },
          select: { staffUserId: true, documentVersion: true, signedAt: true, signerName: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    clubStaff(clubId),
  ]);

  const signaturesByDoc: Record<string, SignatureRow[]> = {};
  for (const d of docs) signaturesByDoc[d.id] = toSignatures(d.staffSignatures);

  const assignedDocs = docs.map((d) => ({
    id: d.id,
    title: d.title,
    version: d.version,
    assignments: toAssignments(d.staffAssignments),
  }));
  const outstanding = outstandingFor(assignedDocs, staff, signaturesByDoc, staffUserId);
  const outstandingIds = new Set(outstanding.map((o) => o.id));

  const mine = docs
    .filter((d) => {
      const assignments = toAssignments(d.staffAssignments);
      return documentStatus(assignments, staff, [], d.version).people.some((p) => p.userId === staffUserId);
    })
    .map((d) => {
      const sigs = signaturesByDoc[d.id] ?? [];
      const latest = [...sigs].sort((a, b) => b.documentVersion - a.documentVersion)[0] ?? null;
      return {
        id: d.id,
        title: d.title,
        type: d.type,
        body: d.body,
        version: d.version,
        needsSignature: outstandingIds.has(d.id),
        dueDate: outstanding.find((o) => o.id === d.id)?.dueDate ?? null,
        signedAt: latest?.signedAt ?? null,
        signedVersion: latest?.documentVersion ?? null,
        // "You signed version 1, and version 2 is out" — a different and more
        // useful message than "unsigned".
        resignRequired: !!latest && latest.documentVersion < d.version,
      };
    });

  return { documents: mine, outstandingCount: outstanding.length };
}

/// Sign one. Refuses a document this person is not assigned, so a guessed id
/// gets nothing.
export async function signStaffDocument(
  clubId: string,
  documentId: string,
  staffUserId: string,
  draft: { signerName: string; signatureDataUrl?: string | null },
  meta: { ipAddress: string | null; userAgent: string | null },
): Promise<{ signedVersion: number }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, clubId, audience: "STAFF", deletedAt: null },
    include: {
      staffAssignments: { select: { id: true, scope: true, staffUserId: true, role: true, dueDate: true } },
    },
  });
  if (!doc) throw new StaffDocError("That document doesn't exist.", 404);

  const staff = await clubStaff(clubId);
  const me = staff.find((s) => s.userId === staffUserId);
  const assigned = documentStatus(toAssignments(doc.staffAssignments), staff, [], doc.version).people.some(
    (p) => p.userId === staffUserId,
  );
  // 404, not 403: whether a document exists is not information somebody who
  // isn't assigned it needs.
  if (!assigned) throw new StaffDocError("That document doesn't exist.", 404);

  const errs = validateSignature(draft, me?.name ?? null);
  if (errs.length) throw new StaffDocError(errs.join(" "));

  try {
    await prisma.staffDocumentSignature.create({
      data: {
        clubId,
        documentId,
        staffUserId,
        signerName: draft.signerName.trim(),
        documentVersion: doc.version,
        signatureDataUrl: draft.signatureDataUrl ?? null,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      },
    });
  } catch {
    // The unique on (documentId, staffUserId, documentVersion) means a double
    // click lands here. Already signed is success, not an error.
    const existing = await prisma.staffDocumentSignature.findFirst({
      where: { clubId, documentId, staffUserId, documentVersion: doc.version },
      select: { id: true },
    });
    if (!existing) throw new StaffDocError("That signature couldn't be saved.", 500);
  }

  return { signedVersion: doc.version };
}

/// Who still owes a document, for the reminder.
export async function outstandingPeople(clubId: string, documentId: string) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, clubId, audience: "STAFF", deletedAt: null },
    include: {
      staffAssignments: { select: { id: true, scope: true, staffUserId: true, role: true, dueDate: true } },
      staffSignatures: { select: { staffUserId: true, documentVersion: true, signedAt: true, signerName: true } },
    },
  });
  if (!doc) throw new StaffDocError("That document doesn't exist.", 404);
  const staff = await clubStaff(clubId);
  const status = documentStatus(toAssignments(doc.staffAssignments), staff, toSignatures(doc.staffSignatures), doc.version);
  return { doc: { id: doc.id, title: doc.title, version: doc.version }, people: status.people.filter((p) => p.status !== "SIGNED") };
}
