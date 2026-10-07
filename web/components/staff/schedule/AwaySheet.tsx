"use client";

// "I'm out for several days" — a coach calls out of every class day they are
// scheduled on in a date range (POST /api/staff/me/call-out-range). Their
// weekly assignment is not changed; each class stays on and needs coverage.
// The classes it would touch are listed BEFORE anything is sent, read from the
// coach's own schedule (GET /api/staff/schedule).
import { useEffect, useState } from "react";
import Sheet from "@/components/Sheet";
import { range12h } from "@/lib/time12";
import { fmtDayShort, isYmd, type StaffStatus } from "@/lib/classStaff";

const btn =
  "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";
const field =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary md:min-h-[36px]";
const dangerBox = { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" };

type Affected = { key: string; name: string; date: string; startTime: string; endTime: string };
type FeedClass = {
  classId: string; sessionId: string | null; name: string; date: string; startTime: string; endTime: string;
  canceled: boolean; switched?: boolean; myStatus?: StaffStatus | null;
};

export default function AwaySheet({
  today,
  onClose,
  onDone,
}: {
  /** YYYY-MM-DD — the earliest day that can be picked. */
  today: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  const [affected, setAffected] = useState<Affected[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = isYmd(from) && isYmd(to) && from >= today && to >= from;

  useEffect(() => {
    if (!valid) {
      setAffected(null);
      setListError(null);
      return;
    }
    let live = true;
    setAffected(null);
    setListError(null);
    fetch(`/api/staff/schedule?from=${from}&to=${to}`, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
      .then(({ ok, d }) => {
        if (!live) return;
        if (!ok) {
          setListError(typeof d?.error === "string" ? d.error : "Couldn't load your classes for those days.");
          return;
        }
        const me = (Array.isArray(d.staff) ? d.staff : []).find((s: { id: string }) => s.id === d.viewer?.userId);
        const mine: FeedClass[] = me?.classes ?? [];
        setAffected(
          mine
            .filter((c) => c.switched && c.sessionId && !c.canceled && c.myStatus === "SCHEDULED")
            .map((c) => ({ key: `${c.classId}:${c.date}`, name: c.name, date: c.date, startTime: c.startTime, endTime: c.endTime })),
        );
      })
      .catch(() => live && setListError("Couldn't load your classes for those days."));
    return () => {
      live = false;
    };
  }, [from, to, valid]);

  async function submit() {
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch("/api/staff/me/call-out-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromDate: from, toDate: to, reason: reason.trim() || null }),
      });
    } catch {
      setBusy(false);
      setError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof d?.error === "string" ? d.error : "Couldn't record your time away.");
      return;
    }
    const n = typeof d.count === "number" ? d.count : 0;
    const late = typeof d.lateCount === "number" && d.lateCount > 0 ? ` ${d.lateCount} marked as a late call-out.` : "";
    onDone(n === 0 ? "You had no classes to call out of on those days." : `You're called out of ${n} class day${n === 1 ? "" : "s"}. Each one now needs coverage.${late}`);
  }

  const n = affected?.length ?? 0;
  return (
    <Sheet
      open
      onClose={() => !busy && onClose()}
      title="I'm out for several days"
      description="Call out of every class you are coaching between two dates."
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
            Never mind
          </button>
          <button type="button" onClick={submit} disabled={busy || !valid || !affected || n === 0} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
            {busy ? "Saving…" : n > 0 ? `Call out of ${n} class day${n === 1 ? "" : "s"}` : "Call out"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="away-from" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">First day out</label>
            <input id="away-from" type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} className={field} />
          </div>
          <div>
            <label htmlFor="away-to" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Last day out</label>
            <input id="away-to" type="date" min={from || today} value={to} onChange={(e) => setTo(e.target.value)} className={field} />
          </div>
        </div>
        <div>
          <label htmlFor="away-reason" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Reason (optional)</label>
          <textarea id="away-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
            className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary" placeholder="e.g. Away at a competition" />
        </div>

        <section aria-label="Classes affected">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Classes you would be called out of</p>
          {!valid ? (
            <p className="text-[13px] text-text-muted">Pick a first and last day, today or later.</p>
          ) : listError ? (
            <p role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>{listError}</p>
          ) : !affected ? (
            <p className="text-[13px] text-text-muted">Loading your classes…</p>
          ) : n === 0 ? (
            <p className="text-[13px] text-text-muted">You are not coaching any class on those days.</p>
          ) : (
            <ul className="divide-y divide-app-border rounded-lg border border-app-border">
              {affected.map((c) => (
                <li key={c.key} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-[13px]">
                  <span className="font-medium text-text-primary">{c.name}</span>
                  <span className="text-text-muted">{fmtDayShort(c.date)} · {range12h(c.startTime, c.endTime)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {n > 0 && (
          <p className="text-[13px] text-text-primary">
            These classes stay on the schedule and each one will need coverage. Your weekly classes after {fmtDayShort(to)} are not changed.
            {" "}Whoever your club has chosen to hear about call-outs is told once, with the full list. A class starting in under 2 hours is marked as a late call-out.
          </p>
        )}
        {error && <p role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>{error}</p>}
      </div>
    </Sheet>
  );
}
