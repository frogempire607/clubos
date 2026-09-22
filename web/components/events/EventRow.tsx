"use client";

// The three event-row treatments from the events design handoff (option 1e):
// money-first row · compact row · cover-photo card. All three read the SAME
// event + money summary — nothing here is typed twice. The money summary is
// `Event.money`, computed server-side from the Attendees ledger
// (lib/eventAttendees), so the "$x to collect" chip, the segmented capacity
// bar and "Attendees · n" can never disagree with the Attendees screen.

import type { CSSProperties, ReactNode } from "react";
import { Clock, MapPin, Users as UsersIcon, MoreVertical, Pencil } from "lucide-react";
import type { EventMoneySummary } from "@/lib/eventAttendees";

export type EventRowView = "money" | "compact" | "cover";

export const EVENT_ROW_VIEWS: { key: EventRowView; label: string }[] = [
  { key: "money", label: "Money" },
  { key: "compact", label: "Compact" },
  { key: "cover", label: "Cards" },
];

export type EventRowEvent = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  memberPrice: number | string | null;
  nonMemberPrice: number | string | null;
  dropInFee: number | string | null;
  imageUrl?: string | null;
  publicRegistration?: boolean;
  publicSlug?: string | null;
  visibility: string;
  purchaseAccess: string;
  location: { name: string } | null;
  sessions: { name?: string | null; startsAt: string; endsAt: string }[];
  staffAssignments?: { user: { id: string; firstName: string; lastName: string } }[];
  _count: { bookings: number; registrations?: number };
  money?: EventMoneySummary | null;
};

export type EventRowProps = {
  event: EventRowEvent;
  view: EventRowView;
  type: { name: string; bg: string; fg: string };
  publish: { label: string; bg: string; fg: string } | null;
  pricing: { label: string; bg: string; fg: string };
  acceptedMemberships: string[];
  onAttendees: () => void;
  onEdit: () => void;
  onMenu: () => void;
};

const fmtMoney = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtTime = (d: Date) => d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });

function dateRange(start: Date, end: Date): string {
  const sameDay = start.toDateString() === end.toDateString();
  const day = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric" });
  return sameDay ? day(start) : `${day(start)} – ${day(end)}`;
}

function lowestPrice(e: EventRowEvent): number | null {
  const ps = [e.memberPrice, e.nonMemberPrice, e.dropInFee]
    .filter((p) => p != null)
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n));
  return ps.length ? Math.min(...ps) : null;
}

function metaLine(e: EventRowEvent, start: Date, end: Date): string {
  const bits: string[] = [`${fmtTime(start)} – ${fmtTime(end)}`];
  const from = lowestPrice(e);
  if (e.sessions.length > 1) bits.push(`${e.sessions.length} sessions${from != null ? `, from ${fmtMoney(from)}` : ""}`);
  else if (from != null) bits.push(`from ${fmtMoney(from)}`);
  if (e.location) bits.push(e.location.name);
  if (e.staffAssignments?.length) bits.push(e.staffAssignments.map((a) => `${a.user.firstName} ${a.user.lastName}`).join(", "));
  return bits.join(" · ");
}

/** Segmented capacity bar: settled lime / owe orange / scheduled pending / review brand. */
function CapacityBar({ m, capacity }: { m: EventMoneySummary; capacity: number | null }) {
  const total = capacity && capacity > 0 ? capacity : Math.max(m.attendees + m.review, 1);
  const seg = (n: number) => `${Math.min(100, (n / total) * 100)}%`;
  return (
    <div className="h-[7px] rounded-full overflow-hidden flex" style={{ background: "var(--color-hairline)" }}>
      <div style={{ width: seg(m.settled), background: "var(--color-success)" }} title={`${m.settled} settled`} />
      <div style={{ width: seg(m.owe), background: "var(--color-warning)" }} title={`${m.owe} owe`} />
      <div style={{ width: seg(m.scheduled), background: "var(--color-pending-text)" }} title={`${m.scheduled} scheduled`} />
      <div style={{ width: seg(m.review), background: "var(--color-brand)" }} title={`${m.review} waiting on you`} />
    </div>
  );
}

function CountsLine({ m, capacity }: { m: EventMoneySummary; capacity: number | null }) {
  const cap = capacity ? ` / ${capacity}` : "";
  return (
    <div className="text-[11px] text-text-muted tabular-nums flex flex-wrap gap-x-3 gap-y-0.5">
      <span><b className="font-semibold text-text-primary">{m.settled}</b>{cap} settled</span>
      {m.owe > 0 && <span><b className="font-semibold" style={{ color: "var(--color-warn-text)" }}>{m.owe}</b> owe</span>}
      {m.scheduled > 0 && <span><b className="font-semibold" style={{ color: "var(--color-pending-text)" }}>{m.scheduled}</b> scheduled</span>}
      {m.review > 0 && <span><b className="font-semibold text-brand">{m.review}</b> waiting on you</span>}
      {m.waitlisted > 0 && <span>{m.waitlisted} waitlisted</span>}
    </div>
  );
}

