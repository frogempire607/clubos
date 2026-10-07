// Class coach scheduling — the WORDS the screens show (stage 3). Pure: no
// React, no fetch, no database. Tested in scripts/class-staff-ui-tests.ts.
//
//   scopeOptions(date)            the three "which class days?" choices, with the real day in the label
//   seedForScope(...)             who is on it now for that choice (what the editor starts from)
//   chipState(...)                what a class chip on someone's schedule says
//   rowState(row)                 what a coach row in the class-day sheet says
//   classDayState(day)            what a class day says on the Calendar (whole class, not one person)
//   audienceOptions(counts)       "Booked members · 9 families" …
//   cancelConfirmLabel(...)       "Cancel class · email 9 families"
//   cancelAuditParts(cancel)      "Canceled by Julian" · when · reason · who was told · pay
//   coverageNotifySentence(cfg)   "The owners and the schedule managers will be told it needs coverage."
//   switchOnLine(cls)             "Jr Frogs — Sal Jones, Josh Antoine every class day · 104 upcoming class days"
//   currentStaffSummary(list)     "Sal Jones — Lead Coach · every class day; Adrian — Assistant Coach · Tuesdays"
//   openCoverage(staff)           the "Needs coverage" strip, late first
//   nextClassDay(days, from)      the next date a class runs
import {
  CLASS_STAFF_ROLES,
  LATE_CALLOUT_MS,
  addDaysYmd,
  dowOfYmd,
  fmtMonthDay,
  roleLabel,
  rulesForDay,
  type CancelAudience,
  type ChangeScope,
  type StaffKind,
  type StaffStatus,
} from "@/lib/classStaff";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "1 family" / "9 families" — one per email address that would be written to. */
export const families = (n: number) => plural(n, "family", "families");

