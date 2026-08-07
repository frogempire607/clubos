export const REQUIRED_DOCUMENT_SURFACES = ["ONBOARDING", "SIGNUP", "PURCHASE", "EVENT"] as const;
export type RequiredDocumentSurface = (typeof REQUIRED_DOCUMENT_SURFACES)[number];

export type RequiredDocumentRef = {
  id: string;
  required: boolean;
  requiredAt?: string[] | null;
};

export function isDocumentRequiredAt(doc: RequiredDocumentRef, surface: RequiredDocumentSurface): boolean {
  const requiredAt = doc.requiredAt ?? [];
  if (requiredAt.includes(surface)) return true;
  return surface === "ONBOARDING" && doc.required && requiredAt.length === 0;
}

export function missingRequiredDocumentIds(
  docs: RequiredDocumentRef[],
  signedDocumentIds: string[],
  surface: RequiredDocumentSurface,
): string[] {
  const signed = new Set(signedDocumentIds);
  return docs
    .filter((doc) => isDocumentRequiredAt(doc, surface))
    .filter((doc) => !signed.has(doc.id))
    .map((doc) => doc.id);
}

/**
 * Where a member stands on one document.
 *
 * Extracted in session 4 so the staff-facing profile tab and the member portal
 * agree by construction. The expiry arithmetic lived inline in
 * `/api/member/documents`; a second copy on the staff side would eventually
 * disagree about whether a waiver is still valid, and "the office says I'm
 * covered, the app says I'm not" is the worst possible version of that bug.
 *
 *   SIGNED   — a valid signature is on file
 *   EXPIRED  — signed, but past `signatureValidForDays`. Still evidence they
 *              once signed, which is why it is not the same as MISSING.
 *   MISSING  — no signature at all
 */
export type DocumentStatus = "SIGNED" | "EXPIRED" | "MISSING";

export function documentSignatureStatus(
  doc: { signatureValidForDays?: number | null },
  sig: { signedAt: Date | string } | null | undefined,
  now: Date = new Date(),
): { status: DocumentStatus; expiresAt: Date | null } {
  if (!sig) return { status: "MISSING", expiresAt: null };
  if (!doc.signatureValidForDays) return { status: "SIGNED", expiresAt: null };
  const expiresAt = new Date(sig.signedAt);
  expiresAt.setDate(expiresAt.getDate() + doc.signatureValidForDays);
  return { status: expiresAt < now ? "EXPIRED" : "SIGNED", expiresAt };
}

export function requiredDocumentSurfaceWhere(surface: RequiredDocumentSurface) {
  return {
    OR: [
      { requiredAt: { has: surface } },
      ...(surface === "ONBOARDING"
        ? [{ AND: [{ required: true }, { requiredAt: { isEmpty: true } }] }]
        : []),
    ],
  };
}
