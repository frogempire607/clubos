"use client";

import { useEffect, useRef, useState } from "react";

type Doc = {
  id: string;
  title: string;
  type: string;
  body: string | null;
  required: boolean;
  publishAt: string | null;
  unpublishAt: string | null;
  expiresAt: string | null;
  requiresGuardianSignature: boolean;
  deliveryTrigger: string;
  createdAt: string;
  updatedAt: string;
};

const typeColors: Record<string, { bg: string; fg: string }> = {
  Waiver: { bg: "#FCE4E0", fg: "#7B2415" },
  Policy: { bg: "#E6F1FB", fg: "#0C447C" },
  Agreement: { bg: "#EEEDFE", fg: "#3C3489" },
  Handbook: { bg: "#EAF3DE", fg: "#27500A" },
  Other: { bg: "#F1EFE8", fg: "#5F5E5A" },
};

const triggerLabels: Record<string, string> = {
  MANUAL: "Manual",
  MEMBERSHIP: "On membership purchase",
  EVENT: "On event registration",
  MESSAGE: "Via message",
};

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [viewing, setViewing] = useState<Doc | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/documents");
    if (res.ok) setDocs(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this document?")) return;
    await fetch(`/api/documents/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-stone-900 mb-1">Documents</h1>
          <p className="text-sm text-stone-500">
            Waivers, policies, handbooks, and agreements for your club.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700"
        >
          + New document
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-stone-500 text-sm">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="text-4xl mb-2 text-stone-300">▤</div>
          <h3 className="text-lg font-medium text-stone-900 mb-1">No documents yet</h3>
          <p className="text-sm text-stone-500 mb-4">
            Add waivers, policies, and handbooks that members need to review.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700"
          >
            Create your first document
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => {
            const c = typeColors[d.type] || typeColors.Other;
            return (
              <div
                key={d.id}
                className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition"
              >
                <div className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-sm font-semibold text-stone-900">{d.title}</h3>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                        style={{ background: c.bg, color: c.fg }}
                      >
                        {d.type}
                      </span>
                      {d.required && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-700">
                          Required
                        </span>
                      )}
                      {d.requiresGuardianSignature && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700">
                          Guardian sig
                        </span>
                      )}
                      {d.deliveryTrigger && d.deliveryTrigger !== "MANUAL" && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-50 text-blue-700">
                          {triggerLabels[d.deliveryTrigger] || d.deliveryTrigger}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-stone-500 line-clamp-1">
                      {d.body ? stripHtml(d.body) : "No content yet"}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <p className="text-[10px] text-stone-400">
                        Updated {new Date(d.updatedAt).toLocaleDateString()}
                      </p>
                      {d.expiresAt && (
                        <p className="text-[10px] text-stone-400">
                          Expires {new Date(d.expiresAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => setViewing(d)}
                      className="text-xs text-stone-600 hover:text-stone-900 px-2 py-1 rounded hover:bg-stone-100"
                    >
                      View
                    </button>
                    <button
                      onClick={() => setEditing(d)}
                      className="text-xs text-stone-600 hover:text-stone-900 px-2 py-1 rounded hover:bg-stone-100"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(d.id)}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(showAdd || editing) && (
        <DocumentModal
          doc={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {viewing && (
        <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/* ─── Rich Text Toolbar ─── */

type FormatCmd = "bold" | "italic" | "underline";

function RichEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState("14px");
  const [color, setColor] = useState("#1C1917");

  function exec(cmd: FormatCmd) {
    document.execCommand(cmd, false);
    editorRef.current?.focus();
    sync();
  }

  function applySize(size: string) {
    setFontSize(size);
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand("fontSize", false, "7");
    const spans = editorRef.current?.querySelectorAll('font[size="7"]');
    spans?.forEach((span) => {
      (span as HTMLElement).style.fontSize = size;
      (span as HTMLElement).removeAttribute("size");
    });
    sync();
  }

  function applyColor(c: string) {
    setColor(c);
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand("foreColor", false, c);
    editorRef.current?.focus();
    sync();
  }

  function sync() {
    onChange(editorRef.current?.innerHTML || "");
  }

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value;
    }
  }, []);

  const TEXT_COLORS = ["#1C1917", "#7B2415", "#0C447C", "#27500A", "#633806", "#78716C"];
  const FONT_SIZES = ["12px", "14px", "16px", "18px", "20px", "24px"];

  return (
    <div className="border border-stone-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-stone-900">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-stone-50 border-b border-stone-200 flex-wrap">
        {(["bold", "italic", "underline"] as FormatCmd[]).map((cmd) => (
          <button
            key={cmd}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); exec(cmd); }}
            className="w-7 h-7 flex items-center justify-center rounded text-stone-700 hover:bg-stone-200 text-sm"
            title={cmd}
          >
            {cmd === "bold" ? <b>B</b> : cmd === "italic" ? <i>I</i> : <u>U</u>}
          </button>
        ))}

        <div className="w-px h-4 bg-stone-300 mx-0.5" />

        <select
          value={fontSize}
          onChange={(e) => applySize(e.target.value)}
          className="h-7 text-xs border border-stone-200 rounded px-1 bg-white text-stone-700 focus:outline-none"
        >
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>{s.replace("px", "")}</option>
          ))}
        </select>

        <div className="w-px h-4 bg-stone-300 mx-0.5" />

        <div className="flex items-center gap-1">
          {TEXT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); applyColor(c); }}
              className={`w-4 h-4 rounded-full border-2 transition ${color === c ? "border-stone-500" : "border-transparent"}`}
              style={{ background: c }}
              title={c}
            />
          ))}
          <input
            type="color"
            value={color}
            onChange={(e) => applyColor(e.target.value)}
            className="w-5 h-5 rounded cursor-pointer border border-stone-200"
            title="Custom color"
          />
        </div>

        <div className="w-px h-4 bg-stone-300 mx-0.5" />

        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList", false); sync(); }}
          className="w-7 h-7 flex items-center justify-center rounded text-stone-700 hover:bg-stone-200 text-xs"
          title="Bullet list"
        >
          ≡
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); document.execCommand("removeFormat", false); sync(); }}
          className="w-7 h-7 flex items-center justify-center rounded text-stone-700 hover:bg-stone-200 text-xs"
          title="Clear formatting"
        >
          ✕
        </button>
      </div>

      {/* Editor area */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={sync}
        className="min-h-[240px] p-4 text-sm text-stone-900 leading-relaxed focus:outline-none"
        style={{ fontFamily: "inherit" }}
        data-placeholder="Write the full document content here…"
      />
    </div>
  );
}

/* ─── Document Modal ─── */

function DocumentModal({
  doc,
  onClose,
  onSaved,
}: {
  doc: Doc | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!doc;
  const [title, setTitle] = useState(doc?.title || "");
  const [type, setType] = useState(doc?.type || "Waiver");
  const [body, setBody] = useState(doc?.body || "");
  const [required, setRequired] = useState(doc?.required || false);
  const [requiresGuardianSignature, setRequiresGuardianSignature] = useState(doc?.requiresGuardianSignature || false);
  const [deliveryTrigger, setDeliveryTrigger] = useState(doc?.deliveryTrigger || "MANUAL");
  const [expiresAt, setExpiresAt] = useState(doc?.expiresAt ? doc.expiresAt.split("T")[0] : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const url = isEdit ? `/api/documents/${doc!.id}` : "/api/documents";
    const method = isEdit ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        type,
        body: body || null,
        required,
        requiresGuardianSignature,
        deliveryTrigger,
        expiresAt: expiresAt || null,
      }),
    });

    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Save failed");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold text-stone-900">
            {isEdit ? "Edit document" : "New document"}
          </h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                placeholder="Liability Waiver"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
              >
                <option>Waiver</option>
                <option>Policy</option>
                <option>Agreement</option>
                <option>Handbook</option>
                <option>Other</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Content</label>
            <RichEditor value={body} onChange={setBody} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Show to member</label>
              <select
                value={deliveryTrigger}
                onChange={(e) => setDeliveryTrigger(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
              >
                <option value="MANUAL">Manually</option>
                <option value="MEMBERSHIP">On membership purchase</option>
                <option value="EVENT">On event registration</option>
                <option value="MESSAGE">Via message</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Expires (optional)</label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
              <p className="text-[10px] text-stone-400 mt-1">Member must re-sign after this date</p>
            </div>
          </div>

          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                className="w-4 h-4 accent-stone-900"
              />
              <span className="text-sm text-stone-700">
                Required — members must sign before participating
              </span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={requiresGuardianSignature}
                onChange={(e) => setRequiresGuardianSignature(e.target.checked)}
                className="w-4 h-4 accent-stone-900"
              />
              <span className="text-sm text-stone-700">
                Requires guardian signature for minors
              </span>
            </label>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create document"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DocumentViewer({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const c = typeColors[doc.type] || typeColors.Other;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-stone-900">{doc.title}</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
              {doc.type}
            </span>
            {doc.required && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-700">Required</span>
            )}
            {doc.requiresGuardianSignature && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700">Guardian sig</span>
            )}
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {doc.body ? (
            <div
              className="text-sm text-stone-700 leading-relaxed prose max-w-none"
              dangerouslySetInnerHTML={{ __html: doc.body }}
            />
          ) : (
            <p className="text-sm text-stone-400 italic">No content added yet.</p>
          )}
          {doc.expiresAt && (
            <p className="text-xs text-stone-400 mt-6 pt-4 border-t border-stone-100">
              Expires: {new Date(doc.expiresAt).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
