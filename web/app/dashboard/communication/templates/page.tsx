"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Copy, Archive, ArchiveRestore, Trash2, Pencil, Save, X } from "lucide-react";
import EmailComposer from "@/components/EmailComposer";
import type { EmailBlock } from "@/lib/emailBlocks";

interface TemplateRow {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  subject: string;
  previewText: string | null;
  bodyJson: EmailBlock[] | null;
  isSystem: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/email-templates");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setTemplates(data.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function duplicate(t: TemplateRow) {
    const res = await fetch(`/api/email-templates/${t.id}/duplicate`, { method: "POST" });
    if (!res.ok) { setError((await res.json()).error ?? "Duplicate failed"); return; }
    await load();
  }

  async function toggleArchive(t: TemplateRow) {
    const res = await fetch(`/api/email-templates/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !t.archivedAt }),
    });
    if (!res.ok) { setError((await res.json()).error ?? "Archive failed"); return; }
    await load();
  }

  async function hardDelete(t: TemplateRow) {
    if (t.isSystem) return; // UI shouldn't show delete for system; guard anyway
    if (!confirm(`Delete "${t.name}"? This can't be undone.`)) return;
    const res = await fetch(`/api/email-templates/${t.id}`, { method: "DELETE" });
    if (!res.ok) { setError((await res.json()).error ?? "Delete failed"); return; }
    await load();
  }

  const visible = templates.filter((t) => showArchived || !t.archivedAt);
  const activeCount = templates.filter((t) => !t.archivedAt).length;
  const archivedCount = templates.length - activeCount;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <Link href="/dashboard/communication/campaigns" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Communications
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Email templates</h1>
          <p className="text-sm text-text-muted">
            Reusable email starting points. Every template ships with your club logo up top and
            contact info at the bottom — auto-inserted at send time so you don't have to keep
            re-adding them.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-xs px-3 py-2 rounded-lg border border-app-border hover:bg-app-bg"
          >
            {showArchived ? `Hide archived (${archivedCount})` : `Show archived (${archivedCount})`}
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-brand text-white hover:bg-brand-hover font-medium"
          >
            <Plus className="h-4 w-4" strokeWidth={2} /> New template
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-text-muted p-8 text-center">Loading templates…</div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-text-muted p-8 text-center">No templates yet.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((t) => (
            <div
              key={t.id}
              className={`bg-surface rounded-xl border p-4 flex flex-col gap-2 ${
                t.archivedAt ? "border-app-border/60 opacity-60" : "border-app-border"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <h3 className="text-sm font-semibold text-text-primary truncate">{t.name}</h3>
                    {t.isSystem && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand font-medium">System</span>
                    )}
                    {t.archivedAt && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-bg text-text-muted">Archived</span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted mt-1 line-clamp-2">{t.description || t.subject || "No description"}</p>
                </div>
              </div>
              <div className="mt-auto flex items-center gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-app-border hover:bg-app-bg"
                >
                  <Pencil className="h-3 w-3" strokeWidth={2} /> Edit
                </button>
                <button
                  type="button"
                  onClick={() => duplicate(t)}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-app-border hover:bg-app-bg"
                >
                  <Copy className="h-3 w-3" strokeWidth={2} /> Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => toggleArchive(t)}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-app-border hover:bg-app-bg"
                >
                  {t.archivedAt ? (
                    <><ArchiveRestore className="h-3 w-3" strokeWidth={2} /> Restore</>
                  ) : (
                    <><Archive className="h-3 w-3" strokeWidth={2} /> Archive</>
                  )}
                </button>
                {!t.isSystem && (
                  <button
                    type="button"
                    onClick={() => hardDelete(t)}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-app-border hover:bg-app-bg text-red-600 hover:text-red-700"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={2} /> Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <TemplateEditor
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {creating && (
        <TemplateEditor
          template={null}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  onClose,
  onSaved,
}: {
  template: TemplateRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = template === null;
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [previewText, setPreviewText] = useState(template?.previewText ?? "");
  const [blocks, setBlocks] = useState<EmailBlock[]>(template?.bodyJson ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    setSaving(true);
    try {
      if (!name.trim()) throw new Error("Name is required");
      if (!blocks.length) throw new Error("Add at least one content block");
      const payload = { name, description: description || null, subject, previewText: previewText || null, blocks };
      const res = isNew
        ? await fetch("/api/email-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch(`/api/email-templates/${template!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-app-bg rounded-t-2xl sm:rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 bg-surface border-b border-app-border px-4 py-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-primary truncate">
              {isNew ? "New template" : `Edit — ${template!.name}`}
            </h2>
            {template?.isSystem && (
              <p className="text-xs text-text-muted mt-0.5">System template — edits stay on this club and never affect other clubs.</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md border border-app-border hover:bg-app-bg inline-flex items-center gap-1"
            >
              <X className="h-3 w-3" strokeWidth={2} /> Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-hover inline-flex items-center gap-1 disabled:opacity-50"
            >
              <Save className="h-3 w-3" strokeWidth={2} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Practice cancellation"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="When a single practice is called off"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
              />
            </div>
          </div>

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>
          )}

          <EmailComposer
            initialSubject={subject}
            initialPreviewText={previewText}
            initialBlocks={blocks.length ? blocks : undefined}
            onChange={(s) => {
              setSubject(s.subject);
              setPreviewText(s.previewText);
              setBlocks(s.blocks);
            }}
          />
        </div>
      </div>
    </div>
  );
}
