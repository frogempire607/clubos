"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmailResultsView, type ResultCounts, type ResultRow } from "@/components/emails/EmailResultsView";

interface Announcement {
  id: string;
  title: string;
  status: string;
  sentAt: string | null;
  scheduledFor: string | null;
  canceledAt: string | null;
  sendBatchId: string | null;
  householdMode: string;
  senderUserId: string | null;
  createdAt: string;
}

export default function AnnouncementResultsPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<null | {
    announcement: Announcement;
    counts: ResultCounts | null;
    rows: ResultRow[];
    trackingCapableRatio: number;
  }>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/announcements/${params.id}/results`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [params.id]);

  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-sm text-text-muted">Loading…</div>;

  const a = data.announcement;
  const c = data.counts;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Link href="/dashboard/announcements" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Announcements
        </Link>
        <Link href="/dashboard/communication/results" className="text-sm text-text-muted hover:text-text-primary">
          All email sends
        </Link>
      </div>

      <h1 className="text-2xl font-semibold text-text-primary mb-1">{a.title}</h1>
      <p className="text-sm text-text-muted mb-6">
        {a.status === "SENT" && a.sentAt && <>Sent {new Date(a.sentAt).toLocaleString()}</>}
        {a.status === "SCHEDULED" && a.scheduledFor && <>Scheduled for {new Date(a.scheduledFor).toLocaleString()}</>}
        {a.status === "CANCELED" && a.canceledAt && <>Canceled {new Date(a.canceledAt).toLocaleString()}</>}
        {a.status === "DRAFT" && <>Draft — not sent yet</>}
        {" · "}Household mode: <strong className="text-text-primary">{a.householdMode}</strong>
      </p>

      {!c ? (
        <div className="text-sm text-text-muted p-8 text-center bg-surface rounded-xl border border-app-border">
          Results will appear here after this announcement sends.
        </div>
      ) : (
        <EmailResultsView counts={c} rows={data.rows} />
      )}
    </div>
  );
}
