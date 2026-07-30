"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload, History, RotateCcw } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { SkeletonList } from "@/components/LoadingSkeleton";

type Batch = {
  id: string;
  kind: "MEMBERS" | "TRANSACTIONS";
  status: string;
  sourceLabel: string | null;
  sourceSystem: string | null;
  fileName: string;
  rowCount: number;
  createdCount: number;
  matchedCount: number;
  mergedCount: number;
  skippedCount: number;
  errorCount: number;
  reviewCount: number;
  startedAt: string | null;
  completedAt: string | null;
  rolledBackAt: string | null;
  rollbackExpiresAt: string | null;
  createdAt: string;
};

export default function ImportsHistoryPage() {
  const router = useRouter();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    const res = await fetch("/api/reports/imports");
    if (res.ok) {
      const d = await res.json();
      setBatches(d.batches);
    }
  }
  useEffect(() => { load(); }, []);

  async function startNew(kind: "MEMBERS" | "TRANSACTIONS", sourceLabel: string, file: File) {
    setUploading(true);
    setErr(null);
    const body = new FormData();
    body.append("file", file);
    body.append("kind", kind);
    body.append("sourceLabel", sourceLabel);
    const res = await fetch("/api/reports/imports", { method: "POST", body });
    const d = await res.json().catch(() => ({}));
    setUploading(false);
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Upload failed"); return; }
    router.push(`/dashboard/reports/imports/${d.batchId}?step=2`);
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <Link href="/dashboard/reports?tab=imports" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary mb-3">
        <ArrowLeft size={13} /> Back to Reports
      </Link>
      <PageHeader
        title="History & imports"
        description="Import your club's history from your previous system. Nothing is written until step 6."
        actions={
          <button
            onClick={() => setShowNew(true)}
            className="h-10 min-h-[44px] flex items-center gap-1.5 px-3 rounded-lg bg-brand text-white text-sm font-semibold hover:bg-brand-hover"
          >
            <Upload size={14} strokeWidth={2} /> New import
          </button>
        }
      />

      {showNew && <NewImportModal onClose={() => setShowNew(false)} onStart={startNew} uploading={uploading} err={err} />}

      <div className="mt-6">
        <div className="flex items-center gap-2 mb-3">
          <History size={14} strokeWidth={2} className="text-text-muted" />
          <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">Import history</h2>
        </div>
        {batches == null ? (
          <SkeletonList rows={3} />
        ) : batches.length === 0 ? (
          <div className="bg-surface border border-app-border rounded-xl p-8 text-center">
            <p className="text-sm text-text-muted mb-3">No imports yet. Bring your history over from your previous system.</p>
            <button
              onClick={() => setShowNew(true)}
              className="h-11 min-h-[44px] inline-flex items-center gap-1.5 px-4 rounded-lg bg-brand text-white text-sm font-semibold hover:bg-brand-hover"
            >
              <Upload size={14} /> New import
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {batches.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/dashboard/reports/imports/${b.id}`}
                  className="block border border-app-border rounded-lg p-3 bg-surface hover:bg-app-bg min-h-[44px]"
                >
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">
                        {b.fileName} · {b.kind === "MEMBERS" ? "Members" : "Transactions"}
                      </p>
                      <p className="text-[11px] text-text-muted mt-0.5">
                        {b.sourceLabel ? `From: ${b.sourceLabel} · ` : ""}
                        Uploaded {new Date(b.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge status={b.status} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs text-text-muted">
                    <Stat label="Rows" value={b.rowCount} />
                    <Stat label="Created" value={b.createdCount} />
                    <Stat label="Matched" value={b.matchedCount} />
                    <Stat label="Merged" value={b.mergedCount} />
                    <Stat label="Skipped" value={b.skippedCount} />
                    <Stat label="Errors" value={b.errorCount} />
                  </div>
                  {b.status === "COMPLETED" && b.rollbackExpiresAt && (
                    <p className="text-[11px] text-text-muted mt-2 flex items-center gap-1">
                      <RotateCcw size={11} />
                      Rollback available until {new Date(b.rollbackExpiresAt).toLocaleDateString()}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "COMPLETED" ? "bg-lime-accent/25 text-charcoal" :
    status === "AWAITING_REVIEW" ? "bg-orange-accent/20 text-orange-accent" :
    status === "DRAFT" ? "bg-app-bg text-text-muted" :
    status === "FAILED" ? "bg-red-100 text-red-700" :
    status === "ROLLED_BACK" ? "bg-red-50 text-red-600" :
    "bg-brand/20 text-brand";
  return <span className={`text-[11px] font-semibold px-2 py-1 rounded ${cls}`}>{status.replace("_", " ")}</span>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[10px] text-text-muted uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-text-primary tabular-nums">{value}</p>
    </div>
  );
}

function NewImportModal({
  onClose, onStart, uploading, err,
}: {
  onClose: () => void;
  onStart: (kind: "MEMBERS" | "TRANSACTIONS", sourceLabel: string, file: File) => void;
  uploading: boolean;
  err: string | null;
}) {
  const [kind, setKind] = useState<"MEMBERS" | "TRANSACTIONS">("MEMBERS");
  const [sourceLabel, setSourceLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div
        className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">Start an import</h2>
          <button onClick={onClose} className="text-text-muted w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1">What are you importing?</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setKind("MEMBERS")}
                className={`h-12 min-h-[44px] rounded-lg border text-sm font-semibold ${
                  kind === "MEMBERS" ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"
                }`}
              >
                Members
              </button>
              <button
                onClick={() => setKind("TRANSACTIONS")}
                className={`h-12 min-h-[44px] rounded-lg border text-sm font-semibold ${
                  kind === "TRANSACTIONS" ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"
                }`}
              >
                Transactions
              </button>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1">Where are you importing from?</label>
            <input
              type="text"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              placeholder="e.g. our previous class-tracking software"
              className="w-full h-11 min-h-[44px] px-3 border border-app-border rounded-lg text-sm"
            />
            <p className="text-[11px] text-text-muted mt-1">Free text. Shown to your staff on every imported row so they know where it came from.</p>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary block mb-1">CSV file (max 20 MB / 50,000 rows)</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex flex-col sm:flex-row gap-2 pt-2">
            <button onClick={onClose} className="flex-1 h-11 min-h-[44px] px-4 border border-app-border rounded-lg text-sm text-text-primary hover:bg-app-bg">
              Cancel
            </button>
            <button
              disabled={!file || uploading}
              onClick={() => file && onStart(kind, sourceLabel.trim(), file)}
              className="flex-1 h-11 min-h-[44px] px-4 bg-brand text-white rounded-lg text-sm font-semibold hover:bg-brand-hover disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload & continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
