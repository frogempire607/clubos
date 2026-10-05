// Labeled external links on an event — "the host's registration page",
// "brackets", "hotel block", "directions". Stored on Event.externalLinks as a
// JSON array of { label, url }.
//
// PURE: no prisma, no fetch, no DOM. The API routes normalize every write
// through normalizeEventLinks, and every reader goes through eventLinksForRead
// so a stored value is never trusted to be well-formed.

export type EventLink = { label: string; url: string };

export const MAX_EVENT_LINKS = 8;
export const MAX_LINK_LABEL = 40;
export const MAX_LINK_URL = 500;

/** Label used when the old single `registrationLink` column is surfaced. */
export const LEGACY_LINK_LABEL = "Registration";

// "scheme:" at the start — but not "host:port" (digits after the colon) and
// not a Windows-style path. Anything matching this that isn't http(s) is refused.
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

/**
 * One web address, made safe to put in an href.
 * - trims; empty → null
 * - no scheme → https:// is added ("example.com/x", "//example.com/x")
 * - only http: and https: survive (javascript:, data:, mailto:, tel:, file: … → null)
 * - must have a real host with a dot (or be localhost), no spaces, no credentials
 * - longer than MAX_LINK_URL → null
 */
export function normalizeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters and whitespace inside a URL are how "java\nscript:" style
  // tricks get past naive checks — refuse them outright rather than strip.
  const t = raw.trim();
  if (!t) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(t)) return null;

  let candidate = t;
  const m = SCHEME.exec(t);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return null;
    if (!/^https?:\/\//i.test(t)) return null; // "http:example.com"
  } else if (t.startsWith("//")) {
    candidate = `https:${t}`;
  } else {
    candidate = `https://${t}`;
  }

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  if (host !== "localhost" && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !host.startsWith("[")) return null;

  const out = u.toString();
  if (out.length > MAX_LINK_URL) return null;
  return out;
}

/** "www.example.com" → "example.com". Empty string if unparseable. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").slice(0, MAX_LINK_LABEL);
  } catch {
    return "";
  }
}

function cleanLabel(raw: unknown, url: string): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (s) return s.slice(0, MAX_LINK_LABEL).trim();
  return hostLabel(url) || "Link";
}

export type NormalizeResult = {
  links: EventLink[];
  /** Rows that had something typed in the URL box but were not a usable web address. */
  rejected: { label: string; url: string }[];
  /** True when more than MAX_EVENT_LINKS usable links were given (extras dropped). */
  truncated: boolean;
};

/**
 * Whatever came in (a request body, a stored JSON value) → a clean list:
 * blank rows dropped, bad addresses dropped (and reported), duplicates by URL
 * dropped (first one wins), capped at MAX_EVENT_LINKS, order kept.
 */
export function normalizeEventLinksDetailed(input: unknown): NormalizeResult {
  const out: EventLink[] = [];
  const rejected: { label: string; url: string }[] = [];
  let truncated = false;
  if (!Array.isArray(input)) return { links: out, rejected, truncated };
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const r = row as { label?: unknown; url?: unknown };
    const rawUrl = typeof r.url === "string" ? r.url.trim() : "";
    if (!rawUrl) continue; // a blank row, or a label with no address
    const url = normalizeLinkUrl(rawUrl);
    if (!url) {
      rejected.push({ label: typeof r.label === "string" ? r.label.trim().slice(0, MAX_LINK_LABEL) : "", url: rawUrl.slice(0, 80) });
      continue;
    }
    const key = url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) continue;
    if (out.length >= MAX_EVENT_LINKS) { truncated = true; continue; }
    seen.add(key);
    out.push({ label: cleanLabel(r.label, url), url });
  }
  return { links: out, rejected, truncated };
}

export function normalizeEventLinks(input: unknown): EventLink[] {
  return normalizeEventLinksDetailed(input).links;
}

/**
 * The links to SHOW for an event. Uses externalLinks when it has any; otherwise
 * falls back to the old single registrationLink column (labeled "Registration")
 * so an address saved before this feature is not lost.
 */
export function eventLinksForRead(ev: { externalLinks?: unknown; registrationLink?: string | null } | null | undefined): EventLink[] {
  if (!ev) return [];
  const links = normalizeEventLinks(ev.externalLinks);
  if (links.length > 0) return links;
  const legacy = normalizeLinkUrl(ev.registrationLink ?? "");
  return legacy ? [{ label: LEGACY_LINK_LABEL, url: legacy }] : [];
}

/** A sentence for the staff editor when a save would drop something, or null. */
export function linkProblem(input: unknown): string | null {
  const r = normalizeEventLinksDetailed(input);
  if (r.rejected.length > 0) {
    const first = r.rejected[0];
    return `"${first.url}" isn't a web address. Links need to look like https://example.com/page.`;
  }
  if (r.truncated) return `An event can have up to ${MAX_EVENT_LINKS} links.`;
  return null;
}

/** Plain-text lines for emails: "Label: https://…". */
export function eventLinksText(links: EventLink[]): string {
  return links.map((l) => `${l.label}: ${l.url}`).join("\n");
}
