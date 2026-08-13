"use client";

// Every email send this club has made, newest first. The answer to
// "I emailed 77 members from the Members tab and can't find the results
// anywhere" — bulk sends create no Announcement row, so nothing linked
// to them until this page existed.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";
import { batchStateLabel, type BatchState } from "@/lib/emailResults";

interface Batch {
  sendBatchId: string;
  subject: string;
  kind: string;
  announcementId: string | null;
  fromName: string | null;
  sentByName: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  state: BatchState;
  counts: {
    intended: number;
    sent: number;
    delivered: number;
    opened: number;
    bounced: number;
    failed: number;
    queued: number;
    skipped: number;
    trackingCapable: number;
  };
}

const TONE: Record<BatchState, string> = {
  SENDING: "bg-orange-accent/15 text-charcoal border-orange-accent",
  SENT: "bg-lime-accent/20 text-charcoal border-lime-accent",
  PROBLEMS: "bg-red-50 text-red-700 border-red-200",
  NOTHING_SENT: "bg-app-bg text-text-muted border-app-border",
};

export default function EmailResultsListPage() {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/emails/batches")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load");
        return r.json();
      })
      .then((d) => setBatches(d.batches))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
      <h1 className="text-2xl sm:text-3xl font-semibold text-text-primary mb-1">Email sends</h1>
      <p className="text-sm text-text-muted mb-6">
        Every batch you have sent — from the Members tab, from announcements, or from a price change —
        with what actually happened to each one.
      </p>

      {!batches ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : batches.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-8 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Mail className="h-7 w-7" strokeWidth={2} />
          </div>
          <div className="text-sm font-medium text-text-primary mb-1">No email sends yet</div>
          <div className="text-sm text-text-muted">
            Select members on the Members tab and choose Email, or send an announcement.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {batches.map((b) => (
            <Link
              key={b.sendBatchId}
              href={`/dashboard/communication/results/${encodeURIComponent(b.sendBatchId)}`}
              className="block bg-surface border border-app-border rounded-xl p-4 hover:bg-app-bg transition-colors"
            >
              <div className="flex flex-wrap items-start justify-between gap-2 mb-1.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">{b.subject}</div>
                  <div className="text-xs text-text-muted">
                    {b.startedAt ? new Date(b.startedAt).toLocaleString() : "—"}
                    {b.sentByName && <> · sent by {b.sentByName}</>}
                    {" · "}{b.kind}
                  </div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${TONE[b.state]}`}>
                  {batchStateLabel(b.state)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                <span><strong className="text-text-primary">{b.counts.sent}</strong> sent</span>
                <span><strong className="text-text-primary">{b.counts.delivered}</strong> delivered</span>
                {b.counts.queued > 0 && <span className="text-orange-accent"><strong>{b.counts.queued}</strong> queued</span>}
                {/* Open counts are only meaningful against the tracking-capable
                    subset, so the list never shows a bare open number. */}
                {b.counts.trackingCapable > 0 && (
                  <span><strong className="text-text-primary">{b.counts.opened}</strong> opened of {b.counts.trackingCapable} tracked</span>
                )}
                {b.counts.skipped > 0 && <span><strong className="text-text-primary">{b.counts.skipped}</strong> skipped</span>}
                {b.counts.bounced > 0 && <span className="text-red-700"><strong>{b.counts.bounced}</strong> bounced</span>}
                {b.counts.failed > 0 && <span className="text-red-700"><strong>{b.counts.failed}</strong> failed</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
