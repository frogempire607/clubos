// EmailBlock[] → MJML → Outlook-safe HTML with inlined styles.
//
// Every email body flows through here at SEND time (per-recipient, so
// personalization tokens resolved first) and the resulting HTML lands
// immutably on EmailSend.bodyHtml. We never re-render at read time — the
// stored HTML is the exact bytes the recipient's inbox got.
//
// Why mjml (not Tiptap's raw HTML, not react-email):
//   - Tiptap emits div+class output that dies in Outlook, Gmail clipped
//     mode, and Yahoo. Not fixable client-side.
//   - mjml compiles to nested table markup with mso-conditional wrappers,
//     inlined styles, and VML button fallbacks — the boring correct answer
//     that email teams (Litmus, HubSpot, Salesforce) have been shipping
//    for years.
//   - react-email is a valid alternative; mjml won because its component
//    vocabulary maps 1:1 to our EmailBlock DSL.
//
// The renderer is a pure function of (blocks, ctx). Deterministic — same
// inputs, byte-identical output. That property is what lets 3G history
// render the "why did this email look like this" reproducer, and what
// makes snapshot tests possible.
//
// Sanitization: sanitizeRichHtml() is called on the mjml-rendered HTML
// before returning, so any accidentally-embedded <script>/<iframe>/onclick
// attributes are stripped even though mjml itself doesn't emit them.

import mjml2html from "mjml";
import type { EmailBlock, InlineRun } from "@/lib/emailBlocks";
import { blocksToPlainText } from "@/lib/emailBlocks";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";

export interface EmailRenderContext {
  clubName: string;
  clubLogoUrl?: string | null;    // absolute, public URL (no session gate)
  clubContact?: {
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    website?: string | null;
  };
  // Absolute URL to the recipient's one-click unsubscribe endpoint.
  unsubscribeUrl?: string | null;
  // Physical mailing address for the CAN-SPAM footer.
  postalAddress: string;
  // Colors from Club.primaryColor when set; otherwise brand default.
  accentColor?: string | null;
}

const DEFAULT_ACCENT = "#6D5DF6";      // brand violet
const CHARCOAL = "#1F1F23";
const LIME = "#A3E635";
const ORANGE = "#FF6A00";
const MUTED = "#6B7280";
const BORDER = "#E5E7EB";
const BG_APP = "#F7F7F9";

export interface RenderedEmail {
  html: string;
  text: string;
  warnings: string[];
}

// mjml v5+ returns a Promise. We wait once per send, which is cheap
// (single-digit ms server-side).
export async function renderEmail(blocks: EmailBlock[], ctx: EmailRenderContext): Promise<RenderedEmail> {
  const accent = normalizeColor(ctx.accentColor) ?? DEFAULT_ACCENT;
  const inner = blocks.map((b) => renderBlock(b, ctx, accent)).filter(Boolean).join("\n");

  const mjmlSource = `
<mjml>
  <mj-head>
    <mj-title>${escapeXml(ctx.clubName)}</mj-title>
    <mj-preview></mj-preview>
    <mj-attributes>
      <mj-all font-family="Inter, Helvetica, Arial, sans-serif" />
      <mj-text color="${CHARCOAL}" font-size="15px" line-height="1.55" />
      <mj-button background-color="${accent}" color="#ffffff" border-radius="8px" font-size="14px" font-weight="600" inner-padding="12px 24px" />
    </mj-attributes>
    <mj-style inline="inline">
      a { color: ${accent}; }
      .aox-muted { color: ${MUTED}; font-size: 12px; line-height: 1.6; }
      .aox-footer a { color: ${MUTED}; }
    </mj-style>
  </mj-head>
  <mj-body background-color="${BG_APP}" width="600px">
    <mj-section background-color="#ffffff" padding="0">
      <mj-column>
        ${inner}
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="16px 28px" border-top="1px solid ${BORDER}">
      <mj-column>
        <mj-text css-class="aox-footer aox-muted">
          Sent by ${escapeHtml(ctx.clubName)} via AthletixOS<br />
          ${escapeHtml(ctx.postalAddress)}${ctx.unsubscribeUrl ? `<br /><a href="${escapeAttr(ctx.unsubscribeUrl)}">Unsubscribe from marketing email</a>` : ""}
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`.trim();

  const compiled = await mjml2html(mjmlSource, {
    validationLevel: "soft", // errors don't throw — we surface them as warnings
    keepComments: false,
    minify: false,
  });

  const warnings = (compiled.errors || []).map((e: { message: string }) => e.message);
  // Belt-and-suspenders: sanitize the mjml output. mjml never emits scripts
  // on its own, but the block INPUT is user-controlled (paragraph text can
  // contain literal <script> strings that mjml would emit as escaped text
  // — sanitize keeps this safe if a caller ever bypasses escapeHtml).
  const html = sanitizeRichHtml(compiled.html);
  const text = blocksToPlainText(blocks);
  return { html, text, warnings };
}

// ── Block renderers ───────────────────────────────────────────────────────

