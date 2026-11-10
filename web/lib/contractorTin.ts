// Phase 12.1 — the ONE module that handles a contractor's tax identification
// number. Everything about TINs that touches the database is here.
//
// ── WHY ONE MODULE ──────────────────────────────────────────────────────────
// A TIN is readable in exactly one place in this codebase, and that place
// audits the read before it happens. Spreading `decryptField` calls around
// would make "every read is audited" a thing somebody has to remember instead
// of a property of the design.
//
//  · `revealTin` is the only caller of decryptField in the whole repo, and it
//    writes the audit row FIRST. If the audit cannot be written, the TIN is
//    not revealed — an unaudited read is refused rather than allowed.
//  · Writes go through `submitW9`, which refuses outright when no encryption
//    key is configured. There is no plaintext path.
//  · Nothing here logs. Not the TIN, not the ciphertext, not a stack trace
//    that could carry either.
//
// Owner-only enforcement lives in the route (requireOwnerLive); this module
// takes the actor it is given and records it.

import { prisma } from "@/lib/prisma";
import { randomBytes } from "node:crypto";
import { putObject } from "@/lib/storage";
import {
  FieldCryptoError,
  decryptField,
  encryptField,
  fieldCryptoConfigured,
  isEncryptedField,
} from "@/lib/fieldCrypto";
import {
  W9_CERTIFICATION_TEXT,
  formatTin,
  maskedTin,
  normalizeTin,
  tinLast4,
  validateW9,
  type TinKind,
  type W9Draft,
} from "@/lib/tin";
import { renderW9Pdf } from "@/lib/w9Pdf";

export class TinError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TinError";
    this.status = status;
  }
}

export type TinActor = { userId: string | null; name: string | null };

/// Audit actions, so a query can find every TIN touch.
export const TIN_AUDIT_ACTIONS = {
  reveal: "CONTRACTOR_TIN_REVEALED",
  store: "CONTRACTOR_W9_SUBMITTED",
  request: "CONTRACTOR_W9_REQUESTED",
} as const;

/// Writes the audit row, and THROWS if it cannot.
///
/// Deliberately not lib/billingAudit.writeBillingAudit, which swallows its
/// errors — correct for a billing note, wrong here. "Every read is audited"
/// only means something if a failed audit stops the read.
///
/// The payload carries the contractor, the last four digits and the kind. It
/// never carries the TIN or the ciphertext, because audit rows get exported.
async function auditTin(input: {
  clubId: string;
  action: (typeof TIN_AUDIT_ACTIONS)[keyof typeof TIN_AUDIT_ACTIONS];
  actor: TinActor;
  contractorId: string;
  contractorName: string;
  last4: string | null;
  kind: string | null;
  note: string;
}): Promise<void> {
  try {
    await prisma.billingAuditLog.create({
      data: {
        clubId: input.clubId,
        memberId: null,
        actorUserId: input.actor.userId,
        action: input.action,
        after: {
          contractorId: input.contractorId,
          contractorName: input.contractorName,
          taxIdLast4: input.last4,
          taxIdKind: input.kind,
        },
        note: input.note,
      },
    });
  } catch {
    throw new TinError(
      "That couldn't be recorded in the audit trail, so it was not done. Nothing about a tax ID happens unaudited.",
      500,
    );
  }
}

