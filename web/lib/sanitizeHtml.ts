import DOMPurify from "isomorphic-dompurify";

// Sanitize user-submitted rich HTML before storage.
//
// Use this for any HTML body that will later be rendered via
// dangerouslySetInnerHTML — currently `Document.body` on both the
// owner-side `app/dashboard/documents` editor and the member-side
// `app/member/documents` reader.
//
// Allowlist mirrors a typical rich-text editor: structural tags,
// lists, links, basic formatting, headings, tables, blockquotes. NO
// script, NO iframe, NO inline event handlers, NO javascript: URLs.
//
// DOMPurify is the standard for this; we wrap it so every call site
// uses the same allowlist instead of each route defining its own.
//
// IMPORTANT: this is a defense-in-depth measure. The trust boundary
// here is "owners and staff are trusted within their own club" — but
// a compromised owner account or a staff member with `documents:edit`
// permission shouldn't be able to ship JS that runs in every
// member's browser. Sanitizing at WRITE time keeps the database
// clean and lets us trust stored values on render.

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "div", "span",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "strong", "b", "em", "i", "u", "s", "sub", "sup",
    "a",
    "blockquote", "pre", "code",
    "table", "thead", "tbody", "tr", "td", "th",
  ],
  ALLOWED_ATTR: [
    "href", "target", "rel",
    "class",
    "colspan", "rowspan",
  ],
  // Block javascript:, vbscript:, data: URLs. http/https/mailto/tel allowed.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

export function sanitizeRichHtml(input: string | null | undefined): string {
  if (!input) return "";
  try {
    return DOMPurify.sanitize(input, CONFIG);
  } catch {
    // Safety net: if DOMPurify can't initialize in this runtime (e.g. a
    // serverless function where jsdom failed to load), don't 500 the request.
    // Fall back to a conservative strip of the dangerous bits — scripts,
    // styles, iframes, event handlers, javascript: URLs — keeping the rest of
    // the (owner/staff-authored) markup intact.
    return fallbackStrip(input);
  }
}

function fallbackStrip(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "$1=$2#$2")
    .replace(/(href|src)\s*=\s*javascript:[^\s>]+/gi, "$1=#");
}
