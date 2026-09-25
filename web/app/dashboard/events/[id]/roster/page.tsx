"use client";

// B16 — the coach's roster grid: rosters across the top, positions down the
// side, names in the cells. Pending = waiting on the coach; the waitlist sits
// under the grid. Read-only here — approving, declining and proposing a
// different spot happen in Approvals and on the event's attendees.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Download, ArrowLeft } from "lucide-react";

type Person = { entryId: string; registrationId: string; name: string; memberId: string | null; state: "confirmed" | "pending" | "waitlist" };
type Grid = {
  columns: { id: string; label: string }[];
  rows: { position: { id: string; label: string; capacity: number | null }; cells: { rosterId: string; people: Person[]; taken: number; capacity: number | null }[] }[];
  waitlist: (Person & { rosterLabel: string; positionLabel: string })[];
  unplaced: Person[];
  counts: { confirmed: number; pending: number; waitlist: number };
};
type Data = { event: { id: string; name: string; startsAt: string; requiresCoachApproval: boolean }; grid: Grid };

function Name({ p }: { p: Person }) {
  const body = (
    <span className={p.state === "pending" ? "text-text-muted" : "text-text-primary"}>
      {p.name}
      {p.state === "pending" && <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-700">pending</span>}
    </span>
  );
  return p.memberId ? <Link href={`/dashboard/members/${p.memberId}`} className="hover:underline">{body}</Link> : body;
}

export default function RosterGridPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/events/${id}/roster`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) setError(typeof d.error === "string" ? d.error : "Couldn't load the roster.");
        else setData(d as Data);
      })
      .catch(() => setError("Couldn't reach the server."));
  }, [id]);

  if (error) return <div className="max-w-5xl mx-auto px-4 py-6 text-sm text-red-600">{error}</div>;
  if (!data) return <div className="max-w-5xl mx-auto px-4 py-6"><div className="h-40 rounded-xl border border-app-border bg-surface animate-pulse" /></div>;

  const g = data.grid;
  const empty = g.columns.length === 0 || g.rows.length === 0;

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-6">
      <Link href="/dashboard/events" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary mb-3">
        <ArrowLeft size={14} /> Events
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{data.event.name} — roster</h1>
          <p className="text-sm text-text-muted mt-1">
            {new Date(data.event.startsAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
            {" · "}{g.counts.confirmed} confirmed
            {data.event.requiresCoachApproval ? ` · ${g.counts.pending} pending` : ""}
            {g.counts.waitlist ? ` · ${g.counts.waitlist} waitlist` : ""}
          </p>
        </div>
        {!empty && (
          <div className="flex gap-2">
            <a href={`/api/events/${id}/roster/export?format=pdf`} className="inline-flex items-center gap-1.5 min-h-[44px] md:min-h-0 text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">
              <Download size={14} /> PDF
            </a>
            <a href={`/api/events/${id}/roster/export?format=csv`} className="inline-flex items-center gap-1.5 min-h-[44px] md:min-h-0 text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">
              <Download size={14} /> CSV
            </a>
          </div>
        )}
      </div>

      {empty ? (
        <div className="rounded-xl border border-app-border bg-surface p-8 text-center text-sm text-text-muted">
          This event has no roster yet. Add rosters and positions in the event&apos;s <strong>Roster positions</strong> card.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-app-border bg-surface">
          <table className="min-w-full text-sm border-collapse">
            <thead>
              <tr className="bg-app-bg">
                <th className="sticky left-0 z-10 bg-app-bg text-left text-xs font-medium text-text-muted px-3 py-2 border-b border-app-border">Position</th>
                {g.columns.map((c) => (
                  <th key={c.id} className="text-left text-xs font-semibold text-text-primary px-3 py-2 border-b border-l border-app-border whitespace-nowrap">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.rows.map((row) => (
                <tr key={row.position.id} className="align-top">
                  <th scope="row" className="sticky left-0 z-10 bg-surface text-left font-semibold text-text-primary px-3 py-2 border-b border-app-border whitespace-nowrap">
                    {row.position.label}
                    {row.position.capacity != null && <span className="block text-[10px] font-normal text-text-muted">cap {row.position.capacity}</span>}
                  </th>
                  {row.cells.map((c) => {
                    const full = c.capacity != null && c.taken >= c.capacity;
                    return (
                      <td key={c.rosterId} className="px-3 py-2 border-b border-l border-app-border min-w-[140px]">
                        {c.people.length === 0 ? (
                          <span className="text-text-muted text-xs">—</span>
                        ) : (
                          <ul className="space-y-0.5">{c.people.map((p) => <li key={p.entryId}><Name p={p} /></li>)}</ul>
                        )}
                        {full && <span className="block text-[10px] text-text-muted mt-0.5">full</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {g.waitlist.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-text-primary mb-2">Waitlist</h2>
          <div className="rounded-xl border border-app-border bg-surface divide-y divide-app-border">
            {g.waitlist.map((w) => (
              <div key={w.entryId} className="px-3 py-2 text-sm flex justify-between gap-3">
                <Name p={w} />
                <span className="text-text-muted text-xs">{w.positionLabel} · {w.rosterLabel}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-text-muted mt-1.5">Approve them from Approvals once a spot opens, or propose another spot on the event.</p>
        </div>
      )}

      {g.unplaced.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-text-primary mb-2">Signed up without a spot</h2>
          <p className="text-sm text-text-primary">{g.unplaced.map((p) => p.name).join(", ")}</p>
        </div>
      )}
    </div>
  );
}
