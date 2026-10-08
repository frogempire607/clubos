// Activity types — ONE place that decides what kind of thing a schedule item
// is and how it is coloured (Branch 3). The staff Schedule, the profile's
// Schedule tab and the legend all read this, so "Tadpoles" is the same colour
// everywhere and a new screen cannot invent its own.
//
// Colour is never the only signal: every chip also prints the type's short
// label, and states (needs coverage, late call-out, substitute, cancelled,
// conflict) are separate text badges with an icon (see STATE_BADGES).
//
// A class's type is worked out from its NAME (clubs name their groups, the
// product does not know them) — the first rule that matches wins, so "Girls
// MS/HS" is Girls. Events use their event type. Pure: no React, no Prisma.

export const ACTIVITY_TYPES = [
  "TEENS", "JUNIORS", "LITTLE", "GIRLS", "ADULT", "PRIVATE", "COMPETITION", "CAMP_CLINIC", "ADMIN", "CLASS",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type ActivityMeta = {
  /** Legend text. */
  label: string;
  /** The 2–6 character tag printed on a chip. */
  short: string;
  /** The stripe / dot colour — readable on both the light and the dark surface. */
  color: string;
};

export const ACTIVITY_META: Record<ActivityType, ActivityMeta> = {
  TEENS: { label: "MS / HS", short: "MS/HS", color: "#2563EB" },
  JUNIORS: { label: "Juniors", short: "Jr", color: "#16A34A" },
  LITTLE: { label: "Youngest group", short: "Little", color: "#D97706" },
  GIRLS: { label: "Girls", short: "Girls", color: "#DB2777" },
  ADULT: { label: "Adult", short: "Adult", color: "#0D9488" },
  PRIVATE: { label: "Private lesson", short: "Private", color: "#9333EA" },
  COMPETITION: { label: "Competition / travel", short: "Comp", color: "#DC2626" },
  CAMP_CLINIC: { label: "Camp / clinic", short: "Camp", color: "#EA580C" },
  ADMIN: { label: "Admin / staff", short: "Staff", color: "#64748B" },
  CLASS: { label: "Other class", short: "Class", color: "#6D5DF6" },
};

// Order matters: the first match wins.
const NAME_RULES: [RegExp, ActivityType][] = [
  [/\b(girl|girls|women|womens|ladies)\b/i, "GIRLS"],
  [/\b(adult|adults|masters|open mat)\b/i, "ADULT"],
  [/\b(tadpole|tadpoles|tot|tots|little|littles|mini|minis|pee ?wee|pre-?k|kinder)\b/i, "LITTLE"],
  [/\b(jr|jrs|junior|juniors|youth|kids|elementary|beginner|beginners)\b/i, "JUNIORS"],
  [/(\bms\b|\bhs\b|ms\s*\/\s*hs|middle school|high school|\bteen|varsity|preseason|advanced)/i, "TEENS"],
  [/\b(staff|admin|meeting|training day)\b/i, "ADMIN"],
];

/** A class's type, from its name. */
export function classActivityType(name: string | null | undefined): ActivityType {
  const n = (name ?? "").replace(/'/g, "");
  for (const [re, type] of NAME_RULES) if (re.test(n)) return type;
  return "CLASS";
}

/** An event's type, from its EventType (and its name for staff/admin things). */
export function eventActivityType(eventType: string | null | undefined, name?: string | null): ActivityType {
  const t = (eventType ?? "").toUpperCase();
  if (t === "TOURNAMENT") return "COMPETITION";
  if (t === "CAMP" || t === "CLINIC") return "CAMP_CLINIC";
  if (t === "PRIVATE") return "PRIVATE";
  const n = name ?? "";
  if (/\b(tournament|meet|championship|travel|trip|invitational|open)\b/i.test(n)) return "COMPETITION";
  if (/\b(camp|clinic|seminar)\b/i.test(n)) return "CAMP_CLINIC";
  if (/\b(staff|admin|meeting)\b/i.test(n)) return "ADMIN";
  if (t === "CLASS") return classActivityType(n);
  return "ADMIN";
}

export const activityMeta = (t: string | null | undefined): ActivityMeta => ACTIVITY_META[(t as ActivityType) ?? "CLASS"] ?? ACTIVITY_META.CLASS;

/** The types present in a set of items, in the fixed legend order. */
export function legendFor(types: Iterable<string>): { type: ActivityType; label: string; color: string }[] {
  const have = new Set(types);
  return ACTIVITY_TYPES.filter((t) => have.has(t)).map((t) => ({ type: t, label: ACTIVITY_META[t].label, color: ACTIVITY_META[t].color }));
}

// ── States (text + icon, never colour alone) ────────────────────────────────

export const SCHEDULE_STATES = ["NEEDS_COVERAGE", "LATE_CALLOUT", "SUBSTITUTE", "CANCELLED", "CONFLICT", "NO_SHOW", "COVERED"] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

export const STATE_BADGES: Record<ScheduleState, { label: string; icon: "alert" | "clock" | "swap" | "ban" | "overlap" | "x" | "check"; tone: "warn" | "danger" | "info" | "muted" }> = {
  NEEDS_COVERAGE: { label: "Needs coverage", icon: "alert", tone: "warn" },
  LATE_CALLOUT: { label: "Late call-out", icon: "clock", tone: "danger" },
  SUBSTITUTE: { label: "Substitute", icon: "swap", tone: "info" },
  CANCELLED: { label: "Canceled", icon: "ban", tone: "muted" },
  CONFLICT: { label: "Conflict", icon: "overlap", tone: "danger" },
  NO_SHOW: { label: "No-show", icon: "x", tone: "danger" },
  COVERED: { label: "Covered", icon: "check", tone: "info" },
};

/** The badges for one class chip on one coach's row. Order = importance. */
export function classStates(c: {
  canceled: boolean; myStatus?: string | null; myKind?: string | null; myLateCallout?: boolean; conflict?: boolean;
}): ScheduleState[] {
  if (c.canceled) return ["CANCELLED"];
  const out: ScheduleState[] = [];
  if (c.myStatus === "NEEDS_COVERAGE") out.push(c.myLateCallout ? "LATE_CALLOUT" : "NEEDS_COVERAGE");
  if (c.myStatus === "NO_SHOW") out.push("NO_SHOW");
  if (c.myStatus === "REPLACED") out.push("COVERED");
  if (c.myKind === "SUBSTITUTE" && c.myStatus === "SCHEDULED") out.push("SUBSTITUTE");
  if (c.conflict && c.myStatus !== "REPLACED" && c.myStatus !== "NEEDS_COVERAGE") out.push("CONFLICT");
  return out;
}

/**
 * The words on the FIRST badge when the chip knows more than the bare state:
 * "Canceled · unpaid", "Covered by Sal Jones", "Substitute · covering for Sal
 * Jones". `detail` is the chip's own state line (lib/classStaffUi.ts chipState).
 */
export function badgeText(states: readonly ScheduleState[], detail: string | null | undefined): Partial<Record<ScheduleState, string>> {
  const first = states[0];
  if (!first || !detail) return {};
  if (first === "SUBSTITUTE") {
    const m = /covering for .+$/.exec(detail);
    return m ? { SUBSTITUTE: `Substitute · ${m[0]}` } : {};
  }
  if (first === "CONFLICT") return {};
  return { [first]: detail };
}

// ── Overlaps on one coach's day ─────────────────────────────────────────────

export type Busy = { key: string; startMs: number; endMs: number; label: string };

/** key → the labels of the other things that overlap it. Touching ends do not overlap. */
export function findOverlaps(items: readonly Busy[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].startMs < sorted[i].endMs; j++) {
      const a = sorted[i], b = sorted[j];
      out.set(a.key, [...(out.get(a.key) ?? []), b.label]);
      out.set(b.key, [...(out.get(b.key) ?? []), a.label]);
    }
  }
  return out;
}
