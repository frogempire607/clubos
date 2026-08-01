"use client";

// Rich email composer — Phase 3B.
//
// The store-format is the canonical EmailBlock[] DSL in lib/emailBlocks.ts,
// NOT tiptap's ProseMirror JSON. That's the point of the whole exercise:
//   1. The renderer is a pure function of (blocks, ctx). Deterministic
//      output means 3G history can render "why did this email look like
//      this" for years.
//   2. Every render target (email HTML, plain-text fallback, preview,
//      screen reader) reads the same source of truth.
//   3. Tiptap upgrades never change what the server stores.
//
// This means the composer is NOT a monolithic tiptap editor with a big
// serializer. It's a linear list of typed blocks. Only the two blocks
// that need in-line rich text (paragraph + list) use tiptap under the
// hood — and even then, they emit InlineRun[] directly rather than round-
// tripping through PM JSON. Every other block (heading, button, image,
// divider, spacer, contact, logo) has a plain form control.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Link as LinkIcon,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  MousePointerClick,
  ImageIcon,
  Minus,
  ArrowDownUp,
  Contact,
  Image as LogoIcon,
  Trash2,
  ChevronUp,
  ChevronDown,
  Plus,
  Monitor,
  Smartphone,
} from "lucide-react";
import type {
  EmailBlock,
  HeadingBlock,
  ParagraphBlock,
  ListBlock,
  ButtonBlock,
  ImageBlock,
  SpacerBlock,
  ContactBlock,
  LogoBlock,
  InlineRun,
  EmailAlign,
} from "@/lib/emailBlocks";

// ─────────────────────────────────────────────────────────────────────────
// Props + top-level component
// ─────────────────────────────────────────────────────────────────────────

export interface EmailComposerProps {
  initialSubject?: string;
  initialPreviewText?: string;
  initialBlocks?: EmailBlock[];
  onChange?: (state: { subject: string; previewText: string; blocks: EmailBlock[] }) => void;
  // Called by "Send test" button. Composer stays open so the sender can
  // iterate. Return an optional { message } to override the default
  // "Test email sent" toast (e.g. include the delivery address).
  onSendTest?: (state: { subject: string; previewText: string; blocks: EmailBlock[] }) =>
    | Promise<void | { message?: string }>
    | void
    | { message?: string };
}

// What the composer needs to know about the club to warn the sender
// that certain contact-block fields (or the logo) will render empty at
// send time. Fetched once from /api/club/info.
interface ClubContactInfo {
  hasLogo: boolean;
  // Resolved public-facing email/phone (publicEmail if set, else
  // contactEmail; same for phone). Truthy when the Contact block will
  // actually render a line for that field.
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  // Whether the club has a complete-enough mailing address to render in
  // the Contact block. Reads formatClubMailingAddress on the server —
  // partial addresses count as false so the composer warning matches
  // what the renderer does.
  hasMailingAddress: boolean;
}

