"use client";

// Attendees — the read-only merged roster + money screen from the events
// design handoff (options 1c desktop / 1d phone). One list where the Bookings
// and Registrations modals used to be two.
//
// READ-ONLY by design for this slice. Every number on screen is derived from
// the ledger served by GET /api/events/[id]/attendees; the tiles, the filter
// counts and the capacity line are the same rows counted differently. Actions
// that write (record cash, approve, resend, add someone) still live in the
// Registrations and Bookings modals — the two links in the footer open them —
// because registration is the money spine and this screen must never become a
// second way to write event money.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { AttendeeFilter, AttendeeLedger, AttendeeRow, AttendeeTone } from "@/lib/eventAttendees";
import { matchesFilter } from "@/lib/eventAttendees";
import { SkeletonList } from "@/components/LoadingSkeleton";

type Payload = {
  event: {
    id: string;
    name: string;
    startsAt: string;
    endsAt: string;
    capacity: number | null;
    publicSlug: string | null;
    sessionCount: number;
    categoryLabel: string | null;
  };
  ledger: AttendeeLedger;
};

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function dateRange(a: string, b: string) {
  const s = new Date(a), e = new Date(b);
  return s.toDateString() === e.toDateString() ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`;
}

const TONE: Record<AttendeeTone, CSSProperties> = {
  paid: { background: "var(--color-success-surface)", color: "var(--color-success-text)" },
  owed: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" },
  warn: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" },
  muted: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  info: { background: "var(--color-info-surface)", color: "var(--color-brand)" },
};

const FILTERS: { key: AttendeeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "owes", label: "Owes money" },
  { key: "waiting", label: "Waiting on you" },
  { key: "scheduled", label: "Card scheduled" },
  { key: "settled", label: "Settled" },
];

function StatusPill({ r }: { r: AttendeeRow }) {
  const label =
    r.status === "SCHEDULED" && r.scheduledAt
      ? `Card charge ${shortDate(r.scheduledAt)}`
      : r.label;
  return (
    <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap tabular-nums" style={TONE[r.tone]}>
      {label}
    </span>
  );
}

function SourceChip({ r }: { r: AttendeeRow }) {
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}>
      {r.source === "MEMBER" ? "Member" : "Public"}
    </span>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "warn" | "brand" }) {
  const style: CSSProperties =
    tone === "warn"
      ? { background: "var(--color-warn-surface)", border: "1px solid var(--color-warn-border)" }
      : tone === "brand"
        ? { background: "var(--color-info-surface)", border: "1px solid var(--color-info-border)" }
        : { background: "var(--color-surface)", border: "1px solid var(--color-app-border)" };
  return (
    <div className="rounded-xl px-3 py-2.5" style={style}>
      <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted">{label}</div>
      <div className="text-[20px] font-bold tabular-nums text-text-primary leading-tight mt-0.5">{value}</div>
      <div className="text-[11.5px] text-text-muted">{sub}</div>
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export default function AttendeesModal({
  eventId,
  onClose,
  onOpenRegistrations,
  onOpenBookings,
}: {
  eventId: string;
  onClose: () => void;
  /** Where the write actions live. Optional so the screen also works alone. */
  onOpenRegistrations?: () => void;
  onOpenBookings?: () => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AttendeeFilter>("all");
  const [showRemoved, setShowRemoved] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/events/${eventId}/attendees`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Failed (${r.status})`);
        return r.json();
      })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [eventId]);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.ledger.rows.filter((r) => (showRemoved || !r.removed) && matchesFilter(r, filter));
  }, [data, filter, showRemoved]);

  const ledger = data?.ledger;
  const ev = data?.event;
  const categoryLabel = ev?.categoryLabel ?? null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-[1120px] bg-surface sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Attendees"
      >
        {/* Header */}
        <div className="px-4 sm:px-5 py-3 border-b border-app-border flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[16px] sm:text-[20px] font-semibold text-text-primary leading-tight">
              Attendees{ledger ? ` · ${ledger.visible}` : ""}
            </h2>
            {ev && (
              <p className="text-[12.5px] text-text-muted truncate">
                {ev.name} · {dateRange(ev.startsAt, ev.endsAt)}
                {ledger?.capacity.spotsLeft != null ? ` · ${ledger.capacity.spotsLeft} spots left` : ""}
                {ev.publicSlug ? ` · /e/${ev.publicSlug}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onOpenRegistrations && (
              <button type="button" onClick={onOpenRegistrations} className="hidden sm:inline text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                Record / approve
              </button>
            )}
            {onOpenBookings && (
              <button type="button" onClick={onOpenBookings} className="hidden sm:inline text-xs font-semibold text-white bg-brand hover:bg-brand-hover px-3 py-1.5 rounded-lg">
                + Add attendee
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-app-bg flex items-center justify-center text-text-muted">
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {error ? (
            <div className="p-8 text-center text-sm text-red-600">{error}</div>
          ) : !data || !ledger ? (
            <div className="p-4"><SkeletonList rows={5} /></div>
          ) : (
            <>
              {/* Explainer + tiles */}
              <div className="px-4 sm:px-5 py-3 sm:py-4" style={{ background: "var(--color-table-chrome)" }}>
                <p className="hidden sm:block text-[12.5px] text-text-muted mb-3">
                  Everyone signed up, whether they came through the public link or were booked as a member — and what each one owes. Read-only here: record payments and decisions from <span className="font-medium text-text-primary">Record / approve</span>.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                  <Tile label="Collected" value={money(ledger.tiles.collected)} sub="paid so far" />
                  <Tile label="Outstanding" value={money(ledger.tiles.outstanding)} sub={`${ledger.tiles.outstandingCount} owe`} tone={ledger.tiles.outstanding > 0 ? "warn" : undefined} />
                  <Tile label="Scheduled" value={money(ledger.tiles.scheduled)} sub={`${ledger.tiles.scheduledCount} card${ledger.tiles.scheduledCount === 1 ? "" : "s"} on file`} />
                  <Tile label="Waiting on you" value={String(ledger.tiles.waitingOnYou)} sub="coach decisions" tone={ledger.tiles.waitingOnYou > 0 ? "brand" : undefined} />
                </div>
              </div>

              {/* Filter chips — they really filter, counts are live */}
              <div className="px-4 sm:px-5 py-2.5 flex gap-1 overflow-x-auto border-b border-app-border" style={{ scrollbarWidth: "none" }}>
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap transition tabular-nums ${
                      filter === f.key ? "bg-brand text-white font-semibold" : "bg-app-bg text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {f.label} · {ledger.filters[f.key]}
                  </button>
                ))}
              </div>

              {rows.length === 0 ? (
                <div className="p-10 text-center text-sm text-text-muted">
                  {filter === "all" ? "Nobody has signed up yet." : "Nobody matches this filter."}
                </div>
              ) : (
                <>
                  {/* Phone: one card per attendee */}
                  <ul className="sm:hidden divide-y" style={{ borderColor: "var(--color-hairline)" }}>
                    {rows.map((r) => (
                      <li key={r.id} className={`px-4 py-3 flex items-start gap-3 ${r.removed ? "opacity-60" : ""}`}>
                        <div className="w-9 h-9 rounded-full bg-app-bg flex items-center justify-center text-[12px] font-semibold text-text-muted flex-shrink-0">
                          {initials(r.name)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14.5px] font-semibold text-text-primary truncate">{r.name}</div>
                          <div className="text-[11.5px] text-text-muted flex items-center gap-1.5 flex-wrap">
                            <SourceChip r={r} />
                            <span>{[r.categoryValue, r.attending].filter(Boolean).join(" · ")}</span>
                          </div>
                          <div className="mt-1.5"><StatusPill r={r} /></div>
                        </div>
                        <div className="text-right flex-shrink-0 tabular-nums">
                          <div className="text-[15px] font-bold text-text-primary">{r.owes > 0 ? money(r.owes) : r.paid > 0 ? money(r.paid) : "—"}</div>
                          <div className="text-[10.5px] text-text-muted">{r.owes > 0 ? "owes" : r.paid > 0 ? "paid" : r.status === "COVERED" ? "covered" : ""}</div>
                        </div>
                      </li>
                    ))}
                  </ul>

                  {/* Desktop: table. Header and rows share one track list. */}
                  <div className="hidden sm:block px-5 py-3">
                    <div className="grid gap-3 px-3 pb-2 text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted" style={{ gridTemplateColumns: "1.5fr 1.6fr .7fr 1.2fr .8fr 1.5fr" }}>
                      <div>Name</div><div>Contact</div><div>{categoryLabel ?? "Category"}</div><div>Attending</div><div className="text-right">Owes</div><div>Status</div>
                    </div>
                    <div className="rounded-xl border border-app-border overflow-hidden divide-y" style={{ borderColor: "var(--color-app-border)" }}>
                      {rows.map((r) => (
                        <div
                          key={r.id}
                          className={`grid gap-3 items-center px-3 py-2.5 text-[13.5px] ${r.removed ? "opacity-60" : ""}`}
                          style={{ gridTemplateColumns: "1.5fr 1.6fr .7fr 1.2fr .8fr 1.5fr", borderColor: "var(--color-hairline)" }}
                        >
                          <div className="min-w-0">
                            <div className="font-semibold text-text-primary truncate">{r.name}</div>
                            <div className="flex items-center gap-1.5 mt-0.5"><SourceChip r={r} />{r.bookingStatus === "WAITLISTED" && <span className="text-[11px] text-text-muted">waitlist</span>}</div>
                          </div>
                          <div className="min-w-0 text-[12.5px]">
                            <div className="text-text-primary truncate">{r.email ?? <span className="text-text-muted">No address on file</span>}</div>
                            <div className="text-text-muted truncate">{[r.emailNote, r.phone].filter(Boolean).join(" · ")}</div>
                          </div>
                          <div className="text-text-primary">{r.categoryValue ?? <span className="text-text-muted">—</span>}</div>
                          <div className="text-[12.5px] text-text-muted">{r.attending}</div>
                          <div className="text-right font-semibold tabular-nums text-text-primary">{r.owes > 0 ? money(r.owes) : <span className="text-text-muted">—</span>}</div>
                          <div><StatusPill r={r} /></div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {ledger && (
          <div className="px-4 sm:px-5 py-2.5 border-t border-app-border flex items-center justify-between gap-3 text-[12px] text-text-muted flex-wrap">
            <div>
              Showing {rows.length === ledger.visible && filter === "all" ? "all " : ""}{rows.length}
              {ledger.removed > 0 && (
                <>
                  {" · "}
                  <button type="button" className="text-brand hover:underline" onClick={() => setShowRemoved((v) => !v)}>
                    {showRemoved ? "Hide" : "Show"} {ledger.removed} removed attendee{ledger.removed === 1 ? "" : "s"}
                  </button>
                </>
              )}
              {(onOpenRegistrations || onOpenBookings) && (
                <span className="sm:hidden">
                  {" · "}
                  {onOpenRegistrations && <button type="button" className="text-brand hover:underline" onClick={onOpenRegistrations}>Record / approve</button>}
                  {onOpenRegistrations && onOpenBookings && " · "}
                  {onOpenBookings && <button type="button" className="text-brand hover:underline" onClick={onOpenBookings}>Add attendee</button>}
                </span>
              )}
            </div>
            <div className="tabular-nums">
              Outstanding <b className="font-semibold text-text-primary">{money(ledger.tiles.outstanding)}</b> of {money(ledger.tiles.outstanding + ledger.tiles.collected + ledger.tiles.scheduled)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