function renderBlock(b: EmailBlock, ctx: EmailRenderContext, accent: string): string {
  switch (b.type) {
    case "heading":
      return renderHeading(b.level, b.text, b.align);
    case "paragraph":
      return renderParagraph(b.runs, b.align);
    case "list":
      return renderList(b.style, b.items);
    case "button":
      return renderButton(b.text, b.href, b.align, resolveButtonColor(b.color, accent));
    case "image":
      return renderImage(b.src, b.alt, b.width, b.align, b.href);
    case "divider":
      return `<mj-divider border-color="${BORDER}" border-width="1px" padding="16px 28px" />`;
    case "spacer":
      return `<mj-spacer height="${clampInt(b.height ?? 16, 4, 96)}px" />`;
    case "contact":
      return renderContact(b.fields, ctx);
    case "logo":
      return renderLogo(b.align, b.height, ctx);
  }
}

function renderHeading(level: 1 | 2 | 3, text: string, align?: string): string {
  const sizes = { 1: "24px", 2: "20px", 3: "16px" } as const;
  const weights = { 1: "700", 2: "600", 3: "600" } as const;
  return `<mj-text padding="20px 28px 4px 28px" font-size="${sizes[level]}" font-weight="${weights[level]}" align="${escapeAttr(align ?? "left")}" color="${CHARCOAL}">${escapeHtml(text)}</mj-text>`;
}

function renderParagraph(runs: InlineRun[], align?: string): string {
  const html = runs.map(renderRun).join("");
  return `<mj-text padding="8px 28px" align="${escapeAttr(align ?? "left")}">${html}</mj-text>`;
}

function renderList(style: "bulleted" | "numbered", items: InlineRun[][]): string {
  const tag = style === "numbered" ? "ol" : "ul";
  const lis = items.map((runs) => `<li style="margin:4px 0">${runs.map(renderRun).join("")}</li>`).join("");
  return `<mj-text padding="8px 28px"><${tag} style="margin:0;padding-left:20px;color:${CHARCOAL};font-size:15px;line-height:1.55">${lis}</${tag}></mj-text>`;
}

function renderButton(text: string, href: string, align: string | undefined, color: string): string {
  return `<mj-button padding="16px 28px" align="${escapeAttr(align ?? "left")}" background-color="${color}" href="${escapeAttr(href)}">${escapeHtml(text)}</mj-button>`;
}

function renderImage(src: string, alt: string, width: number | undefined, align: string | undefined, href: string | undefined): string {
  const w = clampInt(width ?? 544, 40, 544);
  const hrefAttr = href ? ` href="${escapeAttr(href)}"` : "";
  return `<mj-image padding="12px 28px" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" width="${w}px" align="${escapeAttr(align ?? "left")}"${hrefAttr} />`;
}

function renderContact(fields: Array<"name" | "email" | "phone" | "address" | "website">, ctx: EmailRenderContext): string {
  const lines: string[] = [];
  if (fields.includes("name")) lines.push(escapeHtml(ctx.clubName));
  if (fields.includes("email") && ctx.clubContact?.email) lines.push(`<a href="mailto:${escapeAttr(ctx.clubContact.email)}">${escapeHtml(ctx.clubContact.email)}</a>`);
  if (fields.includes("phone") && ctx.clubContact?.phone) lines.push(escapeHtml(ctx.clubContact.phone));
  if (fields.includes("address") && ctx.clubContact?.address) lines.push(escapeHtml(ctx.clubContact.address));
  if (fields.includes("website") && ctx.clubContact?.website) lines.push(`<a href="${escapeAttr(ctx.clubContact.website)}">${escapeHtml(ctx.clubContact.website)}</a>`);
  if (!lines.length) return "";
  return `<mj-text padding="16px 28px" color="${MUTED}" font-size="13px">${lines.join("<br />")}</mj-text>`;
}

function renderLogo(align: string | undefined, height: number | undefined, ctx: EmailRenderContext): string {
  const h = clampInt(height ?? 40, 20, 120);
  const src = ctx.clubLogoUrl || "https://athletix-os.com/brand/icon.png";
  return `<mj-image padding="20px 28px 0 28px" src="${escapeAttr(src)}" alt="${escapeAttr(ctx.clubName)}" height="${h}px" align="${escapeAttr(align ?? "left")}" />`;
}

function renderRun(r: InlineRun): string {
  const styles: string[] = [];
  if (r.bold) styles.push("font-weight:600");
  if (r.italic) styles.push("font-style:italic");
  if (r.underline) styles.push("text-decoration:underline");
  const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";
  if (r.kind === "link") {
    return `<a href="${escapeAttr(r.href)}"${styleAttr}>${escapeHtml(r.text)}</a>`;
  }
  return styles.length ? `<span${styleAttr}>${escapeHtml(r.text)}</span>` : escapeHtml(r.text);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function resolveButtonColor(name: string | undefined, accent: string): string {
  switch (name) {
    case "charcoal": return CHARCOAL;
    case "lime":     return LIME;
    case "orange":   return ORANGE;
    case "brand":
    default:         return accent;
  }
}

function normalizeColor(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function escapeXml(s: string): string {
  return escapeHtml(s);
}
