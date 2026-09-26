"use client";

// B6 — the member profile's Overview cards (§1c) and the phone fact grid (§1j).
//
// Presentational only: every figure arrives from GET /api/members/[id] or is
// derived by lib/memberProfileFacts (pure, tested). Nothing here fetches except
// the Staff notes save, which goes through the same PATCH the drawer uses.

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck, CreditCard, FileText, Send, Ticket, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  migrationStepEvidence,
  parseAttributedNotes,
  relativeDay,
  type ActivityItem,
  type ActivityKind,
  type ActivityTone,
  type AttendanceFigures,
  type Fact,
  type MigrationEventLike,
} from "@/lib/memberProfileFacts";

// ── Shared bits ──────────────────────────────────────────────────────────────

const TONE: Record<ActivityTone, { bg: string; fg: string }> = {
  ok: { bg: "var(--color-success-surface)", fg: "var(--color-success-text)" },
  danger: { bg: "var(--color-danger-surface)", fg: "var(--color-danger-text)" },
  warn: { bg: "var(--color-warn-surface)", fg: "var(--color-warn-text)" },
  muted: { bg: "var(--color-chip-surface)", fg: "var(--color-text-muted)" },
  brand: { bg: "rgba(109,93,246,.10)", fg: "var(--color-prospect-text)" },
};

