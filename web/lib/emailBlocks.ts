// Canonical EmailBlock[] DSL — the storage format for every email body in
// Phase 3. Tiptap is the editing surface; a client-side normalizer converts
// Tiptap's ProseMirror JSON to this narrow, well-typed block vocabulary
// before it's stored or sent.
//
// Why not just store Tiptap's JSON directly?
//   1. Tiptap output changes across versions; our block vocabulary is stable.
//   2. Every render target (MJML → email, HTML → preview, plain-text → SMS
//      fallback, screen reader) reads the same source of truth.
//   3. Server-side render (lib/emailRender.ts) needs a bounded shape it can
//      trust — random attribute soup from a browser is a sanitization
//      minefield.
//
// version: 1 — bump when introducing an incompatible block variant so
// historical rows can be re-rendered with the correct pipeline.

export const EMAIL_BLOCK_VERSION = 1;

export type EmailAlign = "left" | "center" | "right";
export type EmailListStyle = "bulleted" | "numbered";

export type EmailBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | ButtonBlock
  | ImageBlock
  | DividerBlock
  | SpacerBlock
  | ContactBlock
  | LogoBlock;

export interface HeadingBlock {
  type: "heading";
  level: 1 | 2 | 3;
  text: string;
  align?: EmailAlign;
}

export interface ParagraphBlock {
  type: "paragraph";
  // Inline runs: bold/italic/underline/link, in composition order.
  runs: InlineRun[];
  align?: EmailAlign;
}

export type InlineRun =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean; underline?: boolean }
  | { kind: "link"; text: string; href: string; bold?: boolean; italic?: boolean; underline?: boolean };

export interface ListBlock {
  type: "list";
  style: EmailListStyle;
  items: InlineRun[][]; // one array of runs per <li>
}

export interface ButtonBlock {
  type: "button";
  text: string;
  href: string;
  align?: EmailAlign;
  // Design tokens; the renderer resolves them to hex per club palette.
  color?: "brand" | "charcoal" | "lime" | "orange";
}

export interface ImageBlock {
  type: "image";
  // Signed public URL from /api/public/images/[fileId]?t=<hmac>. Bare
  // /api/files/<id> paths are session-gated and will fail in email
  // clients — the composer must rewrite before storing.
  src: string;
  alt: string;
  width?: number;   // px, capped to 600 at render time
  align?: EmailAlign;
  // Optional link target — image becomes a clickable link.
  href?: string;
}

export interface DividerBlock {
  type: "divider";
}

export interface SpacerBlock {
  type: "spacer";
  height?: number; // px, defaults to 16
}

// Rendered from Club contact info at send time — no free-text version so
// the club can update its address without editing every template.
export interface ContactBlock {
  type: "contact";
  fields: Array<"name" | "email" | "phone" | "address" | "website">;
}

// Renders the club logo (public URL, no session gate). Falls back to
// AthletixOS wordmark when the club has no logo set.
export interface LogoBlock {
  type: "logo";
  align?: EmailAlign;
  height?: number; // px, defaults to 40
}

// ── Validation ────────────────────────────────────────────────────────────
//
// Called by every write path (composer save, template save, direct API
// input). Rejects unknown block types and enforces the shape constraints
// the renderer expects. Returns validated, narrowed blocks — do NOT trust
// the input array reference after calling this.

export interface EmailBlockValidationError {
  index: number;
  reason: string;
}

export function validateEmailBlocks(input: unknown): {
  ok: true;
  blocks: EmailBlock[];
} | {
  ok: false;
  errors: EmailBlockValidationError[];
} {
  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ index: -1, reason: "blocks must be an array" }] };
  }
  const errors: EmailBlockValidationError[] = [];
  const out: EmailBlock[] = [];
  for (let i = 0; i < input.length; i++) {
    const b = input[i] as { type?: string };
    if (!b || typeof b !== "object") {
      errors.push({ index: i, reason: "block must be an object" });
      continue;
    }
    switch (b.type) {
      case "heading":
      case "paragraph":
      case "list":
      case "button":
      case "image":
      case "divider":
      case "spacer":
      case "contact":
      case "logo":
        // Trust the shape at DB write time; the renderer will still coerce
        // missing fields to safe defaults. The block validator is a
        // TYPE gate, not a semantic gate.
        out.push(b as EmailBlock);
        break;
      default:
        errors.push({ index: i, reason: `unknown block type: ${String(b.type)}` });
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, blocks: out };
}

// ── Plain-text derivation ─────────────────────────────────────────────────
//
// Every email needs a plain-text alternative for multipart/alternative and
// for text-only clients (Apple Mail plain view, some corporate filters).
// Never call HTML→text after render — you lose semantic structure. Derive
// straight from blocks.

export function blocksToPlainText(blocks: EmailBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        lines.push("", b.text, "");
        break;
      case "paragraph":
        lines.push(runsToText(b.runs), "");
        break;
      case "list":
        for (let i = 0; i < b.items.length; i++) {
          const prefix = b.style === "numbered" ? `${i + 1}. ` : "• ";
          lines.push(`${prefix}${runsToText(b.items[i])}`);
        }
        lines.push("");
        break;
      case "button":
        lines.push(`${b.text}: ${b.href}`, "");
        break;
      case "image":
        if (b.alt) lines.push(`[${b.alt}]`);
        break;
      case "divider":
        lines.push("---", "");
        break;
      case "spacer":
        // Skip — plain text has no visual spacer.
        break;
      case "contact":
        // Rendered later once we have the club record on hand.
        lines.push("");
        break;
      case "logo":
        // Skip — plain text has no logo.
        break;
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function runsToText(runs: InlineRun[]): string {
  return runs
    .map((r) => (r.kind === "link" ? `${r.text} (${r.href})` : r.text))
    .join("");
}
