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
