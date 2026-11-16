// Response headers for any stored file we hand back to a browser.
//
// Uploaded files are served from the APP'S OWN ORIGIN, so a file the browser is
// willing to run as a page runs with the viewer's session. An SVG is exactly
// that: it is an image when it sits in an <img>, and a script-capable document
// when someone opens its URL directly (2026-11-15: any member could upload one
// and send the link to an owner; the public club-logo route served them with
// no session at all).
//
// So every file response gets `nosniff`, and anything that is not on the short
// list of types a browser can only ever DISPLAY is sent as a download inside a
// sandbox. An <img> ignores both headers, so logos and photos look the same.

/** Types that are safe to render inline when their URL is opened directly. */
const INLINE_SAFE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export function isInlineSafe(mimeType: string | null | undefined): boolean {
  return INLINE_SAFE.has((mimeType ?? "").split(";")[0].trim().toLowerCase());
}

/** Strip anything that could break out of the quoted filename. */
function safeName(name: string): string {
  return name.replace(/["\\\r\n]/g, "").slice(0, 200) || "file";
}

export function fileResponseHeaders(input: {
  mimeType: string;
  size: number;
  cacheControl: string;
  originalName?: string | null;
}): Record<string, string> {
  const inline = isInlineSafe(input.mimeType);
  const headers: Record<string, string> = {
    "Content-Type": input.mimeType,
    "Content-Length": String(input.size),
    "Cache-Control": input.cacheControl,
    "X-Content-Type-Options": "nosniff",
  };
  if (input.originalName != null) {
    headers["Content-Disposition"] = `${inline ? "inline" : "attachment"}; filename="${safeName(input.originalName)}"`;
  } else if (!inline) {
    headers["Content-Disposition"] = "attachment";
  }
  // A sandbox with no allowances: no script, no same-origin access. PDFs are
  // left out because browser PDF viewers refuse to open inside a sandbox.
  if (!inline) headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  return headers;
}

/**
 * File kinds a member login must never be handed, even inside their own club.
 *   document  a contractor's signed W-9 (lib/contractorTin.ts)
 *   LEDGER    an attachment on a books entry
 *   RECEIPT   an expense receipt
 */
export const STAFF_ONLY_FILE_KINDS = new Set(["document", "LEDGER", "RECEIPT"]);
