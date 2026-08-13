"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmailResultsView, type ResultCounts, type ResultRow } from "@/components/emails/EmailResultsView";
import { batchStateLabel, type BatchState } from "@/lib/emailResults";

interface Batch {
  sendBatchId: string;
  subject: string;
  kind: string;
  fromName: string | null;
  announcementId: string | null;
  sentByName: string | null;
  startedAt: string;
  lastActivityAt: string;
}

export default function BatchResultsPage({ params }: { params: { batchId: string } }) {
  const [data, setData] = useState<null | {
    batch: Batch;
    counts: ResultCounts;
    state: BatchState;
    rows: ResultRow[];
  }>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/emails/batches/${encodeURIComponent(params.batchId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [params.batchId]);

  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-sm text-text-muted">Loading…</div>;

  const b = data.batch;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
      <div className="mb-4">
        <Link href="/dashboard/communication/results" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Email sends
        </Link>
      </div>

      <h1 className="text-2xl font-semibold text-text-primary mb-1">{b.subject}</h1>
      <p className="text-sm text-text-muted mb-6">
        {batchStateLabel(data.state)} · started {new Date(b.startedAt).toLocaleString()}
        {b.sentByName && <> · sent by {b.sentByName}</>}
        {" · "}{b.kind}
        {b.announcementId && (
          <>
            {" · "}
            <Link href={`/dashboard/communication/campaigns/${b.announcementId}`} className="text-brand hover:underline">
              from an announcement
            </Link>
          </>
        )}
      </p>

      <EmailResultsView counts={data.counts} rows={data.rows} />
    </div>
  );
}