async function contractorOrThrow(clubId: string, contractorId: string) {
  const c = await prisma.contractor.findFirst({
    where: { id: contractorId, clubId, deletedAt: null },
    select: {
      id: true,
      name: true,
      clubId: true,
      w9Status: true,
      w9CurrentSubmissionId: true,
      taxIdLast4: true,
      taxIdKind: true,
      convertedUserId: true,
    },
  });
  if (!c) throw new TinError("That contractor doesn't exist.", 404);
  return c;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// The full TIN, in the clear, for one contractor.
///
/// THE ONLY decryption in the codebase. Audited before it happens; the audit
/// failing means the read does not happen.
///
/// Returns the formatted number ("123-45-6789") because the only legitimate
/// use is copying it onto a form.
export async function revealTin(
  clubId: string,
  contractorId: string,
  actor: TinActor,
  reason?: string | null,
): Promise<{ tin: string; kind: TinKind; last4: string; legalName: string | null }> {
  const contractor = await contractorOrThrow(clubId, contractorId);
  if (!contractor.w9CurrentSubmissionId) {
    throw new TinError("There's no W-9 on file for that contractor yet.", 404);
  }

  const submission = await prisma.contractorW9Submission.findFirst({
    where: { id: contractor.w9CurrentSubmissionId, clubId, contractorId },
    select: { taxIdEncrypted: true, taxIdLast4: true, taxIdKind: true, legalName: true },
  });
  if (!submission) throw new TinError("There's no W-9 on file for that contractor yet.", 404);

  // Audit BEFORE decrypting. The order is the point.
  await auditTin({
    clubId,
    action: TIN_AUDIT_ACTIONS.reveal,
    actor,
    contractorId,
    contractorName: contractor.name,
    last4: submission.taxIdLast4,
    kind: submission.taxIdKind,
    note: reason?.trim()
      ? `Tax ID revealed to ${actor.name ?? "an owner"} — ${reason.trim().slice(0, 200)}`
      : `Tax ID revealed to ${actor.name ?? "an owner"}`,
  });

  let plain: string;
  try {
    plain = decryptField(submission.taxIdEncrypted);
  } catch (e) {
    // The audit row above already records the attempt, which is what an
    // auditor wants: somebody tried, and it failed.
    throw new TinError(
      e instanceof FieldCryptoError
        ? e.message
        : "That tax ID could not be read. The encryption key may be missing or changed.",
      500,
    );
  }

  const kind = (submission.taxIdKind === "EIN" ? "EIN" : "SSN") as TinKind;
  return {
    tin: formatTin(plain, kind),
    kind,
    last4: submission.taxIdLast4,
    legalName: submission.legalName,
  };
}

/// What every other surface gets: the mask, never the number. No decryption,
/// so no audit needed — there is nothing sensitive to record.
export function maskFor(last4: string | null, kind: string | null): string {
  return maskedTin(last4, kind === "EIN" ? "EIN" : kind === "SSN" ? "SSN" : null);
}

// ── Writing ─────────────────────────────────────────────────────────────────

export type W9Meta = {
  signedByUserId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

/// Store a completed W-9: encrypt the TIN, write the submission, generate the
/// PDF, point the contractor at it, and supersede whatever came before.
///
/// Refuses when no encryption key is configured. That check is FIRST, before
/// anything is written and before the value is used, so a contractor is never
/// asked to type a tax id the app cannot store safely.
export async function submitW9(
  clubId: string,
  contractorId: string,
  draft: W9Draft,
  meta: W9Meta,
  actor: TinActor,
): Promise<{ submissionId: string; last4: string; fileUrl: string | null }> {
  if (!fieldCryptoConfigured()) {
    throw new TinError(
      "Tax IDs can't be accepted yet: this installation has no encryption key configured, and a tax ID is never stored unencrypted. Ask the club owner to set FIELD_ENCRYPTION_KEY.",
      503,
    );
  }

  const contractor = await contractorOrThrow(clubId, contractorId);

  const errors = validateW9(draft);
  if (errors.length) throw new TinError(errors.join(" "));

  const kind = draft.taxIdKind as TinKind;
  const digits = normalizeTin(draft.taxId);
  const last4 = tinLast4(digits);

  // Encrypt before the transaction: if there is no key this throws here, with
  // nothing written.
  let encrypted: string;
  try {
    encrypted = encryptField(digits);
  } catch (e) {
    throw new TinError(
      e instanceof FieldCryptoError ? e.message : "That tax ID could not be stored securely, so it was not stored.",
      503,
    );
  }
  // Belt and braces: never write something that is not ciphertext.
  if (!isEncryptedField(encrypted)) {
    throw new TinError("That tax ID could not be stored securely, so it was not stored.", 500);
  }

  const legalName = draft.legalName.trim();
  const now = new Date();

  const submissionId = await prisma.$transaction(async (tx) => {
    // Supersede the previous one. Kept, never deleted: what a contractor
    // certified before is still the record for the years it covered.
    if (contractor.w9CurrentSubmissionId) {
      await tx.contractorW9Submission.updateMany({
        where: { id: contractor.w9CurrentSubmissionId, clubId, supersededAt: null },
        data: { supersededAt: now },
      });
    }

    const created = await tx.contractorW9Submission.create({
      data: {
        clubId,
        contractorId,
        legalName,
        businessName: draft.businessName?.trim() || null,
        taxClassification: draft.taxClassification,
        classificationNote: draft.classificationNote?.trim() || null,
        streetAddress: draft.streetAddress.trim(),
        city: draft.city.trim(),
        state: draft.state.trim(),
        zipCode: draft.zipCode.trim(),
        taxIdKind: kind,
        taxIdEncrypted: encrypted,
        taxIdLast4: last4,
        // Snapshotted: editing the app's copy must not change what anybody
        // already certified.
        certificationText: W9_CERTIFICATION_TEXT,
        signedName: draft.signedName.trim(),
        signedAt: now,
        signedByUserId: meta.signedByUserId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      },
      select: { id: true },
    });

    await tx.contractor.update({
      where: { id: contractorId },
      data: {
        w9Status: "SUBMITTED",
        w9CurrentSubmissionId: created.id,
        taxIdLast4: last4,
        taxIdKind: kind,
        // The address they certified becomes the contractor's address too,
        // which is what a 1099 is mailed to.
        streetAddress: draft.streetAddress.trim(),
        city: draft.city.trim(),
        state: draft.state.trim(),
        zipCode: draft.zipCode.trim(),
        // A fresh submission answers any outstanding request.
        w9RequestedAt: null,
        w9RequestedByUserId: null,
      },
    });

    return created.id;
  });

  await auditTin({
    clubId,
    action: TIN_AUDIT_ACTIONS.store,
    actor,
    contractorId,
    contractorName: contractor.name,
    last4,
    kind,
    note: `W-9 submitted by ${draft.signedName.trim()}`,
  });

  // The PDF is generated AFTER the submission is committed, and a failure here
  // does not lose the W-9 — the data is the record, the PDF is a copy of it,
  // and it can be regenerated. Losing a signed certification because a PDF
  // library threw would be the worse outcome.
  const fileUrl = await attachW9Pdf(clubId, contractorId, submissionId, actor).catch(() => null);

  return { submissionId, last4, fileUrl };
}

/// Render the submission as a PDF and keep it: on the submission, as a
/// StaffDocument of kind W9 when the contractor is linked to a staff user, and
/// on `Contractor.w9Url` so the existing "W-9 on file" checks keep working.
///
/// The IRS requires an electronic W-9 system to be able to produce a hard copy
/// on request. This is that copy.
export async function attachW9Pdf(
  clubId: string,
  contractorId: string,
  submissionId: string,
  actor: TinActor,
): Promise<string | null> {
  const submission = await prisma.contractorW9Submission.findFirst({
    where: { id: submissionId, clubId, contractorId },
  });
  if (!submission) return null;

  const contractor = await prisma.contractor.findFirst({
    where: { id: contractorId, clubId },
    select: { name: true, convertedUserId: true },
  });

  // The PDF shows the TIN, because a W-9 does. Decrypting for it is audited
  // like any other read.
  const revealed = await revealTin(clubId, contractorId, actor, "generating the W-9 PDF copy");

  const pdf = renderW9Pdf({
    legalName: submission.legalName,
    businessName: submission.businessName,
    taxClassification: submission.taxClassification,
    classificationNote: submission.classificationNote,
    streetAddress: submission.streetAddress,
    city: submission.city,
    state: submission.state,
    zipCode: submission.zipCode,
    taxIdKind: submission.taxIdKind === "EIN" ? "EIN" : "SSN",
    taxIdFormatted: revealed.tin,
    certificationText: submission.certificationText,
    signedName: submission.signedName,
    signedAt: submission.signedAt,
    ipAddress: submission.ipAddress,
  });

  // Same convention as /api/upload: an unguessable random key, unrelated to
  // any row id, so a leaked id can't be turned into a storage path. The club
  // scope is enforced by /api/files/[id], not by the key.
  const storageKey = `${randomBytes(16).toString("hex")}.pdf`;
  await putObject(storageKey, pdf, "application/pdf");

  const fileName = `W-9 ${submission.legalName} ${submission.signedAt.toISOString().slice(0, 10)}.pdf`;
  const file = await prisma.uploadedFile.create({
    data: {
      clubId,
      uploaderId: actor.userId,
      storageKey,
      originalName: fileName,
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
      kind: "document",
    },
    select: { id: true },
  });
  // /api/files/[id] is the only way to fetch the bytes, and it scopes by club.
  const url = `/api/files/${file.id}`;

  let staffDocumentId: string | null = null;
  if (contractor?.convertedUserId) {
    const doc = await prisma.staffDocument.create({
      data: {
        clubId,
        userId: contractor.convertedUserId,
        fileId: file.id,
        fileUrl: url,
        fileName,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        title: `W-9 (${submission.signedAt.toISOString().slice(0, 10)})`,
        kind: "W9",
        // The person whose W-9 it is can see their own copy.
        sharedWithStaff: true,
        uploadedById: actor.userId,
      },
      select: { id: true },
    });
    staffDocumentId = doc.id;
  }

  await prisma.contractorW9Submission.updateMany({
    where: { id: submissionId, clubId },
    data: { fileId: file.id, fileUrl: url, staffDocumentId },
  });
  await prisma.contractor.updateMany({
    where: { id: contractorId, clubId },
    data: { w9Url: url },
  });

  return url;
}

/// An owner asks for a fresh W-9. Status resets, the existing submission stays
/// in force until a new one arrives, and nothing is deleted.
export async function requestNewW9(
  clubId: string,
  contractorId: string,
  actor: TinActor,
): Promise<void> {
  const contractor = await contractorOrThrow(clubId, contractorId);
  await prisma.contractor.update({
    where: { id: contractorId },
    data: {
      w9Status: "NOT_STARTED",
      w9RequestedAt: new Date(),
      w9RequestedByUserId: actor.userId,
    },
  });
  await auditTin({
    clubId,
    action: TIN_AUDIT_ACTIONS.request,
    actor,
    contractorId,
    contractorName: contractor.name,
    last4: contractor.taxIdLast4,
    kind: contractor.taxIdKind,
    note: `A new W-9 was requested by ${actor.name ?? "an owner"}`,
  });
}

/// The history, newest first. Masked — this never decrypts.
export async function w9History(clubId: string, contractorId: string) {
  const rows = await prisma.contractorW9Submission.findMany({
    where: { clubId, contractorId },
    orderBy: { signedAt: "desc" },
    select: {
      id: true,
      legalName: true,
      businessName: true,
      taxClassification: true,
      taxIdKind: true,
      taxIdLast4: true,
      signedName: true,
      signedAt: true,
      supersededAt: true,
      fileUrl: true,
      streetAddress: true,
      city: true,
      state: true,
      zipCode: true,
    },
  });
  return rows.map((r) => ({
    ...r,
    signedAt: r.signedAt.toISOString(),
    supersededAt: r.supersededAt?.toISOString() ?? null,
    maskedTin: maskFor(r.taxIdLast4, r.taxIdKind),
  }));
}
