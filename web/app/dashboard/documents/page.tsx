"use client";

import { useEffect, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonList } from "@/components/LoadingSkeleton";

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
  signatureValidForDays: number | null;
  deliveryTrigger: string;
  createdAt: string;
  updatedAt: string;
};

const typeColors: Record<string, { bg: string; fg: string }> = {
  Waiver: { bg: "var(--color-warning)", fg: "#fff" },
  Policy: { bg: "var(--color-primary)", fg: "#fff" },
  Agreement: { bg: "var(--color-primary)", fg: "#fff" },
  Handbook: { bg: "var(--color-success)", fg: "#1F1F23" },
  Other: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
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
  const [signaturesFor, setSignaturesFor] = useState<Doc | null>(null);

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
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl">
      <PageHeader
        title="Documents"
        description="Waivers, policies, handbooks, and agreements for your club."
        actions={
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover w-full sm:w-auto"
          >
            + New document
          </button>
        }
      />

      {loading ? (
        <div className="bg-white rounded-xl border border-app-border">
          <SkeletonList rows={4} />
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          icon="▤"
          title="No documents yet"
          description="Add waivers, policies, and handbooks that members need to review."
          action={{ label: "Create your first document", onClick: () => setShowAdd(true) }}
          className="bg-white rounded-xl border border-app-border"
        />
      ) : (
        <div className="space-y-2">
          {docs.map((d) => {
            const c = typeColors[d.type] || typeColors.Other;
            return (
              <div
                key={d.id}
                className="bg-white rounded-xl border border-app-border p-4 hover:shadow-sm transition"
              >
                <div className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-sm font-semibold text-text-primary">{d.title}</h3>
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
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-orange-accent/10 text-orange-accent">
                          Guardian sig
                        </span>
                      )}
                      {d.deliveryTrigger && d.deliveryTrigger !== "MANUAL" && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-brand/10 text-brand">
                          {triggerLabels[d.deliveryTrigger] || d.deliveryTrigger}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted line-clamp-1">
                      {d.body ? stripHtml(d.body) : "No content yet"}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <p className="text-[10px] text-text-muted">
                        Updated {new Date(d.updatedAt).toLocaleDateString()}
                      </p>
                      {d.expiresAt && (
                        <p className="text-[10px] text-text-muted">
                          Expires {new Date(d.expiresAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => setViewing(d)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      View
                    </button>
                    <button
                      onClick={() => setSignaturesFor(d)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Signatures
                    </button>
                    <button
                      onClick={() => setEditing(d)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
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

      {signaturesFor && (
        <SignaturesModal doc={signaturesFor} onClose={() => setSignaturesFor(null)} />
      )}
    </div>
  );
}

type SignatureRow = {
  id: string;
  signerName: string;
  relationship: string;
  signedAt: string;
  ipAddress: string | null;
  member: { id: string; firstName: string; lastName: string; isMinor: boolean; email: string | null };
};

type SignaturesResponse = {
  document: { signatureValidForDays: number | null };
  signatures: SignatureRow[];
};

function SignaturesModal({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [signatures, setSignatures] = useState<SignatureRow[]>([]);
  const [validForDays, setValidForDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/documents/${doc.id}/signatures`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SignaturesResponse | null) => {
        setSignatures(d?.signatures ?? []);
        setValidForDays(d?.document.signatureValidForDays ?? null);
        setLoading(false);
      });
  }, [doc.id]);

  function expiry(signedAt: string): { date: Date | null; expired: boolean } {
    if (!validForDays) return { date: null, expired: false };
    const d = new Date(signedAt);
    d.setDate(d.getDate() + validForDays);
    return { date: d, expired: d < new Date() };
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Signatures</h2>
            <p className="text-xs text-text-muted">
              {doc.title}
              {validForDays && ` · re-signature required every ${validForDays === 365 ? "year" : `${validForDays} days`}`}
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {loading ? (
            <div className="py-2"><SkeletonList rows={3} /></div>
          ) : signatures.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">
              No one has signed this document yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-text-muted border-b border-app-border">
                  <th className="pb-2 font-medium">Member</th>
                  <th className="pb-2 font-medium">Signed by</th>
                  <th className="pb-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {signatures.map((s) => (
                  <tr key={s.id} className="border-b border-app-border last:border-0">
                    <td className="py-2.5">
                      <p className="font-medium text-text-primary">
                        {s.member.firstName} {s.member.lastName}
                        {s.member.isMinor && (
                          <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">minor</span>
                        )}
                      </p>
                      {s.member.email && (
                        <p className="text-xs text-text-muted">{s.member.email}</p>
                      )}
                    </td>
                    <td className="py-2.5">
                      <p className="text-text-primary">{s.signerName}</p>
                      <p className="text-xs text-text-muted">
                        {s.relationship === "GUARDIAN" ? "Guardian" : "Self"}
                      </p>
                    </td>
                    <td className="py-2.5 text-text-muted">
                      {new Date(s.signedAt).toLocaleString("en-US", {
                        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
                      })}
                      {(() => {
                        const e = expiry(s.signedAt);
                        if (!e.date) return null;
                        return (
                          <p className={`text-[10px] ${e.expired ? "text-red-600" : "text-text-muted/70"}`}>
                            {e.expired ? "Expired " : "Valid until "}
                            {e.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                          </p>
                        );
                      })()}
                      {s.ipAddress && (
                        <p className="text-[10px] text-text-muted/70">IP: {s.ipAddress}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
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
  const [color, setColor] = useState("#111111");

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

  const TEXT_COLORS = ["#111111", "#6D5DF6", "#A3E635", "#FF6A00", "#A32D2D", "#6B7280"];
  const FONT_SIZES = ["12px", "14px", "16px", "18px", "20px", "24px"];

  return (
    <div className="border border-app-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-stone-900">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-app-bg border-b border-app-border flex-wrap">
        {(["bold", "italic", "underline"] as FormatCmd[]).map((cmd) => (
          <button
            key={cmd}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); exec(cmd); }}
            className="w-7 h-7 flex items-center justify-center rounded text-text-primary hover:bg-app-border text-sm"
            title={cmd}
          >
            {cmd === "bold" ? <b>B</b> : cmd === "italic" ? <i>I</i> : <u>U</u>}
          </button>
        ))}

        <div className="w-px h-4 bg-app-border mx-0.5" />

        <select
          value={fontSize}
          onChange={(e) => applySize(e.target.value)}
          className="h-7 text-xs border border-app-border rounded px-1 bg-white text-text-primary focus:outline-none"
        >
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>{s.replace("px", "")}</option>
          ))}
        </select>

        <div className="w-px h-4 bg-app-border mx-0.5" />

        <div className="flex items-center gap-1">
          {TEXT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); applyColor(c); }}
              className={`w-4 h-4 rounded-full border-2 transition ${color === c ? "border-app-border" : "border-transparent"}`}
              style={{ background: c }}
              title={c}
            />
          ))}
          <input
            type="color"
            value={color}
            onChange={(e) => applyColor(e.target.value)}
            className="w-5 h-5 rounded cursor-pointer border border-app-border"
            title="Custom color"
          />
        </div>

        <div className="w-px h-4 bg-app-border mx-0.5" />

        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList", false); sync(); }}
          className="w-7 h-7 flex items-center justify-center rounded text-text-primary hover:bg-app-border text-xs"
          title="Bullet list"
        >
          ≡
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); document.execCommand("removeFormat", false); sync(); }}
          className="w-7 h-7 flex items-center justify-center rounded text-text-primary hover:bg-app-border text-xs"
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
        className="min-h-[240px] p-4 text-sm text-text-primary leading-relaxed focus:outline-none"
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
  const [signatureFrequency, setSignatureFrequency] = useState<string>(
    doc?.signatureValidForDays ? String(doc.signatureValidForDays) : "0"
  );
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
        signatureValidForDays: signatureFrequency === "0" ? null : parseInt(signatureFrequency, 10),
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold text-text-primary">
            {isEdit ? "Edit document" : "New document"}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                placeholder="Liability Waiver"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand"
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
            <label className="block text-sm font-medium text-text-primary mb-1">Content</label>
            <RichEditor value={body} onChange={setBody} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Show to member</label>
              <select
                value={deliveryTrigger}
                onChange={(e) => setDeliveryTrigger(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand"
              >
                <option value="MANUAL">Manually</option>
                <option value="MEMBERSHIP">On membership purchase</option>
                <option value="EVENT">On event registration</option>
                <option value="MESSAGE">Via message</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Document expires on</label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <p className="text-[10px] text-text-muted mt-1">Hides the document from members after this date</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Signature renewal frequency</label>
            <select
              value={signatureFrequency}
              onChange={(e) => setSignatureFrequency(e.target.value)}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand"
            >
              <option value="0">Once — no renewal needed</option>
              <option value="30">Every 30 days</option>
              <option value="90">Every 90 days (quarterly)</option>
              <option value="180">Every 180 days (semi-annual)</option>
              <option value="365">Every year</option>
              <option value="730">Every 2 years</option>
            </select>
            <p className="text-[10px] text-text-muted mt-1">
              How often members must re-sign. Existing signatures expire after this period and members are prompted to re-sign.
            </p>
          </div>

          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                className="w-4 h-4 accent-stone-900"
              />
              <span className="text-sm text-text-primary">
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
              <span className="text-sm text-text-primary">
                Requires guardian signature for minors
              </span>
            </label>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-text-primary">{doc.title}</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
              {doc.type}
            </span>
            {doc.required && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-700">Required</span>
            )}
            {doc.requiresGuardianSignature && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-orange-accent/10 text-orange-accent">Guardian sig</span>
            )}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {doc.body ? (
            <div
              className="text-sm text-text-primary leading-relaxed prose max-w-none"
              dangerouslySetInnerHTML={{ __html: doc.body }}
            />
          ) : (
            <p className="text-sm text-text-muted italic">No content added yet.</p>
          )}
          {doc.expiresAt && (
            <p className="text-xs text-text-muted mt-6 pt-4 border-t border-app-border">
              Expires: {new Date(doc.expiresAt).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
