"use client";

// Check-in mode (design handoff §3 header action) — the door view, built for
// a phone in one hand at 375px: big rows, a search box, one tap to check in.
//
// Writes go through the EXISTING attendance route and nothing else:
//   Check in   POST   /api/attendance {eventId, memberId, status: "PRESENT"}
//              (attendance:edit; its no-membership 409 is shown as a sheet,
//              and "Check in anyway" re-sends with confirmNoMembership)
//   Undo       DELETE /api/attendance?recordId=  (attendance:full — the
//              route's "added by accident" path); without that permission it
//              falls back to POST status "ABSENT" so the tap is still undone.
// Who is already in comes from the AttendanceRecords the attendees loader
// reads. The payment gate is lib/eventPayments.checkinPaymentBlock — the same
// rule the member self check-in route enforces.

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import Sheet from "@/components/Sheet";
import type { AttendeeRow } from "@/lib/eventAttendees";
import {
  checkInCounts,
  checkInRows,
  filterCheckIn,
  type CheckInRecord,
  type CheckInRow,
} from "@/lib/eventAttendeeExtras";
import { initials } from "@/lib/eventAttendeeActions";

const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";
const time = (s: string) => new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

type Prompt = { row: AttendeeRow; message: string };

export default function CheckInView({
  eventId,
  rows,
  checkIns,
  requirePaymentBeforeCheckin,
  cashRecordable,
  onRecordCash,
}: {
  eventId: string;
  rows: AttendeeRow[];
  checkIns: CheckInRecord[];
  requirePaymentBeforeCheckin: boolean;
  cashRecordable: (r: AttendeeRow) => boolean;
  /** Opens the screen's existing "Record cash" confirm for this row. */
  onRecordCash: (r: AttendeeRow) => void;
}) {
  const [recs, setRecs] = useState<CheckInRecord[]>(checkIns);
  useEffect(() => setRecs(checkIns), [checkIns]);
  const [query, setQuery] = useState("");
  const [notYet, setNotYet] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const list = useMemo(
    () => checkInRows(rows, recs, { requirePaymentBeforeCheckin, cashRecordable }),
    [rows, recs, requirePaymentBeforeCheckin, cashRecordable],
  );
  const counts = checkInCounts(list);
  const shown = filterCheckIn(list, query, notYet);
  const pct = counts.expected > 0 ? Math.round((counts.checkedIn / counts.expected) * 100) : 0;

  function upsert(rec: CheckInRecord) {
    setRecs((prev) => [...prev.filter((r) => r.recordId !== rec.recordId && r.memberId !== rec.memberId), rec]);
  }

  async function checkIn(r: AttendeeRow, confirmNoMembership = false) {
    if (!r.memberId) return;
    setBusy(r.id);
    setErr(null);
    try {
      const res = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, memberId: r.memberId, status: "PRESENT", confirmNoMembership }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d?.needsConfirmation) {
        setPrompt({ row: r, message: typeof d.message === "string" ? d.message : `${r.name} has no active membership.` });
        return;
      }
      if (!res.ok) {
        setErr({
          id: r.id,
          text: typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : "Couldn't check them in — try again.",
        });
        return;
      }
      setPrompt(null);
      upsert({ recordId: d.id, memberId: r.memberId, status: d.status ?? "PRESENT", checkedInAt: d.checkedInAt ?? new Date().toISOString() });
    } finally {
      setBusy(null);
    }
  }

  async function undo(x: CheckInRow) {
    if (x.state.kind !== "in" || !x.row.memberId) return;
    const rec = x.state.record;
    setBusy(x.row.id);
    setErr(null);
    try {
      const del = await fetch(`/api/attendance?recordId=${encodeURIComponent(rec.recordId)}`, { method: "DELETE" });
      if (del.ok) {
        setRecs((prev) => prev.filter((c) => c.recordId !== rec.recordId));
        return;
      }
      if (del.status === 403) {
        const res = await fetch("/api/attendance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, memberId: x.row.memberId, status: "ABSENT" }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
          upsert({ ...rec, status: "ABSENT" });
          return;
        }
        setErr({ id: x.row.id, text: typeof d.error === "string" ? d.error : "Couldn't undo — try again." });
        return;
      }
      const d = await del.json().catch(() => ({}));
      setErr({ id: x.row.id, text: typeof d.error === "string" ? d.error : "Couldn't undo — try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Counter + search stay put while the list scrolls */}
      <div className="sticky top-0 z-[1] bg-surface border-b border-app-border px-4 sm:px-5 pt-3 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[20px] font-bold tabular-nums text-text-primary" aria-live="polite">{counts.label}</div>
          <div className="text-[13px] text-text-muted tabular-nums">{counts.notYet} not yet here</div>
        </div>
        <div className="mt-2 h-2 rounded-full bg-app-bg overflow-hidden" aria-hidden="true">
          <div className="h-full bg-success-text rounded-full transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-3 flex gap-2">
          <label className="relative flex-1 min-w-0">
            <span className="sr-only">Search attendees</span>
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, phone"
              autoComplete="off"
              className="w-full min-h-12 pl-10 pr-3 rounded-[12px] border border-app-border bg-surface text-[16px] text-text-primary"
            />
          </label>
          <button
            type="button"
            aria-pressed={notYet}
            onClick={() => setNotYet((v) => !v)}
            className={`min-h-12 px-3 rounded-[12px] text-[14px] font-semibold whitespace-nowrap flex-shrink-0 ${notYet ? "bg-brand text-white" : "border border-app-border text-text-primary"}`}
          >
            Not yet here
          </button>
        </div>
        {(requirePaymentBeforeCheckin || counts.noMember > 0) && (
          <p className="mt-2 text-[12.5px] text-text-muted">
            {requirePaymentBeforeCheckin ? "This event requires payment before check-in." : ""}
            {requirePaymentBeforeCheckin && counts.noMember > 0 ? " " : ""}
            {counts.noMember > 0 ? `${counts.noMember} public signup${counts.noMember === 1 ? " has" : "s have"} no member record and can't be checked in here.` : ""}
          </p>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="p-10 text-center text-[15px] text-text-muted">
          {list.length === 0 ? "Nobody is expected at this event yet." : notYet && !query ? "Everyone's here." : "Nobody matches."}
        </div>
      ) : (
        <ul className="divide-y divide-hairline">
          {shown.map((x) => {
            const r = x.row;
            const s = x.state;
            const isBusy = busy === r.id;
            return (
              <li key={r.id} className={`px-4 sm:px-5 py-3 min-h-[64px] flex items-center gap-3 ${s.kind === "in" ? "bg-success-surface" : ""}`}>
                <div className="w-11 h-11 rounded-full bg-app-bg flex items-center justify-center text-[14px] font-semibold text-text-muted flex-shrink-0">{initials(r.name)}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-[16px] font-semibold text-text-primary truncate">{r.name}</div>
                  <div className="text-[13px] text-text-muted truncate">
                    {[r.categoryValue, r.source === "PUBLIC" ? "Public signup" : null, r.label].filter(Boolean).join(" · ")}
                  </div>
                  {s.kind === "in" && s.record.checkedInAt && (
                    <div className="text-[13px] font-semibold text-success-text">Checked in {time(s.record.checkedInAt)}</div>
                  )}
                  {s.kind === "blocked" && <div className="text-[13px] text-warn-text mt-0.5">{s.reason}</div>}
                  {s.kind === "noMember" && <div className="text-[13px] text-text-muted mt-0.5">{s.reason}</div>}
                  {err?.id === r.id && <div className="text-[13px] text-danger-text mt-0.5" role="alert">{err.text}</div>}
                </div>
                <div className="flex-shrink-0">
                  {s.kind === "in" ? (
                    <button type="button" disabled={isBusy} onClick={() => undo(x)} className={`${btn} min-h-12 border border-app-border bg-surface text-text-primary`}>
                      {isBusy ? "…" : "Undo"}
                    </button>
                  ) : s.kind === "ready" ? (
                    <button type="button" disabled={isBusy} onClick={() => checkIn(r)} className={`${btn} min-h-12 px-5 bg-brand text-white hover:bg-brand-hover`}>
                      {isBusy ? "Checking…" : "Check in"}
                    </button>
                  ) : s.kind === "blocked" && s.canRecordCash ? (
                    <button type="button" onClick={() => onRecordCash(r)} className={`${btn} min-h-12 border border-warn-border bg-warn-surface text-warn-text`}>
                      Record cash
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {prompt && (
        <Sheet
          open
          onClose={() => setPrompt(null)}
          title={`Check in ${prompt.row.name}?`}
          description={prompt.message}
          footer={
            <>
              <button type="button" className={`${btn} border border-app-border text-text-primary`} onClick={() => setPrompt(null)}>
                Cancel
              </button>
              <button type="button" className={`${btn} bg-brand text-white hover:bg-brand-hover`} disabled={busy === prompt.row.id} onClick={() => checkIn(prompt.row, true)}>
                {busy === prompt.row.id ? "Checking…" : "Check in anyway"}
              </button>
            </>
          }
        >
          <p className="text-[14px] text-text-primary">
            They&apos;re on this event&apos;s list ({prompt.row.label.toLowerCase()}). The attendance record asks because they have no membership — checking in to the event doesn&apos;t bill them.
          </p>
          {err?.id === prompt.row.id && <p className="mt-3 text-[12.5px] text-danger-text">{err.text}</p>}
        </Sheet>
      )}
    </div>
  );
}
