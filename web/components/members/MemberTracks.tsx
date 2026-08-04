// Phase 4.5 — the presentational kit for the three status tracks.
//
// ── Why these are components and not JSX inlined per page ────────────────────
// The members list, the member profile, the migration queue, the migration
// detail drawer and the mobile card all render the same three tracks. When each
// surface built its own version they drifted: the list showed a person as
// "Migrating", the profile showed "Prospect", and the migration queue showed a
// readiness chip that had been computed from a third rule. One component per
// track is the only way that stays fixed.
//
// Every component here is PURE PRESENTATION. They take the serialized shape
// from lib/memberDisplay.ts and render it. No fetching, no derivation — if a
// component here needed to decide something, that decision belongs in
// lib/memberTracks.ts where it can be unit-tested.
//
// ── Status ───────────────────────────────────────────────────────────────────
// NOT blocked on the migration. Everything here renders from fields that exist
// today; the Phase 4.5.1 columns only make the meter and the Blocked state more
// accurate when they arrive. Safe to consume as soon as a surface is ready.

"use client";

import { Check, Lock } from "lucide-react";
import {
  MIGRATION_STEP_COUNT,
  WAITING_ON,
  WAITING_ON_LABELS,
  type MigrationMeter,
  type NextAction,
  type RoleChip,
  type WaitingOn,
} from "@/lib/memberTracks";

// ─────────────────────────────────────────────────────────────────────────────
// Track 1 — Role chips
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Neutral by design. A person holds several of these at once, so they must read
 * as quiet metadata — the moment they compete with the membership pill the row
 * has two things shouting and the eye lands on neither.
 */