/** "Oct 8, 2026" */
export function fmtYmdFull(ymd: string): string {
  return new Date(`${ymd.slice(0, 10)}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
/** "Tuesday, Oct 20" */
export function fmtWeekdayMonthDay(ymd: string): string {
  return `${WEEKDAY[dowOfYmd(ymd)]}, ${fmtMonthDay(ymd)}`;
}

// ── Switch-on ───────────────────────────────────────────────────────────────

export function switchStatusText(assignmentsStartOn: string | null | undefined): string {
  return assignmentsStartOn ? `New coach scheduling: On since ${fmtYmdFull(assignmentsStartOn)}` : "New coach scheduling: Off";
}
export type SwitchOnClassLine = { name: string; state: "new" | "already"; coaches: string[]; upcomingDays: number; manualDays?: number; droppedCount?: number };
export function switchOnLine(c: SwitchOnClassLine): string {
  if (c.state === "already") return `${c.name} — already on the new scheduling, left as it is`;
  const who = c.coaches.length ? `${c.coaches.join(", ")} every class day` : "no coaches yet";
  const extra: string[] = [];
  if (c.manualDays) extra.push(`${plural(c.manualDays, "day keeps", "days keep")} a one-day coach change`);
  if (c.droppedCount) extra.push(`${plural(c.droppedCount, "former staff member is", "former staff members are")} left off`);
  return [`${c.name} — ${who}`, plural(c.upcomingDays, "upcoming class day", "upcoming class days"), ...extra].join(" · ");
}
export function switchOnSentence(dateYmd: string): string {
  return `Past class days are not changed. From ${fmtYmdFull(dateYmd)} on, coach changes are tracked per class day.`;
}

// ── Roles ───────────────────────────────────────────────────────────────────

export const OTHER_ROLE = "__other__";
/** The role dropdown: "" = no role (shown as Coach), the four standard names, or Other… */
export const ROLE_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "Coach (no specific role)" },
  ...CLASS_STAFF_ROLES.map((r) => ({ value: r.label, label: r.label })),
  { value: OTHER_ROLE, label: "Other…" },
];
/** A stored role name → which dropdown choice it is. */
export function roleChoiceOf(roleName: string | null | undefined): string {
  const t = (roleName ?? "").trim();
  if (!t) return "";
  return CLASS_STAFF_ROLES.some((r) => r.label === t) ? t : OTHER_ROLE;
}

// ── The three scopes ────────────────────────────────────────────────────────

export type ScopeOption = { value: ChangeScope; label: string; hint: string };
export function scopeOptions(dateYmd: string): ScopeOption[] {
  const dow = dowOfYmd(dateYmd);
  const md = fmtMonthDay(dateYmd);
  return [
    { value: "OCCURRENCE", label: `Only ${WEEKDAY[dow]}, ${md}`, hint: "This one class day. The weekly coaches stay as they are." },
    { value: "WEEKDAY_FORWARD", label: `${WEEKDAY_PLURAL[dow]} from ${md} on`, hint: `Every ${WEEKDAY[dow]} this class runs, starting ${md}. Other weekdays are not changed.` },
    { value: "ALL_FUTURE", label: `Every class day from ${md} on`, hint: `Every day this class runs, starting ${md}.` },
  ];
}

type RuleLike = { id: string; userId: string; roleName: string | null; dayOfWeek: number | null; effectiveFrom: string; effectiveTo: string | null };
export type PickedCoach = { userId: string; roleName: string | null };

/**
 * Who is on the class NOW for a scope — what the coach editor starts from, so
 * saving without touching anything changes nothing.
 *   OCCURRENCE       the coaches scheduled on that day
 *   WEEKDAY_FORWARD  the coaches the weekly plan puts on that weekday
 *   ALL_FUTURE       the coaches the weekly plan puts on EVERY weekday the class runs
 */
export function seedForScope(args: {
  scope: ChangeScope;
  date: string;
  classDays: readonly number[];
  rules: readonly RuleLike[];
  dayRows: readonly { userId: string; roleName: string | null; status: StaffStatus }[];
}): PickedCoach[] {
  if (args.scope === "OCCURRENCE") {
    return args.dayRows.filter((r) => r.status === "SCHEDULED").map((r) => ({ userId: r.userId, roleName: r.roleName }));
  }
  const rules = args.rules.map((r) => ({ ...r, classId: "" }));
  const dow = dowOfYmd(args.date);
  if (args.scope === "WEEKDAY_FORWARD") {
    return rulesForDay(rules, args.date, dow).map((r) => ({ userId: r.userId, roleName: r.roleName }));
  }
  const days = args.classDays.length ? args.classDays : [dow];
  const perDay = days.map((d) => rulesForDay(rules, addDaysYmd(args.date, (d - dow + 7) % 7), d));
  return (perDay[0] ?? [])
    .filter((r) => perDay.every((list) => list.some((x) => x.userId === r.userId)))
    .map((r) => ({ userId: r.userId, roleName: r.roleName }));
}

/** The next date (on or after `fromYmd`) a class with these weekdays runs. */
export function nextClassDay(daysOfWeek: readonly number[], fromYmd: string): string {
  if (daysOfWeek.length === 0) return fromYmd;
  for (let i = 0; i < 7; i++) {
    const d = addDaysYmd(fromYmd, i);
    if (daysOfWeek.includes(dowOfYmd(d))) return d;
  }
  return fromYmd;
}

// ── States ──────────────────────────────────────────────────────────────────

export type StateTone = "normal" | "warn" | "late" | "covered" | "noshow" | "canceled";
export type ChipState = { tone: StateTone; label: string; strike: boolean };

type ChipRow = { id: string | null; userId: string; name: string; replacesStaffId: string | null; coveredByName: string | null; status: StaffStatus };
/**
 * What a class chip says on ONE person's schedule. `my*` are that person's own
 * row (GET /api/staff/schedule). A coach who called out keeps the class, with
 * its state.
 */
export function chipState(c: {
  canceled: boolean;
  cancel?: { paid: boolean } | null;
  myStatus?: StaffStatus | null;
  myKind?: StaffKind | null;
  myRoleName?: string | null;
  myLateCallout?: boolean;
  myRowId?: string | null;
  staffRows?: readonly ChipRow[];
}): ChipState {
  if (c.canceled) return { tone: "canceled", label: `Canceled · ${c.cancel?.paid ? "paid" : "unpaid"}`, strike: true };
  const mine = c.staffRows?.find((r) => r.id !== null && r.id === c.myRowId) ?? null;
  switch (c.myStatus) {
    case "NEEDS_COVERAGE":
      return c.myLateCallout
        ? { tone: "late", label: "Late call-out · needs coverage", strike: false }
        : { tone: "warn", label: "Needs coverage", strike: false };
    case "REPLACED":
      return { tone: "covered", label: mine?.coveredByName ? `Covered by ${mine.coveredByName}` : "Covered", strike: false };
    case "NO_SHOW":
      return { tone: "noshow", label: "No-show", strike: false };
    default: {
      const role = roleLabel(c.myRoleName);
      if (c.myKind === "SUBSTITUTE") {
        const orig = mine?.replacesStaffId ? c.staffRows?.find((r) => r.id === mine.replacesStaffId) : null;
        return { tone: "normal", label: orig ? `${role} · covering for ${orig.name}` : role, strike: false };
      }
      return { tone: "normal", label: role, strike: false };
    }
  }
}

/**
 * What a class day says where the WHOLE class is shown (the Calendar), not one
 * person's row. null = nothing to flag (or the day is not on the new scheduling).
 */
export function classDayState(c: {
  switched?: boolean;
  canceled?: boolean;
  cancel?: { paid: boolean } | null;
  needsCoverage?: boolean;
  staffRows?: readonly { status: StaffStatus; lateCallout: boolean }[];
}): ChipState | null {
  if (!c.switched) return null;
  if (c.canceled) return { tone: "canceled", label: `Canceled · ${c.cancel?.paid ? "paid" : "unpaid"}`, strike: true };
  const open = (c.staffRows ?? []).filter((r) => r.status === "NEEDS_COVERAGE");
  if (c.needsCoverage || open.length > 0) {
    return open.some((r) => r.lateCallout)
      ? { tone: "late", label: "Late call-out · needs coverage", strike: false }
      : { tone: "warn", label: "Needs coverage", strike: false };
  }
  if ((c.staffRows ?? []).some((r) => r.status === "NO_SHOW")) return { tone: "noshow", label: "No-show", strike: false };
  return null;
}

/** What one coach row in the class-day sheet says. null = don't list the row. */
export function rowState(r: {
  status: StaffStatus; kind: StaffKind; lateCallout: boolean; coveredByName: string | null; calledOutAt: string | null;
}): { tone: StateTone; label: string } | null {
  switch (r.status) {
    case "SCHEDULED":
      return { tone: "normal", label: r.kind === "SUBSTITUTE" ? "Covering" : "Scheduled" };
    case "NEEDS_COVERAGE":
      return r.lateCallout ? { tone: "late", label: "Late call-out · needs coverage" } : { tone: "warn", label: "Needs coverage" };
    case "REPLACED":
      return { tone: "covered", label: r.coveredByName ? `Covered by ${r.coveredByName}` : "Covered" };
    case "NO_SHOW":
      return { tone: "noshow", label: "No-show" };
    case "REMOVED":
      // Only a coach who called out and was not replaced stays on the list.
      return r.calledOutAt ? { tone: "covered", label: "Called out · no replacement needed" } : null;
  }
}

/** Inside 2 hours of the start (or already started): a call-out now is LATE. */
export function isLateNow(startsAtIso: string, nowMs: number): boolean {
  return new Date(startsAtIso).getTime() - nowMs < LATE_CALLOUT_MS;
}

// ── Cancelling ──────────────────────────────────────────────────────────────

export const AUDIENCE_LABEL: Record<CancelAudience, string> = {
  BOOKED: "Booked members",
  CLASS_MEMBERS: "Everyone with access to this class",
  BOTH: "Both",
  NONE: "Nobody",
};
const AUDIENCE_HINT: Record<CancelAudience, string> = {
  BOOKED: "Only the people booked into this class day.",
  CLASS_MEMBERS: "Active members whose membership includes this class.",
  BOTH: "Booked members and everyone with access — each family once.",
  NONE: "No email is sent. Tell people yourself.",
};
export const AUDIENCE_ORDER: CancelAudience[] = ["BOOKED", "CLASS_MEMBERS", "BOTH", "NONE"];
export type AudienceCounts = Partial<Record<CancelAudience, { members: number; recipients: number; noAddress: number }>>;

export function audienceOptions(counts: AudienceCounts | null | undefined): { value: CancelAudience; label: string; hint: string }[] {
  return AUDIENCE_ORDER.map((value) => {
    const c = counts?.[value];
    const base = AUDIENCE_LABEL[value];
    const noAddr = c && c.noAddress > 0 ? ` ${plural(c.noAddress, "person has", "people have")} no email on file.` : "";
    return {
      value,
      label: value === "NONE" || !c ? base : `${base} · ${families(c.recipients)}`,
      hint: `${AUDIENCE_HINT[value]}${noAddr}`,
    };
  });
}
/** The confirm button says what it does. */
export function cancelConfirmLabel(audience: CancelAudience, counts: AudienceCounts | null | undefined): string {
  const n = audience === "NONE" ? 0 : counts?.[audience]?.recipients ?? null;
  if (audience === "NONE" || n === 0) return "Cancel class · nobody is emailed";
  return n === null ? "Cancel class" : `Cancel class · email ${families(n)}`;
}

/** An instant → "Oct 12, 3:04 PM" (the viewer's clock unless a timezone is given). */
export function fmtInstant(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, ...(timeZone ? { timeZone } : {}) });
}
/** "Canceled by Julian" · "Oct 12, 3:04 PM" · "Reason: gym closed" · "Notified 14 families (booked members)" · "Coaches paid" */
export function cancelAuditParts(
  c: { canceledAt: string | null; canceledByName: string | null; reason: string | null; notifyAudience: string | null; notifiedCount: number | null; paid: boolean },
  timeZone?: string,
): string[] {
  const parts: string[] = [c.canceledByName ? `Canceled by ${c.canceledByName}` : "Canceled"];
  if (c.canceledAt) parts.push(fmtInstant(c.canceledAt, timeZone));
  if (c.reason) parts.push(`Reason: ${c.reason}`);
  const aud = c.notifyAudience as CancelAudience | null;
  if (aud === "NONE") parts.push("Nobody was emailed");
  else if (aud && AUDIENCE_LABEL[aud]) {
    parts.push(c.notifiedCount === null ? `Told: ${AUDIENCE_LABEL[aud].toLowerCase()}` : `Notified ${families(c.notifiedCount)} (${AUDIENCE_LABEL[aud].toLowerCase()})`);
  }
  parts.push(c.paid ? "Coaches paid" : "Coaches not paid");
  return parts;
}

// ── Call-outs ───────────────────────────────────────────────────────────────

export type CoverageNotifyConfig = { owners: boolean; managers: boolean; classStaff: boolean; roleNames: readonly string[]; people: number };
/** Who hears about a call-out, in words: "The owners, the schedule managers and the other coaches on this class". "" = nobody. */
export function coverageNotifyWho(cfg: CoverageNotifyConfig | null | undefined): string {
  if (!cfg) return "The schedule managers";
  const who: string[] = [];
  if (cfg.owners) who.push("the owners");
  if (cfg.managers) who.push("the schedule managers");
  if (cfg.classStaff) who.push("the other coaches on this class");
  for (const r of cfg.roleNames) who.push(`anyone assigned as ${r}`);
  if (cfg.people > 0) who.push(plural(cfg.people, "named staff member", "named staff members"));
  const s = joinAnd(who);
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}
export function coverageNotifySentence(cfg: CoverageNotifyConfig | null | undefined): string {
  const who = coverageNotifyWho(cfg);
  return who
    ? `The class stays on the schedule. ${who} will be told it needs coverage.`
    : "The class stays on the schedule. Nobody is set to be told automatically — let a schedule manager know yourself.";
}

export type OpenCoverageItem = {
  key: string; classId: string; sessionId: string | null; className: string; date: string; startTime: string; endTime: string;
  coachId: string; coachName: string; late: boolean;
};
/** Open call-outs across the staff feed — LATE first, then the soonest class. */
export function openCoverage(
  staff: readonly {
    id: string; firstName: string; lastName: string;
    classes: readonly { classId: string; sessionId: string | null; name: string; date: string; startTime: string; endTime: string; canceled: boolean; myStatus?: StaffStatus | null; myLateCallout?: boolean; myRowId?: string | null }[];
  }[],
): OpenCoverageItem[] {
  const out: OpenCoverageItem[] = [];
  for (const s of staff) {
    for (const c of s.classes) {
      if (c.canceled || c.myStatus !== "NEEDS_COVERAGE") continue;
      out.push({
        key: c.myRowId ?? `${c.classId}:${c.date}:${s.id}`, classId: c.classId, sessionId: c.sessionId, className: c.name, date: c.date,
        startTime: c.startTime, endTime: c.endTime, coachId: s.id, coachName: `${s.firstName} ${s.lastName}`.trim(), late: !!c.myLateCallout,
      });
    }
  }
  return out.sort((a, b) => Number(b.late) - Number(a.late) || (a.date + a.startTime).localeCompare(b.date + b.startTime) || a.key.localeCompare(b.key));
}

// ── Series summary ──────────────────────────────────────────────────────────

/** "Sal Jones — Lead Coach · every class day; Adrian — Assistant Coach · Tuesdays" */
export function currentStaffSummary(list: readonly { userId: string; name: string; roleName: string | null; dayOfWeek: number | null }[]): string {
  if (list.length === 0) return "Nobody assigned";
  const groups: { userId: string; name: string; roleName: string | null; everyDay: boolean; days: number[] }[] = [];
  for (const e of list) {
    let g = groups.find((x) => x.userId === e.userId && x.roleName === e.roleName);
    if (!g) {
      g = { userId: e.userId, name: e.name, roleName: e.roleName, everyDay: false, days: [] };
      groups.push(g);
    }
    if (e.dayOfWeek === null) g.everyDay = true;
    else if (!g.days.includes(e.dayOfWeek)) g.days.push(e.dayOfWeek);
  }
  return groups
    .map((g) => `${g.name} — ${roleLabel(g.roleName)} · ${g.everyDay ? "every class day" : joinAnd(g.days.sort((a, b) => a - b).map((d) => WEEKDAY_PLURAL[d]))}`)
    .join("; ");
}