export default function EmailComposer({
  initialSubject = "",
  initialPreviewText = "",
  initialBlocks,
  onChange,
  onSendTest,
}: EmailComposerProps) {
  const [subject, setSubject] = useState(initialSubject);
  const [previewText, setPreviewText] = useState(initialPreviewText);
  const [blocks, setBlocks] = useState<EmailBlock[]>(() => initialBlocks ?? defaultBlocks());
  const [preview, setPreview] = useState<"desktop" | "mobile" | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [clubInfo, setClubInfo] = useState<ClubContactInfo | null>(null);

  // Fetch club contact info once so the Contact + Logo editors can warn
  // the sender if a requested field will render empty (contactEmail null,
  // contactPhone null, no logoUrl, etc.). Silent failure → editors just
  // don't render the warning; the compose experience still works.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/club/info");
        if (!res.ok) return;
        const c = await res.json();
        if (!alive) return;
        // The Contact block prefers publicEmail / publicPhone (member-
        // facing) over contactEmail / contactPhone (admin destination).
        // Mirror that fallback here so the composer's per-field "empty"
        // warning matches what actually renders at send time.
        const resolvedEmail = c?.publicEmail ?? c?.contactEmail ?? null;
        const resolvedPhone = c?.publicPhone ?? c?.contactPhone ?? null;
        // Address completeness gate mirrors formatClubMailingAddress:
        // street line + city + (state OR zip). Half-filled rows count
        // as unset so a "missing" warning fires when the renderer would
        // silently drop the line.
        const hasAddress = Boolean(
          c?.mailingAddress && c?.mailingCity && (c?.mailingState || c?.mailingZip),
        );
        setClubInfo({
          hasLogo: Boolean(c?.logoUrl),
          contactEmail: resolvedEmail,
          contactPhone: resolvedPhone,
          websiteUrl: c?.websiteUrl ?? null,
          hasMailingAddress: hasAddress,
        });
      } catch {
        // best-effort; leave clubInfo null
      }
    })();
    return () => { alive = false; };
  }, []);

  // Bubble state to the caller on every meaningful change. Debounce lightly
  // so a fast typer doesn't flood the parent.
  useEffect(() => {
    if (!onChange) return;
    const t = setTimeout(() => onChange({ subject, previewText, blocks }), 150);
    return () => clearTimeout(t);
  }, [subject, previewText, blocks, onChange]);

  const updateBlock = useCallback(<T extends EmailBlock>(idx: number, patch: Partial<T>) => {
    setBlocks((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch } as EmailBlock;
      return next;
    });
  }, []);

  const removeBlock = useCallback((idx: number) => {
    setBlocks((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const moveBlock = useCallback((idx: number, dir: -1 | 1) => {
    setBlocks((prev) => {
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [b] = next.splice(idx, 1);
      next.splice(target, 0, b);
      return next;
    });
  }, []);

  const insertBlock = useCallback((block: EmailBlock, atIdx?: number) => {
    setBlocks((prev) => {
      const insertAt = atIdx ?? prev.length;
      const next = prev.slice();
      next.splice(insertAt, 0, block);
      return next;
    });
  }, []);

  async function handleSendTest() {
    if (!onSendTest) return;
    setTestMsg(null);
    try {
      const result = await onSendTest({ subject, previewText, blocks });
      const custom = result && typeof result === "object" ? result.message : null;
      setTestMsg({ ok: true, text: custom || "Test email sent — check your inbox." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestMsg({ ok: false, text: `Test send failed: ${msg}` });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Subject + preview text — always required, never a block. */}
      <div className="bg-surface border border-app-border rounded-xl p-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Practice canceled tonight"
            maxLength={300}
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">
            Preview text <span className="text-text-muted normal-case">— shown in the inbox list, before the recipient opens the email</span>
          </label>
          <input
            type="text"
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            placeholder="No practice tonight, back on Thursday."
            maxLength={200}
            className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
          />
        </div>
      </div>

      {/* Block list */}
      <div className="bg-surface border border-app-border rounded-xl">
        <div className="px-4 py-3 border-b border-app-border flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">Message content</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPreview(preview === "desktop" ? null : "desktop")}
              className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${preview === "desktop" ? "bg-charcoal text-white border-charcoal" : "border-app-border text-text-primary hover:bg-app-bg"}`}
              type="button"
            >
              <Monitor className="h-3.5 w-3.5" /> Desktop preview
            </button>
            <button
              onClick={() => setPreview(preview === "mobile" ? null : "mobile")}
              className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${preview === "mobile" ? "bg-charcoal text-white border-charcoal" : "border-app-border text-text-primary hover:bg-app-bg"}`}
              type="button"
            >
              <Smartphone className="h-3.5 w-3.5" /> Mobile preview
            </button>
            {onSendTest && (
              <button
                onClick={handleSendTest}
                className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover"
                type="button"
              >
                Send test
              </button>
            )}
          </div>
        </div>

        {testMsg && (
          <div className={`mx-4 mt-3 rounded-lg px-3 py-2 text-xs ${testMsg.ok ? "bg-lime-accent/20 text-charcoal border border-lime-accent" : "bg-red-50 text-red-700 border border-red-200"}`}>
            {testMsg.text}
          </div>
        )}

        <div className="p-4 space-y-3">
          {blocks.length === 0 && (
            <div className="text-sm text-text-muted text-center py-8 border border-dashed border-app-border rounded-lg">
              This message is empty. Add a block below to get started.
            </div>
          )}
          {blocks.map((block, idx) => (
            <BlockCard
              key={idx}
              block={block}
              first={idx === 0}
              last={idx === blocks.length - 1}
              clubInfo={clubInfo}
              onUpdate={(patch) => updateBlock(idx, patch)}
              onRemove={() => removeBlock(idx)}
              onMove={(dir) => moveBlock(idx, dir)}
            />
          ))}

          <BlockPicker onAdd={(b) => insertBlock(b)} />
        </div>
      </div>

      {/* Preview panel */}
      {preview && (
        <div className="bg-surface border border-app-border rounded-xl">
          <div className="px-4 py-3 border-b border-app-border flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-primary">
              Preview — {preview === "desktop" ? "desktop" : "mobile (375px)"}
            </h3>
            <button
              onClick={() => setPreview(null)}
              className="text-xs text-text-muted hover:text-text-primary"
              type="button"
            >
              Close
            </button>
          </div>
          <div className="p-4 bg-app-bg">
            <BlocksPreview
              subject={subject}
              previewText={previewText}
              blocks={blocks}
              width={preview === "mobile" ? 375 : 600}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Default starter blocks — new composer opens with something useful.
// ─────────────────────────────────────────────────────────────────────────

function defaultBlocks(): EmailBlock[] {
  return [
    { type: "logo", align: "left", width: 160 } as LogoBlock,
    { type: "heading", level: 1, text: "Hi there,", align: "left" } as HeadingBlock,
    {
      type: "paragraph",
      align: "left",
      runs: [{ kind: "text", text: "Write your message here…" }],
    } as ParagraphBlock,
    { type: "contact", fields: ["name", "email", "phone"] } as ContactBlock,
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// One card per block
// ─────────────────────────────────────────────────────────────────────────

function BlockCard(props: {
  block: EmailBlock;
  first: boolean;
  last: boolean;
  clubInfo: ClubContactInfo | null;
  onUpdate: (patch: Partial<EmailBlock>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const { block, first, last, clubInfo, onUpdate, onRemove, onMove } = props;
  return (
    <div className="border border-app-border rounded-lg bg-app-bg/40">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border">
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {blockLabel(block)}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={first}
            onClick={() => onMove(-1)}
            className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
            aria-label="Move up"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={last}
            onClick={() => onMove(1)}
            className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
            aria-label="Move down"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-1 text-text-muted hover:text-red-600"
            aria-label="Remove block"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="p-3">
        <BlockEditor block={block} clubInfo={clubInfo} onUpdate={onUpdate} />
      </div>
    </div>
  );
}

function blockLabel(b: EmailBlock): string {
  switch (b.type) {
    case "heading": return `Heading ${b.level}`;
    case "paragraph": return "Paragraph";
    case "list": return b.style === "numbered" ? "Numbered list" : "Bulleted list";
    case "button": return "Button";
    case "image": return "Image";
    case "divider": return "Divider";
    case "spacer": return "Spacer";
    case "contact": return "Contact info";
    case "logo": return "Club logo";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-block editors
// ─────────────────────────────────────────────────────────────────────────

function BlockEditor({
  block,
  clubInfo,
  onUpdate,
}: {
  block: EmailBlock;
  clubInfo: ClubContactInfo | null;
  onUpdate: (p: Partial<EmailBlock>) => void;
}) {
  switch (block.type) {
    case "heading":
      return <HeadingEditor block={block} onUpdate={(p) => onUpdate(p)} />;
    case "paragraph":
      return <ParagraphEditor block={block} onUpdate={(p) => onUpdate(p)} />;
    case "list":
      return <ListEditor block={block} onUpdate={(p) => onUpdate(p)} />;
    case "button":
      return <ButtonEditor block={block} onUpdate={(p) => onUpdate(p)} />;
    case "image":
      return <ImageEditor block={block} onUpdate={(p) => onUpdate(p)} />;
    case "divider":
      return <p className="text-xs text-text-muted italic">Renders as a horizontal rule.</p>;
    case "spacer":
      return <SpacerEditor block={block} onUpdate={(p) => onUpdate(p)} />;
    case "contact":
      return <ContactEditor block={block} clubInfo={clubInfo} onUpdate={(p) => onUpdate(p)} />;
    case "logo":
      return <LogoEditor block={block} clubInfo={clubInfo} onUpdate={(p) => onUpdate(p)} />;
  }
}

function HeadingEditor({ block, onUpdate }: { block: HeadingBlock; onUpdate: (p: Partial<HeadingBlock>) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <AlignPicker value={block.align ?? "left"} onChange={(align) => onUpdate({ align })} />
        <select
          value={block.level}
          onChange={(e) => onUpdate({ level: Number(e.target.value) as 1 | 2 | 3 })}
          className="text-xs border border-app-border rounded px-2 py-1 bg-surface"
        >
          <option value={1}>H1 — largest</option>
          <option value={2}>H2 — subheading</option>
          <option value={3}>H3 — smaller</option>
        </select>
      </div>
      <input
        type="text"
        value={block.text}
        onChange={(e) => onUpdate({ text: e.target.value })}
        className="w-full px-3 py-2 border border-app-border rounded-lg text-lg font-semibold bg-surface"
        placeholder="Heading text"
      />
    </div>
  );
}

// The paragraph editor is the ONE block that uses tiptap. Tiptap manages
// its own state; we serialize its content into InlineRun[] whenever it
// changes and store that. Round-tripping stored runs → HTML → tiptap on
// mount ensures the paragraph reloads exactly as it was.
function ParagraphEditor({ block, onUpdate }: { block: ParagraphBlock; onUpdate: (p: Partial<ParagraphBlock>) => void }) {
  return (
    <div className="space-y-2">
      <AlignPicker value={block.align ?? "left"} onChange={(align) => onUpdate({ align })} />
      <RichTextField
        value={block.runs}
        onChange={(runs) => onUpdate({ runs })}
        placeholder="Write your paragraph…"
        multiline
      />
    </div>
  );
}

function ListEditor({ block, onUpdate }: { block: ListBlock; onUpdate: (p: Partial<ListBlock>) => void }) {
  function addItem() {
    onUpdate({ items: [...block.items, [{ kind: "text", text: "" }]] });
  }
  function removeItem(idx: number) {
    onUpdate({ items: block.items.filter((_, i) => i !== idx) });
  }
  function updateItem(idx: number, runs: InlineRun[]) {
    const next = block.items.slice();
    next[idx] = runs;
    onUpdate({ items: next });
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={block.style}
          onChange={(e) => onUpdate({ style: e.target.value as "bulleted" | "numbered" })}
          className="text-xs border border-app-border rounded px-2 py-1 bg-surface"
        >
          <option value="bulleted">Bulleted</option>
          <option value="numbered">Numbered</option>
        </select>
      </div>
      <div className="space-y-2">
        {block.items.map((runs, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="text-text-muted mt-1.5 select-none w-4 text-right">
              {block.style === "numbered" ? `${i + 1}.` : "•"}
            </span>
            <div className="flex-1">
              <RichTextField
                value={runs}
                onChange={(rr) => updateItem(i, rr)}
                placeholder="Item…"
                multiline={false}
              />
            </div>
            <button
              type="button"
              onClick={() => removeItem(i)}
              className="p-1 text-text-muted hover:text-red-600"
              aria-label="Remove item"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addItem}
        className="text-xs px-2 py-1 border border-app-border rounded-md text-text-primary hover:bg-app-bg"
      >
        + Add item
      </button>
    </div>
  );
}

function ButtonEditor({ block, onUpdate }: { block: ButtonBlock; onUpdate: (p: Partial<ButtonBlock>) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <AlignPicker value={block.align ?? "left"} onChange={(align) => onUpdate({ align })} />
        <select
          value={block.color ?? "brand"}
          onChange={(e) => onUpdate({ color: e.target.value as ButtonBlock["color"] })}
          className="text-xs border border-app-border rounded px-2 py-1 bg-surface"
        >
          <option value="brand">Brand color</option>
          <option value="charcoal">Charcoal</option>
          <option value="lime">Lime</option>
          <option value="orange">Orange</option>
        </select>
      </div>
      <input
        type="text"
        value={block.text}
        onChange={(e) => onUpdate({ text: e.target.value })}
        placeholder="Button label"
        className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
      />
      <input
        type="url"
        value={block.href}
        onChange={(e) => onUpdate({ href: e.target.value })}
        placeholder="https://example.com/register"
        className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
      />
    </div>
  );
}

function ImageEditor({ block, onUpdate }: { block: ImageBlock; onUpdate: (p: Partial<ImageBlock>) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("type", "image");
      const up = await fetch("/api/upload", { method: "POST", body });
      const upBody = await up.json().catch(() => ({}));
      if (!up.ok) throw new Error(typeof upBody?.error === "string" ? upBody.error : "Upload failed");

      // Convert the session-gated /api/files/[id] URL into a signed
      // /api/public/images/[fileId] URL that email clients can fetch
      // without a session.
      const sign = await fetch("/api/emails/image-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: upBody.id }),
      });
      const signBody = await sign.json().catch(() => ({}));
      if (!sign.ok) throw new Error(typeof signBody?.error === "string" ? signBody.error : "Could not sign image URL");
      onUpdate({ src: signBody.url });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <AlignPicker value={block.align ?? "left"} onChange={(align) => onUpdate({ align })} />
        <label className="text-xs text-text-muted">Width</label>
        <input
          type="number"
          value={block.width ?? 544}
          onChange={(e) => onUpdate({ width: Number(e.target.value) })}
          min={40}
          max={544}
          className="w-20 text-xs border border-app-border rounded px-2 py-1 bg-surface"
        />
        <span className="text-xs text-text-muted">px</span>
      </div>

      {block.src ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={block.src}
            alt={block.alt || "Preview"}
            className="max-h-32 border border-app-border rounded"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
          <button
            type="button"
            onClick={() => onUpdate({ src: "" })}
            className="text-xs text-red-500 hover:text-red-700"
          >
            Replace
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="text-sm px-3 py-2 border border-dashed border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50 w-full"
        >
          {busy ? "Uploading…" : "Choose image"}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={upload}
      />
      {err && <p className="text-xs text-red-600">{err}</p>}

      <input
        type="text"
        value={block.alt}
        onChange={(e) => onUpdate({ alt: e.target.value })}
        placeholder="Alt text (for accessibility — describe the image)"
        className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
      />
      <input
        type="url"
        value={block.href ?? ""}
        onChange={(e) => onUpdate({ href: e.target.value || undefined })}
        placeholder="Optional link URL"
        className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
      />
    </div>
  );
}

function SpacerEditor({ block, onUpdate }: { block: SpacerBlock; onUpdate: (p: Partial<SpacerBlock>) => void }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-text-muted">Height</label>
      <input
        type="number"
        value={block.height ?? 16}
        onChange={(e) => onUpdate({ height: Number(e.target.value) })}
        min={4}
        max={96}
        className="w-20 text-xs border border-app-border rounded px-2 py-1 bg-surface"
      />
      <span className="text-xs text-text-muted">px</span>
    </div>
  );
}

const CONTACT_FIELDS = ["name", "email", "phone", "address", "website"] as const;
function ContactEditor({
  block,
  clubInfo,
  onUpdate,
}: {
  block: ContactBlock;
  clubInfo: ClubContactInfo | null;
  onUpdate: (p: Partial<ContactBlock>) => void;
}) {
  function toggle(field: typeof CONTACT_FIELDS[number]) {
    const set = new Set(block.fields);
    if (set.has(field)) set.delete(field);
    else set.add(field);
    onUpdate({ fields: CONTACT_FIELDS.filter((f) => set.has(f)) });
  }

  // A selected field renders empty at send time when the corresponding
  // club setting is missing. The renderer silently drops missing fields
  // (a fake placeholder would ship an obviously-templated email) — but
  // the sender needs to know at COMPOSE time so they can fix Settings
  // or remove the field.
  function fieldStatus(f: typeof CONTACT_FIELDS[number]): "ok" | "missing" {
    if (!block.fields.includes(f)) return "ok";
    if (!clubInfo) return "ok"; // still loading — don't flash warnings
    switch (f) {
      case "name":    return "ok"; // club always has a name
      case "email":   return clubInfo.contactEmail ? "ok" : "missing";
      case "phone":   return clubInfo.contactPhone ? "ok" : "missing";
      case "website": return clubInfo.websiteUrl ? "ok" : "missing";
      case "address": return clubInfo.hasMailingAddress ? "ok" : "missing";
    }
  }

  const missing = CONTACT_FIELDS.filter((f) => fieldStatus(f) === "missing");

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        Pulled from your club settings at send time — never hand-typed here so the address stays correct when it changes.
      </p>
      <div className="flex flex-wrap gap-2">
        {CONTACT_FIELDS.map((f) => {
          const active = block.fields.includes(f);
          const status = fieldStatus(f);
          const warn = active && status !== "ok";
          return (
            <button
              key={f}
              type="button"
              onClick={() => toggle(f)}
              className={`text-xs px-2 py-1 rounded-md border ${
                active
                  ? warn
                    ? "bg-orange-accent/20 text-charcoal border-orange-accent"
                    : "bg-charcoal text-white border-charcoal"
                  : "border-app-border text-text-primary hover:bg-app-bg"
              }`}
            >
              {f}
              {warn && <span className="ml-1">(empty)</span>}
            </button>
          );
        })}
      </div>
      {missing.length > 0 && (
        <div className="text-xs text-orange-accent bg-orange-accent/10 border border-orange-accent/30 rounded-md px-2 py-1.5">
          <span className="font-medium">Not set on this club:</span> {missing.join(", ")}. These will not render — set them in <span className="underline">Settings → Club</span> or remove the field.
        </div>
      )}
    </div>
  );
}

function LogoEditor({
  block,
  clubInfo,
  onUpdate,
}: {
  block: LogoBlock;
  clubInfo: ClubContactInfo | null;
  onUpdate: (p: Partial<LogoBlock>) => void;
}) {
  const usingFallback = clubInfo ? !clubInfo.hasLogo : false;
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        Renders your club logo (or the AthletixOS mark when unset).
      </p>
      {usingFallback && (
        <div className="text-xs text-orange-accent bg-orange-accent/10 border border-orange-accent/30 rounded-md px-2 py-1.5">
          <span className="font-medium">No club logo set</span> — this block will render the AthletixOS mark. Upload your logo in <span className="underline">Settings → Club</span>.
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <AlignPicker value={block.align ?? "left"} onChange={(align) => onUpdate({ align })} />
        <label className="text-xs text-text-muted">Width</label>
        <input
          type="number"
          value={block.width ?? ""}
          placeholder="auto"
          onChange={(e) => {
            const v = e.target.value;
            onUpdate({ width: v === "" ? undefined : Number(v) });
          }}
          min={40}
          max={544}
          className="w-20 text-xs border border-app-border rounded px-2 py-1 bg-surface"
        />
        <span className="text-xs text-text-muted">px</span>
        <label className="text-xs text-text-muted ml-2">Max height</label>
        <input
          type="number"
          value={block.height ?? ""}
          placeholder="auto"
          onChange={(e) => {
            const v = e.target.value;
            onUpdate({ height: v === "" ? undefined : Number(v) });
          }}
          min={20}
          max={400}
          className="w-20 text-xs border border-app-border rounded px-2 py-1 bg-surface"
        />
        <span className="text-xs text-text-muted">px</span>
      </div>
      <p className="text-[11px] text-text-muted">
        Set width to size the logo — height auto-scales. Add a max height to cap tall/square logos. Aspect ratio is always preserved.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Alignment picker (reused across heading/paragraph/button/image/logo)
// ─────────────────────────────────────────────────────────────────────────

function AlignPicker({ value, onChange }: { value: EmailAlign; onChange: (v: EmailAlign) => void }) {
  return (
    <div className="inline-flex rounded-md border border-app-border overflow-hidden">
      {(["left", "center", "right"] as EmailAlign[]).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`text-xs px-2 py-1 ${value === v ? "bg-charcoal text-white" : "bg-surface text-text-primary hover:bg-app-bg"}`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Rich-text field (paragraph + list items) — the ONE place tiptap runs.
// We serialize its content to InlineRun[] and store that; the paragraph
// block is one <p>, list items are one item each (multiline=false).
// ─────────────────────────────────────────────────────────────────────────

function RichTextField(props: {
  value: InlineRun[];
  onChange: (runs: InlineRun[]) => void;
  placeholder?: string;
  multiline: boolean;
}) {
  const { value, onChange, multiline, placeholder } = props;

  // The ONE source of truth is InlineRun[] in the parent. We mount the
  // editor with the HTML derived from `value` and only push updates back
  // out on tiptap events. We deliberately don't re-mount tiptap when the
  // parent re-renders with a new-but-equal runs array — that would blow
  // away cursor position on every keystroke.
  const initialHtml = useMemo(() => runsToHtml(value), []); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    // App-wide SSR — silence the flush hydration warning.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: multiline ? undefined : false,
        orderedList: multiline ? undefined : false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        strike: false,
        hardBreak: multiline ? undefined : false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noopener", target: "_blank" },
      }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[2.5rem] px-3 py-2",
      },
    },
    onUpdate: ({ editor: ed }) => {
      const runs = htmlToRuns(ed.getHTML());
      onChange(runs);
    },
  });

  if (!editor) {
    return (
      <div className="border border-app-border rounded-lg bg-surface px-3 py-2 text-sm text-text-muted">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="border border-app-border rounded-lg bg-surface">
      <RichTextToolbar editor={editor} />
      <EditorContent editor={editor} placeholder={placeholder} />
    </div>
  );
}

function RichTextToolbar({ editor }: { editor: Editor }) {
  const btn = "p-1.5 rounded hover:bg-app-bg text-text-primary disabled:opacity-40";
  const active = "bg-charcoal text-white hover:bg-charcoal-hover";
  function setLink() {
    const url = window.prompt("Link URL", editor.getAttributes("link")?.href ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }
  return (
    <div className="flex items-center gap-0.5 px-1 py-1 border-b border-app-border">
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={`${btn} ${editor.isActive("bold") ? active : ""}`}
        aria-label="Bold"
      >
        <Bold className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={`${btn} ${editor.isActive("italic") ? active : ""}`}
        aria-label="Italic"
      >
        <Italic className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={`${btn} ${editor.isActive("underline") ? active : ""}`}
        aria-label="Underline"
      >
        <UnderlineIcon className="h-4 w-4" />
      </button>
      <div className="w-px h-4 bg-app-border mx-1" />
      <button
        type="button"
        onClick={setLink}
        className={`${btn} ${editor.isActive("link") ? active : ""}`}
        aria-label="Link"
      >
        <LinkIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Block picker — the "insert" bar under the block list.
// ─────────────────────────────────────────────────────────────────────────

function BlockPicker({ onAdd }: { onAdd: (b: EmailBlock) => void }) {
  const options: Array<{ label: string; icon: React.ComponentType<{ className?: string }>; make: () => EmailBlock }> = [
    { label: "Heading", icon: Heading1, make: () => ({ type: "heading", level: 2, text: "New heading" }) },
    { label: "Subheading", icon: Heading2, make: () => ({ type: "heading", level: 3, text: "New subheading" }) },
    { label: "Paragraph", icon: Heading3, make: () => ({ type: "paragraph", runs: [{ kind: "text", text: "" }] }) },
    { label: "Bulleted list", icon: List, make: () => ({ type: "list", style: "bulleted", items: [[{ kind: "text", text: "" }]] }) },
    { label: "Numbered list", icon: ListOrdered, make: () => ({ type: "list", style: "numbered", items: [[{ kind: "text", text: "" }]] }) },
    { label: "Button", icon: MousePointerClick, make: () => ({ type: "button", text: "Register now", href: "https://" }) },
    { label: "Image", icon: ImageIcon, make: () => ({ type: "image", src: "", alt: "" }) },
    { label: "Divider", icon: Minus, make: () => ({ type: "divider" }) },
    { label: "Spacer", icon: ArrowDownUp, make: () => ({ type: "spacer", height: 16 }) },
    { label: "Contact info", icon: Contact, make: () => ({ type: "contact", fields: ["name", "email", "phone"] }) },
    { label: "Club logo", icon: LogoIcon, make: () => ({ type: "logo", align: "left", width: 160 }) },
  ];
  return (
    <div className="pt-3 border-t border-app-border">
      <p className="text-xs text-text-muted mb-2">
        <Plus className="inline h-3 w-3 mr-1" />
        Insert block
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => onAdd(o.make())}
            className="text-xs px-2 py-1.5 rounded-md border border-app-border text-text-primary hover:bg-app-bg flex items-center gap-1.5"
          >
            <o.icon className="h-3.5 w-3.5" />
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Preview — a lightweight, block-by-block renderer for the composer only.
// The REAL send uses lib/emailRender.ts (MJML → Outlook-safe HTML). This
// preview isn't email-client-accurate — it's a "is this what I meant"
// gut check for the sender. Byte-accurate preview would ship the full
// MJML render pipeline to the client.
// ─────────────────────────────────────────────────────────────────────────

function BlocksPreview(props: { subject: string; previewText: string; blocks: EmailBlock[]; width: number }) {
  const { subject, previewText, blocks, width } = props;
  return (
    <div className="mx-auto bg-white shadow-sm" style={{ width, maxWidth: "100%" }}>
      <div className="border-b border-app-border px-4 py-3 bg-app-bg">
        <div className="text-sm font-semibold text-text-primary">
          {subject || <span className="italic text-text-muted">No subject</span>}
        </div>
        {previewText && (
          <div className="text-xs text-text-muted mt-0.5">{previewText}</div>
        )}
      </div>
      <div className="px-4 py-4 space-y-3">
        {blocks.map((b, i) => (
          <PreviewBlock key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

function PreviewBlock({ block }: { block: EmailBlock }) {
  const align = "align" in block ? (block.align ?? "left") : "left";
  switch (block.type) {
    case "heading": {
      const sizes = { 1: "text-2xl", 2: "text-xl", 3: "text-base" } as const;
      const weights = { 1: "font-bold", 2: "font-semibold", 3: "font-semibold" } as const;
      return (
        <div style={{ textAlign: align }} className={`${sizes[block.level]} ${weights[block.level]} text-charcoal`}>
          {block.text || <span className="italic text-text-muted">Heading text</span>}
        </div>
      );
    }
    case "paragraph":
      return (
        <div style={{ textAlign: align }} className="text-sm text-text-primary leading-relaxed">
          {runsToPreview(block.runs)}
        </div>
      );
    case "list": {
      const Tag = block.style === "numbered" ? "ol" : "ul";
      return (
        <Tag className={`pl-6 text-sm text-text-primary ${block.style === "numbered" ? "list-decimal" : "list-disc"}`}>
          {block.items.map((runs, i) => (
            <li key={i}>{runsToPreview(runs)}</li>
          ))}
        </Tag>
      );
    }
    case "button": {
      const bg = block.color === "lime" ? "bg-lime-accent text-charcoal" :
                 block.color === "orange" ? "bg-orange-accent text-white" :
                 block.color === "charcoal" ? "bg-charcoal text-white" :
                 "bg-brand text-white";
      return (
        <div style={{ textAlign: align }}>
          <span className={`inline-block px-6 py-3 rounded-lg text-sm font-semibold ${bg}`}>
            {block.text || "Button"}
          </span>
        </div>
      );
    }
    case "image":
      if (!block.src) {
        return (
          <div className="border-2 border-dashed border-app-border rounded p-4 text-xs text-text-muted text-center">
            No image chosen
          </div>
        );
      }
      return (
        <div style={{ textAlign: align }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={block.src} alt={block.alt} style={{ maxWidth: block.width ?? 544 }} className="inline-block" />
        </div>
      );
    case "divider":
      return <hr className="border-app-border" />;
    case "spacer":
      return <div style={{ height: block.height ?? 16 }} />;
    case "contact":
      return (
        <div className="text-xs text-text-muted italic">
          Contact info ({block.fields.join(", ") || "no fields selected"}) — rendered from your club settings at send time.
        </div>
      );
    case "logo": {
      const dims = [
        block.width ? `w:${block.width}` : null,
        block.height ? `h:${block.height}` : null,
      ].filter(Boolean).join(" · ") || "auto";
      return (
        <div style={{ textAlign: align }} className="text-xs text-text-muted italic">
          [Club logo · {dims}px]
        </div>
      );
    }
  }
}

function runsToPreview(runs: InlineRun[]): React.ReactNode {
  return runs.map((r, i) => {
    const style: React.CSSProperties = {};
    if (r.bold) style.fontWeight = 600;
    if (r.italic) style.fontStyle = "italic";
    if (r.underline) style.textDecoration = "underline";
    if (r.kind === "link") {
      return (
        <a key={i} href={r.href} className="text-brand underline" style={style} target="_blank" rel="noreferrer">
          {r.text}
        </a>
      );
    }
    return <span key={i} style={style}>{r.text}</span>;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// InlineRun ↔ HTML — the ONLY normalizer, kept tiny + tested at the
// boundary. Tiptap gets HTML in, gives HTML back; we translate to the
// canonical InlineRun[] format the DSL requires.
// ─────────────────────────────────────────────────────────────────────────

export function runsToHtml(runs: InlineRun[]): string {
  return runs
    .map((r) => {
      let inner = escapeHtml(r.text);
      if (r.bold) inner = `<strong>${inner}</strong>`;
      if (r.italic) inner = `<em>${inner}</em>`;
      if (r.underline) inner = `<u>${inner}</u>`;
      if (r.kind === "link") {
        return `<a href="${escapeAttr(r.href)}" target="_blank" rel="noopener">${inner}</a>`;
      }
      return inner;
    })
    .join("");
}

// htmlToRuns is deliberately DOM-based (browser only). Tiptap always
// emits HTML in the browser; there's no SSR/server call for this.
export function htmlToRuns(html: string): InlineRun[] {
  if (typeof document === "undefined") {
    // SSR safety — should never be called server-side.
    return [{ kind: "text", text: stripTags(html) }];
  }
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return [];

  const runs: InlineRun[] = [];
  walk(root, { bold: false, italic: false, underline: false, href: null }, runs);

  // Consolidate consecutive identically-formatted runs.
  return consolidate(runs);
}

function walk(node: Node, ctx: { bold: boolean; italic: boolean; underline: boolean; href: string | null }, out: InlineRun[]) {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      if (!text) return;
      if (ctx.href) {
        out.push({ kind: "link", text, href: ctx.href, bold: ctx.bold || undefined, italic: ctx.italic || undefined, underline: ctx.underline || undefined });
      } else {
        out.push({ kind: "text", text, bold: ctx.bold || undefined, italic: ctx.italic || undefined, underline: ctx.underline || undefined });
      }
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    const next = { ...ctx };
    if (tag === "strong" || tag === "b") next.bold = true;
    if (tag === "em" || tag === "i") next.italic = true;
    if (tag === "u") next.underline = true;
    if (tag === "a") next.href = el.getAttribute("href") ?? ctx.href;
    if (tag === "br") {
      out.push({ kind: "text", text: "\n" });
      return;
    }
    // Paragraphs and list items are treated as top-level runs by the
    // callers of this function; if the parent already scopes them, we
    // just walk the children.
    walk(el, next, out);
  });
}

function consolidate(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === r.kind &&
      last.bold === r.bold &&
      last.italic === r.italic &&
      last.underline === r.underline &&
      (r.kind === "text" || (r.kind === "link" && last.kind === "link" && last.href === r.href))
    ) {
      last.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  return out.filter((r) => r.text.length > 0);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string { return escapeHtml(s); }
function stripTags(s: string): string { return s.replace(/<[^>]*>/g, ""); }