export function RoleChips({ roles, max }: { roles: RoleChip[]; max?: number }) {
  if (!roles.length) return null;
  const shown = max ? roles.slice(0, max) : roles;
  const hidden = roles.length - shown.length;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((r) => (
        <span
          key={r.role}
          className="inline-flex items-center rounded-[5px] px-1.5 py-[1px] text-[10.5px] font-semibold uppercase tracking-[0.04em]"
          style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}
        >
          {r.label}
        </span>
      ))}
      {hidden > 0 && (
        <span className="text-[10.5px] font-semibold" style={{ color: "var(--color-chip-text)" }}>
          +{hidden}
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Track 2 — Membership pill
// ─────────────────────────────────────────────────────────────────────────────

const PILL_STYLE: Record<string, { background: string; color: string }> = {
  ACTIVE: { background: "var(--color-lime-accent)", color: "var(--color-charcoal)" },
  PENDING: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
  PROSPECT: { background: "var(--color-prospect-surface)", color: "var(--color-prospect-text)" },
  PAUSED: { background: "#FFF1E6", color: "var(--color-warn-text)" },
  INACTIVE: { background: "var(--color-chip-surface)", color: "var(--color-text-muted)" },
};

/**
 * THE only saturated pill in a row. That exclusivity is the design: money is
 * the question an owner scans for, and if three things in the row are pills
 * none of them is an answer.
 */
export function MembershipPill({
  track,
  label,
  detail,
}: {
  track: string;
  label: string;
  detail?: string | null;
}) {
  const style = PILL_STYLE[track] ?? PILL_STYLE.INACTIVE;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span
        className="inline-flex w-fit items-center rounded-full px-2 py-[2px] text-[11.5px] font-medium"
        style={style}
      >
        {label}
      </span>
      {detail && <span className="text-[11px] text-text-muted">{detail}</span>}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Track 3 — Account setup: a dot, never a pill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rendered as a 6px dot plus a label. Deliberately NOT a pill: Track 2 owns the
 * pill shape, and giving login state the same shape as membership state is how
 * "Prospect · Un-invited" came to read as one compound status instead of two
 * unrelated facts.
 */
export function AccountSetupCell({
  track,
  label,
  dot,
  meter,
  showMeter = true,
}: {
  track: string;
  label: string;
  dot: string;
  meter?: MigrationMeter;
  showMeter?: boolean;
}) {
  const complete = track === "COMPLETE";
  const blocked = track === "BLOCKED";

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 text-[12.5px]">
        {complete ? (
          <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-success-icon)" }} strokeWidth={2.5} />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} aria-hidden />
        )}
        <span
          className={blocked ? "font-medium" : undefined}
          style={blocked ? { color: "var(--color-danger-text)" } : undefined}
        >
          {label}
        </span>
      </span>

      {showMeter && meter?.applicable && (
        <span className="inline-flex flex-col gap-0.5">
          <MigrationMeterBar meter={meter} />
          <span className="text-[11px] text-text-muted">
            Step {meter.step} of {meter.total} · {WAITING_ON_LABELS[meter.waitingOn]}
          </span>
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The 7-segment migration meter
// ─────────────────────────────────────────────────────────────────────────────

/** Colour of the CURRENT segment says whose move it is, not how far along. */
const CURRENT_SEGMENT: Record<WaitingOn, string> = {
  MEMBER: "var(--color-orange-accent)",
  BLOCKED: "#DC2626",
  STAFF: "var(--color-warn-text)",
  NOBODY: "var(--color-app-border)",
};

export function MigrationMeterBar({ meter, className }: { meter: MigrationMeter; className?: string }) {
  if (!meter.applicable) return null;
  const allDone = meter.step >= MIGRATION_STEP_COUNT;

  return (
    <span
      className={`inline-flex items-center gap-[2px] ${className ?? ""}`}
      role="img"
      aria-label={`Step ${meter.step} of ${meter.total}, ${WAITING_ON_LABELS[meter.waitingOn]}`}
    >
      {meter.steps.map((s) => {
        // A finished migration renders every segment lime — the row reads as
        // resolved at a glance, without needing the caption.
        const background = allDone
          ? "var(--color-lime-accent)"
          : s.current
            ? CURRENT_SEGMENT[meter.waitingOn]
            : s.done
              ? "var(--color-charcoal)"
              : "var(--color-app-border)";
        return (
          <span
            key={s.index}
            title={`${s.index}. ${s.label}`}
            className="h-[3px] w-[11px] rounded-[2px]"
            style={{ background }}
          />
        );
      })}
    </span>
  );
}

/** The vertical variant used by the migration detail drawer (4.5.8). */
export function MigrationTimeline({ meter }: { meter: MigrationMeter }) {
  if (!meter.applicable) return null;
  return (
    <ol className="flex flex-col">
      {meter.steps.map((s, i) => (
        <li key={s.index} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              className="mt-1 h-[11px] w-[11px] shrink-0 rounded-full"
              style={
                s.done
                  ? { background: "var(--color-charcoal)" }
                  : s.current
                    ? {
                        background: "#fff",
                        border: "2px solid var(--color-orange-accent)",
                        boxShadow: "0 0 0 3px rgba(255,106,0,.18)",
                      }
                    : { background: "#fff", border: "2px solid var(--color-app-border)" }
              }
            />
            {i < meter.steps.length - 1 && (
              <span
                className="w-[2px] flex-1"
                style={{ background: s.done ? "var(--color-charcoal)" : "var(--color-app-border)", minHeight: 22 }}
              />
            )}
          </div>
          <div className="pb-4">
            <div className={`text-[13px] ${s.done || s.current ? "text-text-primary" : "text-text-muted"}`}>
              {s.index}. {s.label}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Whose-turn pill (migration queue, 4.5.7)
// ─────────────────────────────────────────────────────────────────────────────

const WAITING_STYLE: Record<WaitingOn, { background: string; color: string; label: string }> = {
  STAFF: { background: "rgba(109,93,246,.10)", color: "var(--color-prospect-text)", label: "You" },
  MEMBER: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)", label: "Member" },
  BLOCKED: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)", label: "Blocked" },
  NOBODY: { background: "var(--color-chip-surface)", color: "var(--color-text-muted)", label: "Nobody" },
};

export function WaitingOnPill({ waitingOn }: { waitingOn: WaitingOn }) {
  const s = WAITING_STYLE[waitingOn];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-[2px] text-[11.5px] font-medium"
      style={{ background: s.background, color: s.color }}
    >
      {s.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The single next action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE button. The row gets one recommended action, not a menu of six — the
 * menu is what the `⋯` popover is for.
 *
 * A permission the actor lacks renders the button VISIBLY LOCKED rather than
 * hiding it. Hiding is what made the dashboard feel arbitrary: a coach saw a
 * different set of controls with no explanation and assumed the feature was
 * missing. A greyed button naming the required role tells them the truth.
 */
export function NextActionButton({
  action,
  allowed = true,
  requiredRoleLabel,
  onClick,
  className,
}: {
  action: NextAction;
  allowed?: boolean;
  requiredRoleLabel?: string;
  onClick?: () => void;
  className?: string;
}) {
  if (action.kind === "NONE") return null;

  const locked = !allowed && action.permission !== null;

  const tone =
    action.tone === "charcoal"
      ? "bg-charcoal text-white hover:bg-charcoal-hover border-transparent"
      : action.tone === "brand"
        ? "bg-surface text-brand border-brand hover:bg-brand hover:text-white"
        : "bg-surface text-text-muted border-app-border hover:bg-app-bg";

  return (
    <button
      type="button"
      disabled={locked}
      onClick={locked ? undefined : onClick}
      title={locked ? `Requires ${requiredRoleLabel ?? action.permission}` : (action.detail ?? undefined)}
      // 44px min height keeps the mobile card's target legal without a second
      // component; desktop rows override with the 12px text size.
      className={[
        "inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors",
        locked ? "cursor-not-allowed border-app-border bg-surface text-[#9CA3AF]" : tone,
        className ?? "",
      ].join(" ")}
    >
      {locked && <Lock className="h-3 w-3 shrink-0" strokeWidth={2} />}
      {action.label}
      {locked && requiredRoleLabel && (
        <span
          className="ml-0.5 rounded-[4px] px-1 text-[10px] font-semibold uppercase"
          style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}
        >
          {requiredRoleLabel}
        </span>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Next-action banner (profile, 4.5.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders ONLY when something is outstanding. A banner that is always present
 * is chrome, and chrome gets ignored — which defeats the point of putting the
 * blocker at the top of the profile.
 */
export function NextActionBanner({
  action,
  memberName,
  children,
}: {
  action: NextAction;
  memberName: string;
  children?: React.ReactNode;
}) {
  if (action.waitingOn === WAITING_ON.NOBODY || action.kind === "LEAVE_ALONE") return null;

  const blocked = action.waitingOn === WAITING_ON.BLOCKED;
  const surface = blocked ? "var(--color-danger-surface)" : "var(--color-warn-surface)";
  const border = blocked ? "rgba(185,28,28,.22)" : "rgba(180,83,9,.22)";
  const text = blocked ? "var(--color-danger-text)" : "var(--color-warn-text)";

  return (
    <div
      className="flex flex-col gap-3 rounded-[10px] border p-3.5 md:flex-row md:items-start md:justify-between"
      style={{ background: surface, borderColor: border }}
    >
      <div className="flex-1">
        <div className="text-[13.5px] font-semibold" style={{ color: text }}>
          {action.label} — {WAITING_ON_LABELS[action.waitingOn]}
        </div>
        {action.detail && <div className="mt-0.5 text-[12.5px] text-text-muted">{action.detail}</div>}
        {/* The reassurance half. An owner reading "blocked" about a paying
            member needs to know in the same breath that nothing has broken for
            the athlete — otherwise the banner reads as an outage. */}
        <div className="mt-1 text-[12.5px] text-text-muted">
          {memberName} keeps training and keeps billing on their existing date.
        </div>
      </div>
      {children && <div className="flex shrink-0 flex-wrap gap-2">{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Avatar
// ─────────────────────────────────────────────────────────────────────────────

export function MemberAvatar({
  initials,
  imageUrl,
  size = 34,
}: {
  initials: string;
  imageUrl?: string | null;
  size?: number;
}) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-text-muted"
      style={{ width: size, height: size, background: "var(--color-app-border)", fontSize: Math.round(size * 0.35) }}
    >
      {initials}
    </span>
  );
}