function money(v: number | null | undefined): string {
  return Number(v ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function fmtDate(d: string | null | undefined): string {
  return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

export function OverviewCard({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-app-border bg-surface p-5 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function CardLink({ onClick, href, children }: { onClick?: () => void; href?: string; children: React.ReactNode }) {
  const cls =
    "inline-flex min-h-[44px] items-center gap-0.5 text-[12.5px] font-medium text-brand hover:underline md:min-h-0";
  return href ? (
    <Link href={href} className={cls}>
      {children} <ChevronRight className="h-3.5 w-3.5" />
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {children} <ChevronRight className="h-3.5 w-3.5" />
    </button>
  );
}

// ── §1j Phone 2×2 fact grid ──────────────────────────────────────────────────

export function PhoneFactGrid({ facts }: { facts: Fact[] }) {
  return (
    <dl className="grid grid-cols-2 gap-2 md:hidden">
      {facts.map((f) => (
        <div key={f.label} className="min-w-0 rounded-xl border border-app-border bg-surface px-3 py-2.5">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{f.label}</dt>
          <dd
            className="mt-0.5 truncate text-[15px] font-semibold"
            style={{ color: f.tone === "muted" ? "var(--color-text-primary)" : TONE[f.tone].fg }}
          >
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── §1c Migration progress card ──────────────────────────────────────────────

type Meter = {
  step: number;
  total: number;
  applicable: boolean;
  waitingOn: "NOBODY" | "STAFF" | "MEMBER" | "BLOCKED";
  steps: { index: number; label: string; done: boolean; current: boolean }[];
};

/** Current segment says whose move it is — the same colours as MigrationMeterBar. */
const CURRENT_BAR: Record<Meter["waitingOn"], string> = {
  MEMBER: "var(--color-orange-accent)",
  BLOCKED: "#DC2626",
  STAFF: "var(--color-warn-text)",
  NOBODY: "var(--color-app-border)",
};
const WAITING_WORDS: Record<Meter["waitingOn"], string> = {
  NOBODY: "",
  STAFF: "waiting on you",
  MEMBER: "waiting on member",
  BLOCKED: "blocked",
};

export function MigrationProgressCard({
  meter,
  events,
  onOpenActivity,
}: {
  meter: Meter;
  events: MigrationEventLike[];
  onOpenActivity: () => void;
}) {
  if (!meter.applicable) return null;
  const allDone = meter.step >= meter.total;
  return (
    <OverviewCard
      title="Migration progress"
      action={
        <span className="text-[12px] tabular-nums text-text-muted">
          {allDone ? "Complete" : `Step ${meter.step} of ${meter.total}`}
          {!allDone && WAITING_WORDS[meter.waitingOn] ? ` · ${WAITING_WORDS[meter.waitingOn]}` : ""}
        </span>
      }
    >
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-7 sm:gap-1.5">
        {meter.steps.map((s) => {
          const ev = s.done ? migrationStepEvidence(events, s.index) : null;
          const bar = allDone
            ? "var(--color-lime-accent)"
            : s.current
              ? CURRENT_BAR[meter.waitingOn]
              : s.done
                ? "var(--color-charcoal)"
                : "var(--color-app-border)";
          return (
            <li key={s.index} className="flex min-w-0 items-start gap-2.5 sm:block">
              <span aria-hidden className="mt-1.5 block h-1 w-8 shrink-0 rounded-full sm:mt-0 sm:w-full" style={{ background: bar }} />
              <div className="min-w-0 sm:mt-1.5">
                <div
                  className={`text-[12px] leading-tight ${s.done || s.current ? "font-medium text-text-primary" : "text-text-muted"}`}
                >
                  {s.label}
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-text-muted">
                  {ev ? (
                    <>
                      {new Date(ev.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      {ev.actor ? <span className="block truncate sm:block">{ev.actor}</span> : null}
                    </>
                  ) : s.current ? (
                    "Next"
                  ) : s.done ? (
                    "Done"
                  ) : (
                    "—"
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex justify-end">
        <CardLink onClick={onOpenActivity}>Full migration activity</CardLink>
      </div>
    </OverviewCard>
  );
}

// ── §1c Recent activity ──────────────────────────────────────────────────────

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  attendance: CalendarCheck,
  payment: CreditCard,
  subscription: Ticket,
  invitation: Send,
  document: FileText,
};

export function RecentActivityCard({ items }: { items: ActivityItem[] }) {
  return (
    <OverviewCard title="Recent activity">
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing yet. Check-ins, payments, membership changes, invitations and signed documents show up here.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((it) => {
            const Icon = KIND_ICON[it.kind];
            const t = TONE[it.tone];
            return (
              <li key={it.id} className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{ background: t.bg, color: t.fg }}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary" title={it.text}>
                  {it.text}
                </span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-text-muted" title={new Date(it.at).toLocaleString()}>
                  {relativeDay(it.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </OverviewCard>
  );
}

// ── §1c Money ────────────────────────────────────────────────────────────────

export function MoneySummaryCard({
  balanceOwed,
  nextCharge,
  lastPayment,
  lifetimePaid,
  onSeeAll,
}: {
  balanceOwed: number | null;
  nextCharge: { amount: number; date: string | null; label: string | null } | null;
  lastPayment: { amount: number; at: string } | null;
  lifetimePaid: number | null;
  onSeeAll: () => void;
}) {
  const owed = Number(balanceOwed ?? 0);
  return (
    <OverviewCard title="Money" action={<CardLink onClick={onSeeAll}>See all payments</CardLink>}>
      <div
        className="rounded-lg px-3 py-2.5"
        style={owed > 0 ? { background: TONE.danger.bg } : { background: "var(--color-chip-surface)" }}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Balance owed</div>
        <div
          className="text-[20px] font-semibold tabular-nums"
          style={{ color: owed > 0 ? TONE.danger.fg : "var(--color-text-primary)" }}
        >
          {money(owed)}
        </div>
      </div>
      <dl className="mt-3 space-y-2 text-[13px]">
        <div className="flex justify-between gap-3">
          <dt className="text-text-muted">Next charge</dt>
          <dd className="text-right tabular-nums text-text-primary">
            {nextCharge ? (
              <>
                {money(nextCharge.amount)}
                <span className="text-text-muted"> · {nextCharge.date ? fmtDate(nextCharge.date) : "date not set"}</span>
              </>
            ) : (
              <span className="text-text-muted">None scheduled</span>
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-muted">Last payment</dt>
          <dd className="text-right tabular-nums text-text-primary">
            {lastPayment ? (
              <>
                {money(lastPayment.amount)}
                <span className="text-text-muted"> · {fmtDate(lastPayment.at)}</span>
              </>
            ) : (
              <span className="text-text-muted">None yet</span>
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-muted">Lifetime paid</dt>
          <dd className="text-right tabular-nums text-text-primary">{lifetimePaid == null ? "—" : money(lifetimePaid)}</dd>
        </div>
      </dl>
    </OverviewCard>
  );
}

// ── §1c Attendance (3 figures) ───────────────────────────────────────────────

export function AttendanceSummaryCard({
  figures,
  joinedAt,
  onSeeAll,
}: {
  figures: AttendanceFigures;
  joinedAt: string | null;
  onSeeAll?: () => void;
}) {
  const cells = [
    { label: "This month", value: figures.thisMonth },
    { label: "Last 30 days", value: figures.last30 },
    { label: joinedAt ? "Since joined" : "All time", value: figures.allTime },
  ];
  return (
    <OverviewCard title="Attendance" action={onSeeAll ? <CardLink onClick={onSeeAll}>All attendance</CardLink> : undefined}>
      <div className="grid grid-cols-3 gap-2">
        {cells.map((c) => (
          <div key={c.label} className="min-w-0 rounded-lg px-2 py-2 text-center" style={{ background: "var(--color-chip-surface)" }}>
            <div className="text-[20px] font-semibold tabular-nums text-text-primary">{c.value}</div>
            <div className="truncate text-[11px] text-text-muted">{c.label}</div>
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-[12px] text-text-muted">
        {figures.lastAttendedAt ? `Last attended ${fmtDate(figures.lastAttendedAt)}` : "Hasn't attended a class yet."}
      </p>
    </OverviewCard>
  );
}

// ── §1c Staff notes (staff-only, attributed) ─────────────────────────────────

export function StaffNotesCard({
  memberId,
  notes,
  canEdit,
  onSaved,
  onEditAll,
  className = "",
}: {
  memberId: string;
  notes: string | null;
  canEdit: boolean;
  onSaved: () => void;
  onEditAll?: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const entries = parseAttributedNotes(notes);

  // A reload after saving clears the box; a failed save keeps it.
  useEffect(() => {
    setDraft("");
  }, [notes]);

  const save = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      // `appendNote` — the server stamps the entry with the signed-in staffer's
      // name and today's date, so attribution can't be typed or faked.
      const res = await fetch(`/api/members/${memberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appendNote: draft }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not save the note");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <OverviewCard
      title="Staff notes"
      className={className}
      action={
        canEdit && onEditAll && entries.length > 0 ? (
          <button
            type="button"
            onClick={onEditAll}
            className="inline-flex min-h-[44px] items-center text-[12.5px] text-text-muted hover:text-text-primary md:min-h-0"
          >
            Edit all
          </button>
        ) : undefined
      }
    >
      <p className="mb-2 text-[11.5px] text-text-muted">Visible to club staff only — members and guardians never see these.</p>
      {entries.length === 0 ? (
        <p className="text-sm text-text-muted">No notes yet.</p>
      ) : (
        <ul className="flex flex-col divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          {entries.map((n, i) => (
            <li key={i} className="py-2 first:pt-0">
              {/* Staff-authored plain text — rendered as text, never as HTML. */}
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-text-primary">{n.text}</p>
              <p className="mt-0.5 text-[11.5px] text-text-muted">
                {n.by ? `${n.by} · ${n.on}` : "Earlier note · not attributed"}
              </p>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Add a note for the next person at the desk…"
            className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
          />
          {err && (
            <p className="mt-1 text-[12px]" style={{ color: "var(--color-danger-text)" }}>
              {err}
            </p>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!draft.trim() || saving}
            className="mt-2 inline-flex min-h-[44px] items-center rounded-lg bg-brand px-3 text-sm text-white transition-colors hover:bg-brand-hover disabled:opacity-50 md:min-h-[38px]"
          >
            {saving ? "Saving…" : "Add note"}
          </button>
        </div>
      )}
    </OverviewCard>
  );
}
