"use client";

// B21 — Documents tab (moved here from the retired Edit Staff modal's
// StaffDocsPanel). Same API routes, same permission split:
//   · the owner → GET/POST /api/staff/<id>/documents, PATCH/DELETE …/<docId>
//     (list, upload with kind, shared-with-staff toggle, delete)
//   · the staff member themself → GET /api/me/staff-documents (only what was
//     shared with them; read-only — the API has no staff upload/delete)
//   · anyone else → locked (the document routes are owner-only today).
// Julian's rule: no W-9 on file = missing a required document.
import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { AlertCircle, FileText, Lock } from "lucide-react";
import Sheet from "@/components/Sheet";
import { SkeletonList } from "@/components/LoadingSkeleton";
import type { StaffTabProps } from "@/components/staff/types";

type StaffDoc = {
  id: string;
  title: string;
  kind: string;
  fileUrl: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  notes: string | null;
  sharedWithStaff?: boolean;
  createdAt: string;
};

const DOC_KINDS = [
  { v: "W9", label: "W-9" },
  { v: "1099", label: "1099" },
  { v: "CONTRACT", label: "Contract" },
  { v: "AGREEMENT", label: "Agreement" },
  { v: "CERTIFICATION", label: "Certification" },
  { v: "OTHER", label: "Other" },
];
const kindLabel = (k: string) => DOC_KINDS.find((x) => x.v === k)?.label ?? k;

function errorText(raw: unknown, fallback: string): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw.map((x) => (typeof x === "string" ? x : (x as { message?: string })?.message)).filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return fallback;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-[13.5px] font-medium md:min-h-[36px]";
const inputCls =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand md:min-h-[38px]";