function CollectChip({ m }: { m: EventMoneySummary | null | undefined }) {
  if (!m || m.outstanding <= 0) return null;
  return (
    <span
      className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full tabular-nums whitespace-nowrap"
      style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)", border: "1px solid var(--color-warn-border)" }}
    >
      {fmtMoney(m.outstanding)} to collect
    </span>
  );
}

function TypeChip({ type }: { type: EventRowProps["type"] }) {
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wide" style={{ background: type.bg, color: type.fg }}>
      {type.name}
    </span>
  );
}

function AttendeesButton({ n, onClick, className = "" }: { n: number; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-semibold text-brand hover:underline whitespace-nowrap tabular-nums ${className}`}
    >
      Attendees · {n}
    </button>
  );
}

function RightActions({ e, onAttendees, onEdit, onMenu }: Pick<EventRowProps, "onAttendees" | "onEdit" | "onMenu"> & { e: EventRowEvent }) {
  const n = e.money?.attendees ?? e._count.bookings;
  return (
    <div className="flex flex-col items-end gap-1 flex-shrink-0">
      <AttendeesButton n={n} onClick={onAttendees} />
      <div className="flex items-center gap-0.5">
        <button type="button" onClick={onEdit} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg inline-flex items-center gap-1">
          <Pencil size={12} strokeWidth={2} /> Edit
        </button>
        <button type="button" onClick={onMenu} aria-label="More actions" className="w-8 h-8 rounded-lg hover:bg-app-bg flex items-center justify-center text-text-muted">
          <MoreVertical size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export default function EventRow(props: EventRowProps) {
  const { event: e, view, type, publish, pricing, acceptedMemberships, onAttendees, onEdit, onMenu } = props;
  const start = new Date(e.startsAt);
  const end = new Date(e.endsAt);
  const m = e.money ?? null;
  const attendees = m?.attendees ?? e._count.bookings;
  const capText = e.capacity ? `${attendees}/${e.capacity}` : `${attendees}`;

  if (view === "compact") {
    return (
      <div className="bg-surface rounded-xl border border-app-border hover:shadow-md transition">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="w-16 text-center flex-shrink-0">
            <div className="text-[13px] font-semibold text-text-primary tabular-nums leading-tight">
              {start.toLocaleString("en-US", { month: "short" })} {start.getDate()}
            </div>
            <div className="text-[10.5px] text-text-muted tabular-nums">{fmtTime(start)}</div>
          </div>
          <div className="self-stretch w-[3px] rounded-full flex-shrink-0" style={{ background: type.bg }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text-primary truncate">{e.name}</div>
            <div className="text-[11.5px] text-text-muted truncate">
              {type.name}
              {e.sessions.length > 1 ? ` · ${e.sessions.length} sessions` : ""}
              {publish ? ` · ${publish.label}` : ""}
              {m ? ` · ${fmtMoney(m.collected)} collected` : ""}
              {m && m.review > 0 ? ` · ${m.review} waiting on you` : ""}
            </div>
          </div>
          <div className="text-right flex-shrink-0 tabular-nums">
            <div className="text-sm font-semibold text-text-primary">{capText}</div>
            {m && m.outstanding > 0 && (
              <div className="text-[11px] font-semibold" style={{ color: "var(--color-warn-text)" }}>{fmtMoney(m.outstanding)} to collect</div>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <AttendeesButton n={attendees} onClick={onAttendees} className="px-2 py-1 rounded hover:bg-app-bg" />
            <button type="button" onClick={onMenu} aria-label="More actions" className="w-8 h-8 rounded-lg hover:bg-app-bg flex items-center justify-center text-text-muted">
              <MoreVertical size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === "cover") {
    return (
      <div className="bg-surface rounded-xl border border-app-border overflow-hidden hover:shadow-md transition">
        <div
          className="h-[190px] w-full bg-app-bg"
          style={
            e.imageUrl
              ? { backgroundImage: `url(${e.imageUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { backgroundImage: "repeating-linear-gradient(135deg, var(--color-inset-surface), var(--color-inset-surface) 6px, var(--color-hairline) 6px, var(--color-hairline) 12px)" }
          }
          role="img"
          aria-label={e.imageUrl ? `${e.name} cover photo` : "No cover photo"}
        />
        <div className="p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-text-muted">
            {dateRange(start, end)} · {type.name}
          </div>
          <div className="flex items-start justify-between gap-3 mt-1">
            <div className="min-w-0">
              <h3 className="text-[19px] font-semibold text-text-primary leading-tight" style={{ textWrap: "balance" }}>{e.name}</h3>
              <div className="text-[12.5px] text-text-muted mt-1">
                {m ? `${fmtMoney(m.collected)} collected${m.outstanding > 0 ? ` · ${fmtMoney(m.outstanding)} outstanding` : ""}` : pricing.label}
              </div>
            </div>
            <div className="text-right flex-shrink-0 tabular-nums">
              <div className="text-sm font-semibold text-text-primary">{capText}</div>
              {m && m.outstanding > 0 && (
                <div className="text-[11px] font-semibold" style={{ color: "var(--color-warn-text)" }}>{fmtMoney(m.outstanding)}</div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {m && m.settled > 0 && <Pill tone="success">{m.settled} settled</Pill>}
            {m && m.owe > 0 && <Pill tone="warn">{m.owe} owe at the door</Pill>}
            {m && m.scheduled > 0 && <Pill tone="pending">{m.scheduled} card scheduled</Pill>}
            {m && m.review > 0 && <Pill tone="info">{m.review} waiting on you</Pill>}
            {e.publicRegistration && e.publicSlug && <Pill tone="chip">Public link on</Pill>}
            {publish && <Pill tone="chip">{publish.label}</Pill>}
            {acceptedMemberships.length > 0 && <Pill tone="chip">{acceptedMemberships.join(" · ")} accepted</Pill>}
          </div>
          <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: "1px solid var(--color-hairline)" }}>
            <AttendeesButton n={attendees} onClick={onAttendees} />
            <div className="flex items-center gap-0.5">
              <button type="button" onClick={onEdit} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
              <button type="button" onClick={onMenu} aria-label="More actions" className="w-8 h-8 rounded-lg hover:bg-app-bg flex items-center justify-center text-text-muted">
                <MoreVertical size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Default: money-first row.
  return (
    <div className="bg-surface rounded-xl border border-app-border hover:shadow-md transition" style={{ borderLeft: `4px solid ${type.bg}` }}>
      <div className="flex items-start gap-3 sm:gap-4 p-4">
        <div className="w-[58px] text-center bg-app-bg rounded-lg py-2 flex-shrink-0">
          <div className="text-[10px] uppercase font-semibold text-text-muted tracking-wider">{start.toLocaleString("en-US", { month: "short" })}</div>
          <div className="text-2xl font-bold text-text-primary leading-tight tabular-nums">{start.getDate()}</div>
          <div className="text-[10px] uppercase font-medium text-text-muted tracking-wider mt-0.5">{start.toLocaleString("en-US", { weekday: "short" })}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-1.5 mb-1">
            <h3 className="text-base font-semibold text-text-primary leading-snug line-clamp-2 mr-1">{e.name}</h3>
            <TypeChip type={type} />
            <CollectChip m={m} />
            {publish && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wide" style={{ background: publish.bg, color: publish.fg }}>{publish.label}</span>
            )}
          </div>
          <div className="text-[12px] text-text-muted flex items-center flex-wrap gap-x-3 gap-y-1 mb-2">
            <span className="inline-flex items-center gap-1"><Clock size={12} strokeWidth={2} /><span className="tabular-nums">{fmtTime(start)} – {fmtTime(end)}</span></span>
            {e.sessions.length > 1 && (
              <span>{e.sessions.length} sessions{lowestPrice(e) != null ? `, from ${fmtMoney(lowestPrice(e)!)}` : ""}</span>
            )}
            {e.sessions.length <= 1 && lowestPrice(e) != null && <span>from {fmtMoney(lowestPrice(e)!)}</span>}
            {e.location && <span className="inline-flex items-center gap-1 min-w-0"><MapPin size={12} strokeWidth={2} /><span className="truncate">{e.location.name}</span></span>}
            {e.staffAssignments && e.staffAssignments.length > 0 && (
              <span className="inline-flex items-center gap-1 min-w-0"><UsersIcon size={12} strokeWidth={2} /><span className="truncate">{e.staffAssignments.map((a) => `${a.user.firstName} ${a.user.lastName}`).join(", ")}</span></span>
            )}
            {acceptedMemberships.length > 0 && <span>{acceptedMemberships.join(" · ")} accepted</span>}
          </div>
          {m ? (
            <div className="space-y-1">
              <CapacityBar m={m} capacity={e.capacity} />
              <CountsLine m={m} capacity={e.capacity} />
            </div>
          ) : (
            <div className="text-[11px] text-text-muted">{pricing.label}</div>
          )}
        </div>
        <RightActions e={e} onAttendees={onAttendees} onEdit={onEdit} onMenu={onMenu} />
      </div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "success" | "warn" | "pending" | "info" | "chip"; children: ReactNode }) {
  const style: Record<typeof tone, CSSProperties> = {
    success: { background: "var(--color-success-surface)", color: "var(--color-success-text)" },
    warn: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" },
    pending: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
    info: { background: "var(--color-info-surface)", color: "var(--color-brand)" },
    chip: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  };
  return <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full tabular-nums" style={style[tone]}>{children}</span>;
}
