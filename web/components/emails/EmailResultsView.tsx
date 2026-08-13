"use client";

// The results body shared by the announcement results page and the
// batch results page. One send is one send — the only difference
// between the two surfaces is what sits above this: an announcement
// header, or a batch header.

import { MailCheck, MailWarning, MousePointerClick, EyeOff } from "lucide-react";

export interface ResultCounts {
  intended: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
  queued: number;
  skipped: number;
  skippedNoEmail: number;
  skippedOptedOut: number;
  skippedInvalid: number;
  skippedDuplicate: number;
  skippedNoProvider: number;
  trackingCapable: number;
}

export interface ResultRow {
  id: string;
  status: string;
  skippedReason: string | null;
  error: string | null;
  recipientEmail: string;
  recipientName?: string | null;
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

export function EmailResultsView({ counts: c, rows }: { counts: ResultCounts; rows: ResultRow[] }) {
  const pctOfTracked = (n: number) =>
    c.trackingCapable ? Math.round((n / c.trackingCapable) * 100) : 0;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Intended" value={c.intended} />
        <Stat label="Sent" value={c.sent} />
        <Stat label="Delivered" value={c.delivered} />
        <Stat label="Bounced" value={c.bounced} tone={c.bounced > 0 ? "red" : "grey"} />
      </div>

      {/* Still in the queue — the 3M large-send path hands off to the
          cron worker, so "sent 0" on a fresh 300-recipient blast is
          normal for a few minutes and must not read as a failure. */}
      {c.queued > 0 && (
        <div className="bg-orange-accent/10 border border-orange-accent rounded-xl p-4 mb-4 text-sm text-charcoal">
          <strong>{c.queued.toLocaleString()}</strong> still queued. Large sends are dispatched by a
          background worker that runs every few minutes — reload this page to see them land.
        </div>
      )}

      <div className="bg-surface border border-app-border rounded-xl p-5 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-semibold text-text-primary">Engagement</h2>
          <span className="text-xs text-text-muted">
            {c.trackingCapable} of {c.intended} rows are tracking-capable
            {c.trackingCapable < c.intended && " (SMTP-only sends aren't tracked)"}
          </span>
        </div>
        {c.trackingCapable === 0 ? (
          <div className="text-sm text-text-muted flex items-center gap-2">
            <EyeOff className="h-4 w-4" strokeWidth={2} />
            Open/click tracking unavailable for this send. Nothing here can tell you whether it was read.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <EngagementStat
              label="Opened"
              icon={<MailCheck className="h-4 w-4" strokeWidth={2} />}
              value={c.opened}
              basis={`${pctOfTracked(c.opened)}% of ${c.trackingCapable} tracked`}
            />
            <EngagementStat
              label="Clicked"
              icon={<MousePointerClick className="h-4 w-4" strokeWidth={2} />}
              value={c.clicked}
              basis={`${pctOfTracked(c.clicked)}% of ${c.trackingCapable} tracked`}
            />
            {/* Bounces are counted against everyone the send was aimed
                at, not against the tracking-capable subset — a bounce
                needs no tracking pixel to be real. Labelling this "of N
                tracked" would be the wrong denominator with the wrong
                name attached. */}
            <EngagementStat
              label="Bounced"
              icon={<MailWarning className="h-4 w-4" strokeWidth={2} />}
              value={c.bounced}
              basis={`${c.intended ? Math.round((c.bounced / c.intended) * 100) : 0}% of ${c.intended} intended`}
              tone={c.bounced > 0 ? "red" : "grey"}
            />
          </div>
        )}
      </div>

      {(c.skipped > 0 || c.failed > 0) && (
        <div className="bg-surface border border-app-border rounded-xl p-5 mb-4">
          <h2 className="text-sm font-semibold text-text-primary mb-3">Not delivered</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            {c.skippedNoEmail > 0 && <Info label="No email on file" value={c.skippedNoEmail} />}
            {c.skippedOptedOut > 0 && <Info label="Opted out" value={c.skippedOptedOut} />}
            {c.skippedInvalid > 0 && <Info label="Invalid address" value={c.skippedInvalid} />}
            {c.skippedDuplicate > 0 && <Info label="Duplicate in batch" value={c.skippedDuplicate} />}
            {c.skippedNoProvider > 0 && <Info label="No email provider configured" value={c.skippedNoProvider} tone="red" />}
            {c.failed > 0 && <Info label="Provider failed" value={c.failed} tone="red" />}
          </div>
        </div>
      )}

      <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border">
          <h2 className="text-sm font-semibold text-text-primary">Recipients</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                <Th>Recipient</Th>
                <Th>Status</Th>
                <Th>Delivered</Th>
                <Th>Opened</Th>
                <Th>Clicked</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {rows.slice(0, 500).map((r) => (
                <tr key={r.id}>
                  <Td>
                    {r.recipientName && (
                      <div className="text-text-primary">{r.recipientName}</div>
                    )}
                    <div className="font-mono text-xs text-text-muted">{r.recipientEmail}</div>
                  </Td>
                  <Td><RowStatus row={r} /></Td>
                  <Td className="text-xs text-text-muted">
                    {r.deliveredAt ? new Date(r.deliveredAt).toLocaleString() : "—"}
                  </Td>
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
                  <Td className="text-xs text-text-muted">{rowNote(r)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 500 && (
          <div className="px-5 py-2 text-xs text-text-muted border-t border-app-border">
            Showing first 500 of {rows.length}.
          </div>
        )}
      </div>
    </>
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

function EngagementStat({ label, value, basis, icon, tone = "grey" }: { label: string; value: number; basis: string; icon: React.ReactNode; tone?: "grey" | "red" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "red" ? "border-red-200 bg-red-50" : "border-app-border bg-app-bg/40"}`}>
      <div className="flex items-center gap-1.5 text-xs text-text-muted uppercase tracking-wider mb-1">
        {icon} {label}
      </div>
      <div className="text-xl font-semibold text-text-primary">{value.toLocaleString()}</div>
      <div className="text-[11px] text-text-muted">{basis}</div>
    </div>
  );
}

function Info({ label, value, tone = "grey" }: { label: string; value: number; tone?: "grey" | "red" }) {
  // Boxed so the count stays visually attached to its label. Bare
  // label/value rows in a wide 3-column grid put the number a third of
  // the page away from the thing it counts.
  return (
    <div className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${tone === "red" ? "border-red-200 bg-red-50" : "border-app-border bg-app-bg/40"}`}>
      <span className={tone === "red" ? "text-red-700" : "text-text-muted"}>{label}</span>
      <span className={`font-semibold ${tone === "red" ? "text-red-700" : "text-text-primary"}`}>{value}</span>
    </div>
  );
}

// The skippedReason column stores machine enums. Nobody running a club
// should have to read DUPLICATE_IN_BATCH.
const SKIP_LABEL: Record<string, string> = {
  NO_EMAIL: "No email on file",
  OPTED_OUT: "Opted out of email",
  INVALID_ADDRESS: "Invalid address",
  DUPLICATE_IN_BATCH: "Duplicate — already in this send",
  NO_PROVIDER: "No email provider configured",
};

function rowNote(r: ResultRow): string {
  if (r.error) return r.error;
  if (!r.skippedReason) return "";
  return SKIP_LABEL[r.skippedReason] ?? r.skippedReason;
}

function RowStatus({ row }: { row: ResultRow }) {
  if (row.status === "FAILED") return <span className="text-xs text-red-700">Failed</span>;
  if (row.status === "SKIPPED") return <span className="text-xs text-orange-accent">Skipped</span>;
  if (row.bouncedAt) return <span className="text-xs text-red-700">Bounced</span>;
  if (row.clickedAt) return <span className="text-xs text-charcoal font-medium">Clicked</span>;
  if (row.openedAt) return <span className="text-xs text-charcoal font-medium">Opened</span>;
  if (row.deliveredAt) return <span className="text-xs text-brand">Delivered</span>;
  if (row.status === "QUEUED") return <span className="text-xs text-orange-accent">Queued</span>;
  if (row.status === "SENT") return <span className="text-xs text-text-muted">Sent</span>;
  return <span className="text-xs text-text-muted">{row.status}</span>;
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-4 py-2">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 ${className ?? ""}`}>{children}</td>;
}
