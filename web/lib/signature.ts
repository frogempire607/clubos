// Shared validation for drawn-signature payloads (PNG data URLs). Used by the
// member document-sign route and the public onboarding/activation route so the
// size/format rules stay identical in both places.

export const MAX_SIGNATURE_DATA_URL = 300_000; // ~220 KB encoded — plenty for a signature.

export function isValidSignatureDataUrl(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= MAX_SIGNATURE_DATA_URL &&
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v)
  );
}
