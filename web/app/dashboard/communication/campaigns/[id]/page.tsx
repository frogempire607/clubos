"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, MailCheck, MailWarning, MousePointerClick, EyeOff } from "lucide-react";

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

interface Counts {
  intended: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
  skipped: number;
  skippedNoEmail: number;
  skippedOptedOut: number;
  skippedInvalid: number;
  skippedDuplicate: number;
  trackingCapable: number;
}

interface Row {
  id: string;
  status: string;
  skippedReason: string | null;
  error: string | null;
  recipientEmail: string;
  providerMessageId: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  openCount: number;
  clickedAt: string | null;
  clickCount: number;
  bouncedAt: string | null;
}

export default function AnnouncementResultsPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<null | {
    announcement: Announcement;
    counts: Counts | null;
    rows: Row[];
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
  const pctOfTracked = (n: number) => c && c.trackingCapable
    ? Math.round((n / c.trackingCapable) * 100)
    : 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
      <div className="mb-4">
        <Link href="/dashboard/announcements" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Announcements
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
        <>
          {/* Top-line counters — plan §3G "campaign-level results". */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat label="Intended" value={c.intended} />
            <Stat label="Sent" value={c.sent} />
            <Stat label="Delivered" value={c.delivered} />
            <Stat label="Bounced" value={c.bounced} tone={c.bounced > 0 ? "red" : "grey"} />
          </div>

          {/* Tracking-adjusted engagement. Only rows whose provider gives
              us open/click callbacks count in the denominator. plan §3G
              "Never claim an email was opened when tracking is unavailable
              or blocked." */}
          <div className="bg-surface border border-app-border rounded-xl p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-text-primary">Engagement</h2>
              <span className="text-xs text-text-muted">
                {c.trackingCapable} of {c.intended} rows are tracking-capable
                {c.trackingCapable < c.intended && " (SMTP-only sends aren't tracked)"}
              </span>
            </div>
            {c.trackingCapable === 0 ? (
              <div className="text-sm text-text-muted flex items-center gap-2">
                <EyeOff className="h-4 w-4" strokeWidth={2} />
                Open/click tracking unavailable for this send. All delivery to SMTP-only recipients.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <EngagementStat
                  label="Opened"
                  icon={<MailCheck className="h-4 w-4" strokeWidth={2} />}
                  value={c.opened}
                  denom={c.trackingCapable}
                  pct={pctOfTracked(c.opened)}
                />
                <EngagementStat
                  label="Clicked"
                  icon={<MousePointerClick className="h-4 w-4" strokeWidth={2} />}
                  value={c.clicked}
                  denom={c.trackingCapable}
                  pct={pctOfTracked(c.clicked)}
                />
                <EngagementStat
                  label="Bounced"
                  icon={<MailWarning className="h-4 w-4" strokeWidth={2} />}
                  value={c.bounced}
                  denom={c.intended}
                  pct={c.intended ? Math.round((c.bounced / c.intended) * 100) : 0}
                  tone={c.bounced > 0 ? "red" : "grey"}
                />
              </div>
            )}
          </div>

          {/* Skipped-reason breakdown. Plan §3G calls out these specific
              categories so senders can act ("N members skipped — no email
              on file"). */}
          {(c.skipped > 0 || c.failed > 0) && (
            <div className="bg-surface border border-app-border rounded-xl p-5 mb-4">
              <h2 className="text-sm font-semibold text-text-primary mb-3">Not delivered</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                {c.skippedNoEmail > 0 && <Info label="No email on file" value={c.skippedNoEmail} />}
                {c.skippedOptedOut > 0 && <Info label="Opted out" value={c.skippedOptedOut} />}
                {c.skippedInvalid > 0 && <Info label="Invalid address" value={c.skippedInvalid} />}
                {c.skippedDuplicate > 0 && <Info label="Duplicate in batch" value={c.skippedDuplicate} />}
                {c.failed > 0 && <Info label="Provider failed" value={c.failed} tone="red" />}
              </div>
            </div>
          )}

          {/* Per-recipient timeline. Cap the render at 500 rows so a
              1000-recipient blast doesn't blow the DOM. */}
          <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-app-border">
              <h2 className="text-sm font-semibold text-text-primary">Recipients</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-app-bg border-b border-app-border">
                  <tr>
                    <Th>Address</Th>
                    <Th>Status</Th>
                    <Th>Delivered</Th>
                    <Th>Opened</Th>
                    <Th>Clicked</Th>
                    <Th>Note</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {data.rows.slice(0, 500).map((r) => (
                    <tr key={r.id}>
                      <Td className="font-mono text-xs">{r.recipientEmail}</Td>
                      <Td>
                        <RowStatus row={r} />
                      </Td>
                      <Td className="text-xs text-text-muted">{r.deliveredAt ? new Date(r.deliveredAt).toLocaleString() : "—"}</Td>
                      <Td className="text-xs text-text-muted">
                        {r.openedAt
                          ? `${new Date(r.openedAt).toLocaleString()}${r.openCount > 1 ? ` (${r.openCount}×)` : ""}`
                          : r.providerMessageId ? "—" : "not tracked"}
                      </Td>
                      <Td className="text-xs text-text-muted">
                        {r.clickedAt
                          ? `${new Date(r.clickedAt).toLocaleString()}${r.clickCount > 1 ? ` (${r.clickCount}×)` : ""}`
                          : r.providerMessageId ? "—" : "not tracked"}
                      </Td>
                      <Td className="text-xs text-text-muted">
                        {r.error ?? r.skippedReason ?? ""}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.rows.length > 500 && (
              <div className="px-5 py-2 text-xs text-text-muted border-t border-app-border">
                Showing first 500 of {data.rows.length}.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "grey" }: { label: string; value: number; tone?: "grey" | "red" }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === "red" ? "border-red-200 bg-red-50" : "border-app-border bg-surface"}`}>
      <div className={`text-2xl font-semibold ${tone === "red" ? "text-red-700" : "text-text-primary"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] text-text-muted uppercase tracking-wider">{label}</div>
    </div>
  );
}

function EngagementStat({ label, value, denom, pct, icon, tone = "grey" }: { label: string; value: number; denom: number; pct: number; icon: React.ReactNode; tone?: "grey" | "red" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "red" ? "border-red-200 bg-red-50" : "border-app-border bg-app-bg/40"}`}>
      <div className="flex items-center gap-1.5 text-xs text-text-muted uppercase tracking-wider mb-1">
        {icon} {label}
      </div>
      <div className="text-xl font-semibold text-text-primary">{value.toLocaleString()}</div>
      <div className="text-[11px] text-text-muted">{pct}% of {denom} tracked</div>
    </div>
  );
}

function Info({ label, value, tone = "grey" }: { label: string; value: number; tone?: "grey" | "red" }) {
  return (
    <div className="flex items-center justify-between">
      <span className={tone === "red" ? "text-red-700" : "text-text-muted"}>{label}</span>
      <span className={`font-semibold ${tone === "red" ? "text-red-700" : "text-text-primary"}`}>{value}</span>
    </div>
  );
}

function RowStatus({ row }: { row: Row }) {
  if (row.status === "FAILED") return <span className="text-xs text-red-700">Failed</span>;
  if (row.status === "SKIPPED") return <span className="text-xs text-orange-accent">Skipped</span>;
  if (row.bouncedAt) return <span className="text-xs text-red-700">Bounced</span>;
  if (row.clickedAt) return <span className="text-xs text-charcoal font-medium">Clicked</span>;
  if (row.openedAt) return <span className="text-xs text-charcoal font-medium">Opened</span>;
  if (row.deliveredAt) return <span className="text-xs text-brand">Delivered</span>;
  if (row.status === "SENT") return <span className="text-xs text-text-muted">Sent</span>;
  return <span className="text-xs text-text-muted">{row.status}</span>;
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-4 py-2">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 ${className ?? ""}`}>{children}</td>;
}
