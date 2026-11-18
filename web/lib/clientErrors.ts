// Client error reports — the shape, the limits, and what is stripped before
// anything is stored (crash audit 2026-11-18, docs/CRASH-AUDIT-2026-11-18.md).
//
// PURE: no database, no browser globals. Shared by the browser reporter
// (lib/clientErrorReporter.ts), the endpoint that stores a report
// (app/api/public/client-errors) and the tests.
//
// The rule for what a report may hold: enough to find the bug, nothing about a
// person. So an address keeps its SHAPE (/dashboard/members/:id) and loses its
// ids, tokens and query string; error text loses anything that looks like an
// email address or a long opaque token. Who it happened to is recorded by the
// server from the session — an id and a role — never taken from the browser.

export const CLIENT_ERROR_SOURCES = ["SCREEN", "WINDOW", "PROMISE"] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

export const MAX_MESSAGE = 500;
export const MAX_STACK = 4000;
export const MAX_BODY_BYTES = 16_000;

export type ClientErrorReport = {
  source: ClientErrorSource;
  path: string;
  message: string;
  stack: string | null;
  digest: string | null;
  viewport: string | null;
};

/**
 * An address with everything identifying taken out.
 *   /dashboard/members/cmq9xyrjx00008tc4xck1k9qo?edit=1  →  /dashboard/members/:id
 *   /activate/3f9c…64 hex…                              →  /activate/:id
 *   /e/summer-camp-2027                                  →  /e/summer-camp-2027
 * Activation, reactivation, setup and calendar links carry their secret IN the
 * path or the query string; neither may reach the table.
 */
export function scrubPath(raw: string): string {
  let path = raw;
  try {
    path = new URL(raw, "https://x.invalid").pathname;
  } catch {
    path = raw.split(/[?#]/)[0] ?? "";
  }
  const out = path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      let s = seg;
      try { s = decodeURIComponent(seg); } catch { /* keep as is */ }
      // a database id, a token, a number, or anything long with a digit in it
      if (/^\d+$/.test(s)) return ":id";
      if (/^c[a-z0-9]{20,}$/.test(s)) return ":id";
      // A readable name a person chose (summer-camp-2027): short lowercase
      // words joined by dashes. A token never looks like that.
      const readable = /^[a-z]+(-[a-z0-9]+)+$/.test(s) && s.length <= 60 && s.split("-").every((w) => w.length <= 12);
      if (!readable && s.length >= 16 && /\d/.test(s) && /^[A-Za-z0-9_\-.~]+$/.test(s)) return ":id";
      if (/^[A-Za-z]+_[A-Za-z0-9]{4,}$/.test(s) && /\d/.test(s)) return ":id";
      if (/@/.test(s)) return ":id";
      return seg;
    })
    .join("/");
  return (out || "/").slice(0, 200);
}

/** Error text with email addresses and long opaque strings removed. */
export function scrubText(raw: string, max: number): string {
  return raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    // query strings on any address inside a stack or message
    .replace(/(https?:\/\/[^\s)'"?]+)\?[^\s)'"]*/g, "$1")
    // tokens: 24+ characters of letters and digits that include a digit,
    // except the hashed chunk names in a stack (…/page-356b316376a84189.js)
    .replace(/(?<![-/.\w])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}(?![\w.])/g, "[token]")
    .slice(0, max);
}

/** Same crash → same string, so repeats group without comparing stacks. */
export function fingerprintOf(r: Pick<ClientErrorReport, "source" | "path" | "message">): string {
  return `${r.source}|${r.path}|${r.message.slice(0, 140)}`;
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try { return String(v); } catch { return ""; }
}

/** Build a report in the browser from whatever was thrown. */
export function buildReport(input: { error: unknown; source: ClientErrorSource; href: string; viewport?: string | null; digest?: string | null }): ClientErrorReport {
  const e = input.error as { message?: unknown; stack?: unknown; name?: unknown; digest?: unknown } | null;
  const name = e && typeof e === "object" ? text(e.name) : "";
  const rawMessage = e && typeof e === "object" && e.message != null ? text(e.message) : text(input.error);
  const message = scrubText(`${name && name !== "Error" ? `${name}: ` : ""}${rawMessage || "Unknown error"}`, MAX_MESSAGE);
  const stack = e && typeof e === "object" && e.stack ? scrubText(text(e.stack), MAX_STACK) : null;
  const digest = input.digest ?? (e && typeof e === "object" && e.digest ? text(e.digest).slice(0, 60) : null);
  return { source: input.source, path: scrubPath(input.href), message, stack, digest, viewport: input.viewport ? input.viewport.slice(0, 20) : null };
}

/**
 * What the server accepts. Everything is scrubbed AGAIN here: the endpoint is
 * open to anyone, so nothing the browser claims to have cleaned is trusted.
 * Returns null for anything that is not a report.
 */
export function parseReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const source = text(b.source) as ClientErrorSource;
  if (!CLIENT_ERROR_SOURCES.includes(source)) return null;
  const message = scrubText(text(b.message), MAX_MESSAGE).trim();
  if (!message) return null;
  const stack = b.stack ? scrubText(text(b.stack), MAX_STACK) : null;
  const digest = b.digest ? text(b.digest).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || null : null;
  const viewport = b.viewport && /^\d{2,5}x\d{2,5}$/.test(text(b.viewport)) ? text(b.viewport) : null;
  return { source, path: scrubPath(text(b.path) || "/"), message, stack, digest, viewport };
}

// Noise that is not a bug in this app: browser extensions, a cancelled
// navigation, a chunk the browser failed to download on a dropped connection
// (the connection bar already covers that one).
const IGNORE = [
  /^Script error\.?$/i,
  /ResizeObserver loop/i,
  /chrome-extension:|moz-extension:|safari-web-extension:/i,
  /AbortError|The operation was aborted|The user aborted a request/i,
  /Load failed|Failed to fetch|NetworkError when attempting to fetch/i,
  /NEXT_REDIRECT|NEXT_NOT_FOUND/,
];
export function isNoise(r: Pick<ClientErrorReport, "message" | "stack">): boolean {
  return IGNORE.some((re) => re.test(r.message) || (r.stack ? re.test(r.stack.slice(0, 600)) : false));
}

export type ClientErrorGroup = { fingerprint: string; source: string; path: string; message: string; count: number; people: number; firstAt: string; lastAt: string; lastStack: string | null };

/** Rows (newest first) → one line per distinct crash, most frequent first. */
export function groupErrors(rows: Array<{ fingerprint: string; source: string; path: string; message: string; stack: string | null; userId: string | null; createdAt: Date | string }>): ClientErrorGroup[] {
  const groups = new Map<string, ClientErrorGroup & { users: Set<string> }>();
  for (const r of rows) {
    const at = new Date(r.createdAt).toISOString();
    const g = groups.get(r.fingerprint);
    if (!g) {
      groups.set(r.fingerprint, { fingerprint: r.fingerprint, source: r.source, path: r.path, message: r.message, count: 1, people: 0, firstAt: at, lastAt: at, lastStack: r.stack, users: new Set(r.userId ? [r.userId] : []) });
      continue;
    }
    g.count++;
    if (r.userId) g.users.add(r.userId);
    if (at < g.firstAt) g.firstAt = at;
    if (at > g.lastAt) { g.lastAt = at; g.lastStack = r.stack; }
  }
  return [...groups.values()]
    .map(({ users, ...g }) => ({ ...g, people: users.size }))
    .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1));
}