export default function DocumentsTab({ data, reload, setProblem }: StaffTabProps) {
  const { staff, viewer } = data;
  const { data: session } = useSession();
  const manage = viewer.isOwner; // the document routes are OWNER-only
  const selfView = !manage && viewer.isSelf;
  const locked = !manage && !selfView;

  const [docs, setDocs] = useState<StaffDoc[]>([]);
  const [loading, setLoading] = useState(!locked);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Upload form
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("OTHER");
  const [shared, setShared] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<StaffDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (locked) return;
    setLoading(true);
    const res = await fetch(manage ? `/api/staff/${staff.id}/documents` : "/api/me/staff-documents", { cache: "no-store" });
    const d = await res.json().catch(() => []);
    setLoading(false);
    if (!res.ok) {
      setLoadError(errorText(d?.error, "Couldn't load documents."));
      return;
    }
    setLoadError(null);
    setDocs(Array.isArray(d) ? d : []);
  }, [locked, manage, staff.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Required-and-missing drives the red tab dot. Owners are exempt (same as the payload).
  const w9Missing = manage && !loading ? !viewer.targetIsOwner && !docs.some((d) => d.kind === "W9") : data.counts.w9Missing;
  useEffect(() => {
    if (manage && !loading) setProblem?.(w9Missing);
  }, [manage, loading, w9Missing, setProblem]);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    if (!title.trim()) {
      setUploadError("Give the document a title first.");
      input.value = "";
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      // Multi-file: each file becomes its own document; titles get "(n/total)".
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fd = new FormData();
        fd.append("file", file);
        fd.append("kind", "document");
        const upRes = await fetch("/api/upload", { method: "POST", body: fd });
        if (!upRes.ok) {
          const j = await upRes.json().catch(() => ({}));
          throw new Error(`${file.name}: ${typeof j.error === "string" ? j.error : "upload failed"}`);
        }
        const up = await upRes.json();
        const t = files.length === 1 ? title.trim() : `${title.trim()} (${i + 1}/${files.length})`;
        const r = await fetch(`/api/staff/${staff.id}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: t,
            kind,
            fileUrl: up.url,
            fileId: up.id ?? null,
            fileName: file.name,
            mimeType: file.type || null,
            sizeBytes: file.size,
            sharedWithStaff: shared,
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(`${file.name}: ${errorText(j.error, "save failed")}`);
        }
      }
      setTitle("");
      setKind("OTHER");
      setShared(false);
      await load();
      await reload();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      input.value = "";
    }
  }

  async function toggleShared(d: StaffDoc) {
    const next = !d.sharedWithStaff;
    setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, sharedWithStaff: next } : x)));
    const res = await fetch(`/api/staff/${staff.id}/documents/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sharedWithStaff: next }),
    });
    if (!res.ok) {
      setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, sharedWithStaff: !next } : x)));
      setLoadError("Couldn't change sharing. Please try again.");
    }
  }

  async function remove() {
    if (!confirmDelete) return;
    setDeleting(true);
    const res = await fetch(`/api/staff/${staff.id}/documents/${confirmDelete.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmDelete(null);
    if (!res.ok) {
      setLoadError("Couldn't remove that document. Please try again.");
      return;
    }
    await load();
    await reload();
  }

  const senderName = session?.user?.name || "The owner";
  const requestSubject = "W-9 needed";
  const requestBody = `Hi ${staff.firstName},\n\nCould you send me a completed W-9 (Request for Taxpayer Identification Number and Certification)? You can download the blank form from the IRS: https://www.irs.gov/pub/irs-pdf/fw9.pdf\n\nThanks,\n${senderName}`;
  const mailto = `mailto:${encodeURIComponent(staff.email)}?subject=${encodeURIComponent(requestSubject)}&body=${encodeURIComponent(requestBody)}`;

  async function copyRequest() {
    try {
      await navigator.clipboard.writeText(requestBody);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (locked) {
    return (
      <section className="rounded-xl border border-app-border bg-surface p-[18px] sm:p-5">
        <h2 className="text-[15px] font-semibold text-text-primary">Documents</h2>
        <p className="mt-2 flex items-start gap-2 text-[13px] text-text-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Staff documents (W-9s, contracts, agreements) are managed by the owner. {staff.firstName} has{" "}
          {data.counts.documents} on file{data.counts.w9Missing ? ", and no W-9" : ""}.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {manage && w9Missing && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          style={{ background: "var(--color-danger-surface)", border: "1px solid var(--color-danger-border)" }}
        >
          <div className="flex items-start gap-2" style={{ color: "var(--color-danger-text)" }}>
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <div className="text-[14px] font-semibold">No W-9 on file</div>
              <div className="text-[13px]">A W-9 is required for every staff member. Ask {staff.firstName} for one, then upload it below as a W-9.</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setCopied(false);
              setRequestOpen(true);
            }}
            className={`${btn} shrink-0 bg-surface text-text-primary hover:bg-app-bg`}
            style={{ border: "1px solid var(--color-danger-border)" }}
          >
            Request
          </button>
        </div>
      )}

      {selfView && (
        <p className="flex items-start gap-2 rounded-lg border border-dashed border-app-border px-4 py-3 text-[13px] text-text-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          These are the documents the owner shared with you. To send the owner a document (for example a W-9), email it to them.
        </p>
      )}

      <div className={manage ? "grid gap-4 lg:grid-cols-[1.55fr_1fr]" : ""}>
        <section className="min-w-0 rounded-xl border border-app-border bg-surface p-[18px] sm:p-5">
          <h2 className="text-[15px] font-semibold text-text-primary">
            {selfView ? "Shared with you" : "Documents on file"}
            {!loading && <span className="ml-1.5 text-[13px] font-normal text-text-muted">{docs.length}</span>}
          </h2>
          {loadError && (
            <p role="alert" className="mt-2 text-[13px]" style={{ color: "var(--color-danger-text)" }}>{loadError}</p>
          )}
          {loading ? (
            <div className="mt-2"><SkeletonList rows={2} /></div>
          ) : docs.length === 0 ? (
            <p className="mt-2 text-[13px] text-text-muted">{selfView ? "Nothing has been shared with you yet." : "No documents yet."}</p>
          ) : (
            <ul className="mt-2">
              {docs.map((d) => (
                <li key={d.id} className="flex flex-col gap-2 border-b py-3 last:border-b-0 sm:flex-row sm:items-center" style={{ borderColor: "var(--color-hairline)" }}>
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}>
                          {kindLabel(d.kind)}
                        </span>
                        <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words text-[13.5px] font-medium text-text-primary hover:underline">
                          {d.title}
                        </a>
                      </div>
                      <div className="mt-0.5 break-all text-[12px] text-text-muted">
                        {d.fileName ? `${d.fileName} · ` : ""}
                        {fmtDate(d.createdAt)}
                      </div>
                    </div>
                  </div>
                  {manage && (
                    <div className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
                      <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-[12.5px] text-text-muted md:min-h-0">
                        <input type="checkbox" checked={!!d.sharedWithStaff} onChange={() => toggleShared(d)} className="h-4 w-4 rounded" />
                        Shared with {staff.firstName || "staff"}
                      </label>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(d)}
                        className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-[13px] hover:bg-app-bg md:min-h-[32px]"
                        style={{ color: "var(--color-danger-text)" }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {manage && (
          <section className="min-w-0 self-start rounded-xl border border-app-border bg-surface p-[18px] sm:p-5">
            <h2 className="text-[15px] font-semibold text-text-primary">Upload</h2>
            <p className="mt-1 text-[12.5px] text-text-muted">Saved as soon as the file uploads.</p>
            <div className="mt-3 space-y-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-text-primary">Title</span>
                <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 2026 W-9" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-text-primary">Kind</span>
                <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
                  {DOC_KINDS.map((k) => (
                    <option key={k.v} value={k.v}>{k.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-text-primary md:min-h-0">
                <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="h-4 w-4 rounded" />
                Let {staff.firstName || "this staff member"} see and download it
              </label>
              <label className="block">
                <span className="sr-only">Choose file</span>
                <input
                  type="file"
                  multiple
                  onChange={upload}
                  disabled={uploading}
                  className="block w-full text-[13px] text-text-muted file:mr-3 file:min-h-[44px] file:rounded-lg file:border-0 file:bg-brand file:px-4 file:text-[13px] file:font-medium file:text-white hover:file:bg-brand-hover disabled:opacity-50 md:file:min-h-[36px]"
                />
              </label>
              {uploading && <p className="text-[12.5px] text-text-muted">Uploading…</p>}
              {uploadError && <p role="alert" className="text-[12.5px]" style={{ color: "var(--color-danger-text)" }}>{uploadError}</p>}
            </div>
          </section>
        )}
      </div>

      <Sheet
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={`Remove "${confirmDelete?.title ?? ""}"?`}
        description="It comes off this profile and out of the staff member's shared documents. This shows in Recent activity."
        footer={
          <>
            <button type="button" onClick={() => setConfirmDelete(null)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              Keep it
            </button>
            <button type="button" onClick={remove} disabled={deleting} className={`${btn} bg-red-600 text-white hover:bg-red-700 disabled:opacity-50`}>
              {deleting ? "Removing…" : "Remove document"}
            </button>
          </>
        }
      />

      <Sheet
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        title={`Ask ${staff.firstName} for a W-9`}
        description={`Send this from your own email to ${staff.email}, or copy it into a text.`}
        footer={
          <>
            <button type="button" onClick={copyRequest} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              {copied ? "Copied" : "Copy text"}
            </button>
            <a href={mailto} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
              Open in email
            </a>
          </>
        }
      >
        <pre className="whitespace-pre-wrap break-words rounded-lg border border-app-border bg-app-bg p-3 font-sans text-[13px] text-text-primary">{requestBody}</pre>
      </Sheet>
    </div>
  );
}
