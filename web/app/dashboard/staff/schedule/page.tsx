"use client";

// Club-wide staff Schedule: every OWNER and STAFF user × the week.
// Feed: GET /api/staff/schedule (assignment rules: lib/staffAssignments.ts).
// Writes use the shared APIs — /api/events/[id]/staff, /api/classes/[id]/staff,
// /api/classes/[id]/occurrence — so a change here is what the Calendar, the
// staff profile, the member schedule and payroll read next.
// Times display 12-hour (lib/time12); storage stays "HH:mm".
//
// A club switched on to the new coach scheduling (feed.assignmentsStartOn):
// a class chip shows the coach's role and state and opens the ONE class-day
// sheet (components/staff/schedule/ClassDaySheet.tsx) — coaches, call-outs,
// coverage, cancelling all happen there. The pencil is then only "time or
// note". A club that is not switched on keeps the screen it always had.
// Deep link: ?date=YYYY-MM-DD&class=<classId>&session=<sessionId> (Action Items, emails).
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import Sheet from "@/components/Sheet";
import { range12h, to12h } from "@/lib/time12";
import { classTimesForDay, eventDaysInRange } from "@/lib/staffAssignments";
import { localHhmm, localYmd, weekDates } from "@/lib/staffScheduleFit";
import { fmtDayShort, type RichStaffRow, type StaffKind, type StaffStatus } from "@/lib/classStaff";
import { chipState, openCoverage, type OpenCoverageItem, type StateTone } from "@/lib/classStaffUi";
import ClassDaySheet from "@/components/staff/schedule/ClassDaySheet";
import AwaySheet from "@/components/staff/schedule/AwaySheet";

type Availability = { userId: string; dayOfWeek: number; startTime: string; endTime: string };
type Exception = { id: string; date: string; type: string; startTime: string | null; endTime: string | null; note: string | null };
type ClassInstance = {
  classId: string;
  sessionId: string | null;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  staffIds: string[];
  seriesStaffIds: string[];
  isSubstitute: boolean;
  canceled: boolean;
  note: string | null;
  // Switched-on clubs (absent / false otherwise).
  switched?: boolean;
  staffRows?: RichStaffRow[];
  needsCoverage?: boolean;
  cancel?: { paid: boolean } | null;
  myStatus?: StaffStatus | null;
  myRowId?: string | null;
  myRoleName?: string | null;
  myKind?: StaffKind | null;
  myLateCallout?: boolean;
};
/** Which class day the class-day sheet is open on. */
type DayTarget = { classId: string; date: string; start?: "edit"; addUserId?: string };
type StaffLite = { id: string; firstName: string; lastName: string };
type EventPart = { startsAt: string; endsAt: string };
type EventAssignment = { id: string; name: string; type: string; startsAt: string; endsAt: string; sessions?: EventPart[] };

type StaffSchedule = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  title: string | null;
  availability: Availability[];
  exceptions: Exception[];
  classes: ClassInstance[];
  events: EventAssignment[];
};

type AllEvent = EventAssignment & { date: string; assignedUserIds: string[] };
type AllClass = {
  id: string;
  name: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  dayOverrides?: { dayOfWeek: number; startTime: string; endTime: string }[];
  assignedStaffIds: string[];
};

type Feed = {
  staff: StaffSchedule[];
  allEvents: AllEvent[];
  allClasses: AllClass[];
  // What the signed-in person may do; the APIs enforce the same (lib/staffSelf.ts).
  viewer: { userId: string; canAssign: boolean };
  /** YYYY-MM-DD the new coach scheduling applies from; null = this club is not switched on. */
  assignmentsStartOn: string | null;
  /** Today on the club's clock (the viewer's device may be on another day). */
  today: string | null;
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const btn =
  "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";
const iconBtn =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md opacity-70 hover:opacity-100 hover:bg-surface md:h-7 md:w-7 disabled:opacity-40";
const danger = { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" };
const warn = { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" };
// A class chip's colours by state (switched-on clubs).
const CHIP_CLASS: Record<StateTone, string> = {
  normal: "bg-brand/10 text-brand",
  warn: "",
  late: "font-semibold",
  covered: "",
  noshow: "",
  canceled: "bg-app-bg text-text-muted",
};
const CHIP_STYLE: Record<StateTone, React.CSSProperties | undefined> = {
  normal: undefined,
  warn: { ...warn, boxShadow: "inset 0 0 0 1px var(--color-warn-border)" },
  late: { ...danger, boxShadow: "inset 0 0 0 1px var(--color-danger-text)" },
  covered: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
  noshow: danger,
  canceled: undefined,
};

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(ymd: string, n: number): string {
  return new Date(ymdToUtc(ymd).getTime() + n * 86400000).toISOString().slice(0, 10);
}
function dayLabel(ymd: string, opts: Intl.DateTimeFormatOptions): string {
  return ymdToUtc(ymd).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}
async function errorOf(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return typeof d?.error === "string" ? d.error : fallback;
}

export default function StaffSchedulePage() {
  const [weekStart, setWeekStart] = useState(() => weekDates(localYmd(new Date()))[0]);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const { data: session } = useSession();
  const isOwner = session?.user?.role === "OWNER";
  const [daySheet, setDaySheet] = useState<DayTarget | null>(null);
  const [away, setAway] = useState(false);
  // Open call-outs for the next four weeks (schedule managers) — not tied to the week on screen.
  const [coverage, setCoverage] = useState<OpenCoverageItem[]>([]);
  // ?date=&class=&session= — resolved once the feed says the club is switched on.
  const [deepLink, setDeepLink] = useState<{ date: string; classId: string | null; sessionId: string | null } | null>(null);

  const weekDays = useMemo(() => weekDates(weekStart), [weekStart]);

  const load = useCallback(() => {
    fetch(`/api/staff/schedule?from=${weekDays[0]}&to=${weekDays[6]}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setFeed(d ? {
          staff: d.staff ?? [], allEvents: d.allEvents ?? [], allClasses: d.allClasses ?? [],
          viewer: { userId: d.viewer?.userId ?? "", canAssign: !!d.viewer?.canAssign },
          assignmentsStartOn: typeof d.assignmentsStartOn === "string" ? d.assignmentsStartOn : null,
          today: typeof d.today === "string" ? d.today : null,
        } : null);
        setLoading(false);
        if (d?.assignmentsStartOn && d.viewer?.canAssign) {
          // From the CLUB's today: a manager whose phone is already on tomorrow
          // must still see tonight's call-outs.
          const today = typeof d.today === "string" ? d.today : localYmd(new Date());
          fetch(`/api/staff/schedule?from=${today}&to=${addDays(today, 27)}`, { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((ahead) => setCoverage(ahead ? openCoverage(ahead.staff ?? []) : []))
            .catch(() => {});
        } else {
          setCoverage([]);
        }
      });
  }, [weekDays]);

  // Deep link from an Action Item or an email: jump to that week, then open the class day.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const date = (q.get("date") ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    setWeekStart(weekDates(date)[0]);
    const classId = q.get("class");
    const sessionId = q.get("session");
    if (classId || sessionId) setDeepLink({ date, classId, sessionId });
  }, []);
  useEffect(() => {
    if (!deepLink || !feed) return;
    if (!feed.assignmentsStartOn) {
      setDeepLink(null);
      return;
    }
    let classId = deepLink.classId;
    if (!classId && deepLink.sessionId) {
      for (const s of feed.staff) {
        const hit = s.classes.find((c) => c.sessionId === deepLink.sessionId);
        if (hit) {
          classId = hit.classId;
          break;
        }
      }
      // The feed on screen may still be the previous week's — wait for the right one.
      if (!classId && !feed.staff.some((s) => s.classes.some((c) => c.date >= weekDates(deepLink.date)[0] && c.date <= weekDates(deepLink.date)[6]))) return;
    }
    if (classId) setDaySheet({ classId, date: deepLink.date });
    setDeepLink(null);
  }, [deepLink, feed]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const staff = feed?.staff ?? [];
  const allStaff = useMemo(() => staff.map((x) => ({ id: x.id, firstName: x.firstName, lastName: x.lastName })), [staff]);
  const report = useCallback((tone: "ok" | "error", text: string) => {
    setFlash({ tone, text });
    if (tone === "ok") load();
  }, [load]);
  const switchedOn = !!feed?.assignmentsStartOn;
  const staffOptions = useMemo(() => allStaff.map((x) => ({ id: x.id, name: `${x.firstName} ${x.lastName}`.trim() })), [allStaff]);
  const iAmOnTheSchedule = !!feed && staff.some((x) => x.id === feed.viewer.userId);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Schedule</h1>
          <p className="text-sm text-text-muted mt-1">
            Everyone&apos;s availability, classes and events for the week.
            {feed?.viewer.canAssign ? " Use + Assign on a day to add someone." : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {switchedOn && iAmOnTheSchedule && (
            <button onClick={() => setAway(true)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>I&apos;m out for several days</button>
          )}
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} className={`${btn} gap-1 border border-app-border text-text-primary hover:bg-app-bg`}>
            <ChevronLeft className="h-4 w-4" strokeWidth={2} /> Prev
          </button>
          <button onClick={() => setWeekStart(weekDates(localYmd(new Date()))[0])} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>This week</button>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} className={`${btn} gap-1 border border-app-border text-text-primary hover:bg-app-bg`}>
            Next <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      </div>

      <p className="text-sm text-text-muted mb-3">
        Week of {dayLabel(weekDays[0], { month: "long", day: "numeric", year: "numeric" })}
      </p>

      {flash && (
        <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-lg px-4 py-2 text-[13px]"
          style={flash.tone === "ok" ? { background: "var(--color-success-surface)", color: "var(--color-success-text)" } : danger}>
          <span>{flash.text}</span>
          <button type="button" onClick={() => setFlash(null)} aria-label="Dismiss" className={iconBtn}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {feed && !switchedOn && isOwner && (
        <p className="mb-3 rounded-lg border border-app-border bg-surface px-4 py-2.5 text-[13px] text-text-muted">
          New coach scheduling is off — turn it on in{" "}
          <Link href="/dashboard/settings?section=scheduling" className="font-medium text-text-primary underline">Settings → Scheduling</Link>.
        </p>
      )}

      {switchedOn && feed?.viewer.canAssign && coverage.length > 0 && (
        <section aria-label="Needs coverage" className="mb-3 rounded-xl px-4 py-3" style={{ ...warn, boxShadow: "inset 0 0 0 1px var(--color-warn-border)" }}>
          <p className="text-[13px] font-semibold">Needs coverage · {coverage.length} class day{coverage.length === 1 ? "" : "s"}</p>
          <ul className="mt-1.5 space-y-1.5">
            {coverage.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => setDaySheet({ classId: c.classId, date: c.date })}
                  className="flex min-h-[44px] w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-surface px-3 py-1.5 text-left text-[13px] text-text-primary hover:bg-app-bg md:min-h-[36px]"
                >
                  {c.late && <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={danger}>Late call-out</span>}
                  <span className="font-medium">{c.className}</span>
                  <span className="text-text-muted">{fmtDayShort(c.date)} · {range12h(c.startTime, c.endTime)}</span>
                  <span className="text-text-muted">— {c.coachName} can&apos;t make it</span>
                  <span className="ml-auto font-medium text-brand">Find a substitute</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loading ? (
        <p className="text-sm text-text-muted text-center py-16">Loading…</p>
      ) : staff.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-12 text-center">
          <p className="text-base font-medium text-text-primary mb-1">No staff yet</p>
          <p className="text-sm text-text-muted">
            Invite staff first on the <Link href="/dashboard/staff" className="underline">Directory</Link> page.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-app-bg border-b border-app-border">
                  <th className="sticky left-0 z-10 bg-app-bg text-left px-3 py-2 font-medium text-text-muted uppercase w-40">Staff</th>
                  {weekDays.map((d) => (
                    <th key={d} className="text-left px-2 py-2 font-medium text-text-muted uppercase min-w-[150px]">
                      <div>{DAY_LABELS[ymdToUtc(d).getUTCDay()]}</div>
                      <div className="text-text-primary font-semibold text-sm">{ymdToUtc(d).getUTCDate()}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} className="border-b border-app-border last:border-0 align-top">
                    <td className="sticky left-0 z-10 bg-surface px-3 py-3 w-40 border-r border-app-border">
                      <Link href={`/dashboard/staff/${s.id}`} className="text-sm font-medium text-text-primary hover:underline">
                        {s.firstName} {s.lastName}
                      </Link>
                      {s.title && <p className="text-xs text-text-muted">{s.title}</p>}
                      <p className="text-xs text-text-muted">{s.role === "OWNER" ? "Owner" : "Staff"}</p>
                    </td>
                    {weekDays.map((d) => (
                      <DayCell
                        key={d}
                        staff={s}
                        dateStr={d}
                        allEvents={feed!.allEvents}
                        allClasses={feed!.allClasses}
                        allStaff={allStaff}
                        report={report}
                        canManage={feed!.viewer.canAssign}
                        isMe={s.id === feed!.viewer.userId}
                        switchedOn={switchedOn}
                        openDay={setDaySheet}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-text-muted mt-3">
        Recurring weekly hours and date exceptions are edited on the{" "}
        <Link href="/dashboard/staff/availability" className="underline">Availability</Link> page.
      </p>

      {daySheet && (
        <ClassDaySheet
          key={`${daySheet.classId}:${daySheet.date}:${daySheet.start ?? ""}:${daySheet.addUserId ?? ""}`}
          classId={daySheet.classId}
          date={daySheet.date}
          start={daySheet.start}
          addUserId={daySheet.addUserId}
          staffOptions={feed?.viewer.canAssign ? staffOptions : undefined}
          onClose={() => setDaySheet(null)}
          onChanged={(text) => report("ok", text)}
        />
      )}
      {away && (
        <AwaySheet
          today={feed?.today ?? localYmd(new Date())}
          onClose={() => setAway(false)}
          onDone={(text) => { setAway(false); report("ok", text); }}
        />
      )}
    </div>
  );
}

function DayCell({
  staff,
  dateStr,
  allEvents,
  allClasses,
  allStaff,
  report,
  canManage,
  isMe,
  switchedOn,
  openDay,
}: {
  staff: StaffSchedule;
  dateStr: string;
  allEvents: AllEvent[];
  allClasses: AllClass[];
  allStaff: StaffLite[];
  report: (tone: "ok" | "error", text: string) => void;
  /** Schedule managers (schedule:edit) assign, edit and remove anyone. */
  canManage: boolean;
  /** This row is the signed-in person — without canManage they may only take themself off. */
  isMe: boolean;
  /** The club is on the new coach scheduling: class chips open the class-day sheet. */
  switchedOn: boolean;
  openDay: (t: DayTarget) => void;
}) {
  const selfOnly = isMe && !canManage;
  const dow = ymdToUtc(dateStr).getUTCDay();
  const slots = staff.availability.filter((a) => a.dayOfWeek === dow);
  const exception = staff.exceptions.find((e) => e.date === dateStr);
  const classes = staff.classes.filter((c) => c.date === dateStr);
  // Events are instants: place them on the viewer's local days, every day a
  // multi-day event touches.
  const events = staff.events.flatMap((e) =>
    eventDaysInRange(e, [dateStr], localYmd).map((p) => ({ ...e, part: p })),
  );
  const isUnavailable = exception?.type === "UNAVAILABLE";
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingOcc, setEditingOcc] = useState<ClassInstance | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "class"; inst: ClassInstance }
    | { kind: "event"; id: string; name: string }
    | null
  >(null);
  const who = `${staff.firstName} ${staff.lastName}`.trim();
  const dayText = dayLabel(dateStr, { weekday: "short", month: "short", day: "numeric" });

  const assignableEvents = allEvents
    .filter((e) => !e.assignedUserIds.includes(staff.id))
    .flatMap((e) => {
      const p = eventDaysInRange(e, [dateStr], localYmd)[0];
      return p ? [{ ...e, part: p }] : [];
    });
  const assignableClasses = allClasses
    // Switched on: coaches can differ by weekday, so "already on it" is judged on THIS day.
    .filter((c) => c.daysOfWeek.includes(dow) && (switchedOn ? !classes.some((x) => x.classId === c.id) : !c.assignedStaffIds.includes(staff.id)))
    .map((c) => ({ ...c, times: classTimesForDay(c.startTime, c.endTime, c.dayOverrides, dow) }));
  const canAssign = assignableEvents.length > 0 || assignableClasses.length > 0;

  async function run(req: Promise<Response>, ok: string, fail: string) {
    setBusy(true);
    const res = await req;
    setBusy(false);
    if (!res.ok) {
      report("error", await errorOf(res, fail));
      return false;
    }
    report("ok", ok);
    return true;
  }
  async function assignEvent(e: { id: string; name: string }) {
    const ok = await run(
      fetch(`/api/events/${e.id}/staff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: staff.id, role: "Coach" }),
      }),
      `${who} added to ${e.name} — saved.`,
      "Couldn't add them to that event.",
    );
    if (ok) setPicking(false);
  }
  async function assignClass(c: { id: string; name: string }) {
    const ok = await run(
      fetch(`/api/classes/${c.id}/staff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: staff.id }),
      }),
      `${who} now coaches every ${c.name} — saved.`,
      "Couldn't add them to that class.",
    );
    if (ok) setPicking(false);
  }
  async function confirmRemove() {
    if (!confirm) return;
    const ok =
      confirm.kind === "event"
        ? await run(
            fetch(`/api/events/${confirm.id}/staff?userId=${encodeURIComponent(staff.id)}`, { method: "DELETE" }),
            `${who} removed from ${confirm.name} — saved.`,
            "Couldn't remove them from that event.",
          )
        : await run(
            fetch(`/api/classes/${confirm.inst.classId}/staff?userId=${encodeURIComponent(staff.id)}`, { method: "DELETE" }),
            `${who} removed from every ${confirm.inst.name} — saved.`,
            "Couldn't remove them from that class.",
          );
    if (ok) setConfirm(null);
  }
  // A coach without schedule access taking themself off ONE day. The server
  // works out the list and tells the other coaches (POST …/occurrence removeSelf).
  async function removeMeThisDay() {
    if (!confirm || confirm.kind !== "class") return;
    const ok = await run(
      fetch(`/api/classes/${confirm.inst.classId}/occurrence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, scope: "occurrence", removeSelf: true }),
      }),
      `You're off ${confirm.inst.name} on ${dayText} — the other coaches have been told.`,
      "Couldn't take you off that day.",
    );
    if (ok) setConfirm(null);
  }

  return (
    <td className="px-2 py-3 align-top">
      {isUnavailable ? (
        <div className="text-xs rounded px-1.5 py-1" style={danger}>
          Unavailable{exception?.note ? ` — ${exception.note}` : ""}
        </div>
      ) : (
        <>
          {slots.length > 0 && (
            <div className="mb-1.5 space-y-0.5">
              {slots.map((s, i) => (
                <div key={i} className="text-xs text-text-muted">{range12h(s.startTime, s.endTime)}</div>
              ))}
            </div>
          )}
          {exception?.type === "PARTIAL" && (
            <div className="text-xs mb-1 rounded px-1.5 py-0.5" style={warn}>
              This date: {range12h(exception.startTime, exception.endTime)}
            </div>
          )}

          {classes.map((c, i) => {
            if (switchedOn) {
              // New coach scheduling: the chip says the role + state and opens the class-day sheet.
              const st = chipState(c);
              const rich = !!c.switched;
              return (
                <div
                  key={`c-${c.classId}-${i}`}
                  className={`mb-1 text-xs rounded leading-tight flex items-start justify-between gap-1 ${CHIP_CLASS[st.tone]}`}
                  style={CHIP_STYLE[st.tone]}
                >
                  <button
                    type="button"
                    onClick={() => openDay({ classId: c.classId, date: c.date })}
                    aria-label={`${c.name}, ${dayText} — ${st.label}. Open this class day`}
                    className="min-h-[44px] min-w-0 flex-1 rounded px-1.5 py-1 text-left hover:opacity-80 md:min-h-0"
                  >
                    <span className={`font-medium block truncate ${st.strike ? "line-through" : ""}`}>{c.name}</span>
                    <span className="block opacity-80">{range12h(c.startTime, c.endTime)}</span>
                    <span className="block">{rich ? st.label : c.canceled ? "Canceled" : c.isSubstitute ? "Changed for this day" : "Coach"}</span>
                    {c.note && <span className="block opacity-80 truncate" title={c.note}>Note: {c.note}</span>}
                  </button>
                  {canManage && !c.canceled && (
                    <button onClick={() => setEditingOcc(c)} disabled={busy} aria-label={`Change the time or note for ${c.name} on ${dayText}`} className={iconBtn}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            }
            return (
            <div
              key={`c-${c.classId}-${i}`}
              className={`mb-1 text-xs rounded px-1.5 py-1 leading-tight flex items-start justify-between gap-1 ${
                c.canceled ? "bg-app-bg text-text-muted" : c.isSubstitute ? "" : "bg-brand/10 text-brand"
              }`}
              style={!c.canceled && c.isSubstitute ? warn : undefined}
            >
              <span className="min-w-0 py-0.5">
                <span className={`font-medium block truncate ${c.canceled ? "line-through" : ""}`}>{c.name}</span>
                <span className="block opacity-80">{range12h(c.startTime, c.endTime)}</span>
                {c.isSubstitute && !c.canceled && <span className="block opacity-80">Changed for this day</span>}
                {c.canceled && <span className="block">Canceled</span>}
                {c.note && <span className="block opacity-80 truncate" title={c.note}>Note: {c.note}</span>}
              </span>
              <span className="flex flex-col items-end">
                {canManage && (
                  <button onClick={() => setEditingOcc(c)} disabled={busy} aria-label={`Edit ${c.name} on ${dayText}`} className={iconBtn}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                {(canManage ? c.seriesStaffIds.includes(staff.id) : isMe && !c.canceled) && (
                  <button onClick={() => setConfirm({ kind: "class", inst: c })} disabled={busy} aria-label={selfOnly ? `Remove me from ${c.name}` : `Remove ${who} from every ${c.name}`} className={iconBtn}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </div>
            );
          })}

          {events.map((e) => (
            <div key={`${e.id}-${e.part.startsAt.getTime()}`} className="mb-1 text-xs rounded px-1.5 py-1 leading-tight flex items-start justify-between gap-1" style={{ background: "var(--color-pending-surface)", color: "var(--color-pending-text)" }}>
              <span className="min-w-0 py-0.5">
                <span className="font-medium block truncate">{e.name}</span>
                <span className="block opacity-80">{range12h(localHhmm(e.part.startsAt), localHhmm(e.part.endsAt))}</span>
              </span>
              {(canManage || isMe) && (
                <button onClick={() => setConfirm({ kind: "event", id: e.id, name: e.name })} disabled={busy} aria-label={selfOnly ? `Remove me from ${e.name}` : `Remove ${who} from ${e.name}`} className={iconBtn}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}

          {slots.length === 0 && classes.length === 0 && events.length === 0 && !exception && (
            <div className="text-xs text-text-muted mb-1">Off</div>
          )}

          {canManage && canAssign && (
            <button onClick={() => setPicking(true)} className="inline-flex min-h-[44px] items-center text-xs text-text-muted hover:text-brand md:min-h-[28px]">
              + Assign
            </button>
          )}
        </>
      )}

      <Sheet open={picking} onClose={() => setPicking(false)} title={`Assign ${who}`} description={dayText}>
        {assignableEvents.length > 0 && (
          <>
            <p className="text-xs uppercase text-text-muted mb-1">Events</p>
            <ul className="divide-y divide-app-border mb-3">
              {assignableEvents.map((e) => (
                <li key={e.id}>
                  <button onClick={() => assignEvent(e)} disabled={busy}
                    className="flex min-h-[44px] w-full items-center justify-between gap-3 px-1 text-left text-[14px] text-text-primary hover:bg-app-bg disabled:opacity-50">
                    <span className="truncate">{e.name}</span>
                    <span className="text-xs text-text-muted shrink-0">{to12h(localHhmm(e.part.startsAt))}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {assignableClasses.length > 0 && (
          <>
            <p className="text-xs uppercase text-text-muted mb-1">{switchedOn ? "Classes" : "Classes · every week"}</p>
            <ul className="divide-y divide-app-border">
              {assignableClasses.map((c) => (
                <li key={c.id}>
                  <button onClick={() => { if (switchedOn) { setPicking(false); openDay({ classId: c.id, date: dateStr, start: "edit", addUserId: staff.id }); } else assignClass(c); }} disabled={busy}
                    className="flex min-h-[44px] w-full items-center justify-between gap-3 px-1 text-left text-[14px] text-text-primary hover:bg-app-bg disabled:opacity-50">
                    <span className="truncate">{c.name}</span>
                    <span className="text-xs text-text-muted shrink-0">{range12h(c.times.startTime, c.times.endTime)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-text-muted mt-2">
              {switchedOn ? "Next you choose their role and which class days — nothing is saved until you review it." : "To cover one day only, use the pencil on that class instead."}
            </p>
          </>
        )}
      </Sheet>

      <Sheet
        open={!!confirm}
        onClose={() => !busy && setConfirm(null)}
        title={confirm
          ? selfOnly
            ? `Remove me from ${confirm.kind === "event" ? confirm.name : confirm.inst.name}?`
            : confirm.kind === "event" ? `Remove ${who} from ${confirm.name}?` : `Remove ${who} from every ${confirm.inst.name}?`
          : ""}
        footer={
          <>
            <button onClick={() => setConfirm(null)} disabled={busy} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>Cancel</button>
            {selfOnly && confirm?.kind === "class" && (
              <button onClick={removeMeThisDay} disabled={busy} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>Just {dayText}</button>
            )}
            {(!selfOnly || confirm?.kind === "event" || (confirm?.kind === "class" && confirm.inst.seriesStaffIds.includes(staff.id))) && (
              <button onClick={confirmRemove} disabled={busy} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
                {busy ? "Removing…" : selfOnly && confirm?.kind === "class" ? "Every week" : "Remove"}
              </button>
            )}
          </>
        }
      >
        <p className="text-[13px] text-text-muted">
          {selfOnly
            ? "You can take yourself off. The other coaches and whoever manages the schedule are told right away so they can cover it. To be put back on, ask a schedule manager."
            : confirm?.kind === "event"
            ? "They come off the staff schedule, their profile and the calendar for this event. Any pay set up for them on this event that hasn't been generated yet is removed too."
            : `This takes them off every ${confirm?.kind === "class" ? confirm.inst.name : ""} session, not just ${dayText}. To change one day only, use the pencil instead.`}
        </p>
      </Sheet>

      {editingOcc && (
        <OccurrenceEditor
          instance={editingOcc}
          timesOnly={switchedOn && !!editingOcc.switched}
          allStaff={allStaff}
          onClose={() => setEditingOcc(null)}
          onSaved={(text) => { setEditingOcc(null); report("ok", text); }}
        />
      )}
    </td>
  );
}

const SCOPES: { value: "occurrence" | "following" | "series"; label: string; hint: string }[] = [
  { value: "occurrence", label: "Just this day", hint: "Only this one date" },
  { value: "following", label: "This day and after", hint: "This date and every later session" },
  { value: "series", label: "Every week", hint: "The class itself" },
];

function OccurrenceEditor({
  instance,
  timesOnly = false,
  allStaff,
  onClose,
  onSaved,
}: {
  instance: ClassInstance;
  /** New coach scheduling: coaches and cancelling live in the class-day sheet — this edits time and note only. */
  timesOnly?: boolean;
  allStaff: StaffLite[];
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [scope, setScope] = useState<"occurrence" | "following" | "series">("occurrence");
  const [staffMode, setStaffMode] = useState<string>(""); // "" keep, "__reset__", "__none__", or a userId
  const [startTime, setStartTime] = useState(instance.startTime);
  const [endTime, setEndTime] = useState(instance.endTime);
  const [note, setNote] = useState(instance.note ?? "");
  const [canceled, setCanceled] = useState(instance.canceled);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const seriesScope = scope === "series";
  const dateText = dayLabel(instance.date, { weekday: "long", month: "short", day: "numeric" });
  const field = "w-full min-h-[44px] px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary md:min-h-[36px]";

  async function save() {
    setBusy(true);
    setErr("");
    const payload: Record<string, unknown> = { date: instance.date, scope };
    if (timesOnly) { /* coaches are not sent from here */ }
    else if (staffMode === "__reset__") payload.staffIds = null;
    else if (staffMode === "__none__") payload.staffIds = [];
    else if (staffMode) payload.staffIds = [staffMode];
    if (startTime && startTime !== instance.startTime) payload.startTime = startTime;
    if (endTime && endTime !== instance.endTime) payload.endTime = endTime;
    if (!seriesScope) {
      payload.note = note.trim() ? note.trim() : null;
      if (!timesOnly) payload.canceled = canceled;
    }
    const res = await fetch(`/api/classes/${instance.classId}/occurrence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) { setErr(await errorOf(res, "Could not save")); return; }
    onSaved(`${instance.name}, ${dateText} updated — saved.`);
  }

  return (
    <Sheet
      open
      onClose={() => !busy && onClose()}
      title={instance.name}
      description={dateText}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>Cancel</button>
          <button onClick={save} disabled={busy} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>{busy ? "Saving…" : "Save"}</button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="text-xs uppercase text-text-muted mb-1.5">Apply to</legend>
          <div className="space-y-1">
            {SCOPES.map((s) => (
              <label key={s.value} className="flex min-h-[44px] items-start gap-2 text-sm cursor-pointer">
                <input type="radio" name="scope" checked={scope === s.value} onChange={() => setScope(s.value)} className="mt-1" />
                <span>
                  <span className="text-text-primary">{s.label}</span>
                  <span className="text-text-muted text-xs block">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {timesOnly && (
          <p className="text-xs text-text-muted">This changes the time and the note. To change coaches or cancel this day, close this and tap the class on the schedule.</p>
        )}
        <div className={timesOnly ? "hidden" : undefined}>
          <label className="block text-xs uppercase text-text-muted mb-1">Coach</label>
          <select value={staffMode} onChange={(e) => setStaffMode(e.target.value)} className={field}>
            <option value="">Keep current coach(es)</option>
            <option value="__reset__">Use the weekly coaches</option>
            <option value="__none__">No coach</option>
            <optgroup label="Replace with">
              {allStaff.map((st) => (
                <option key={st.id} value={st.id}>{st.firstName} {st.lastName}</option>
              ))}
            </optgroup>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs uppercase text-text-muted mb-1">Start</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={field} />
            <p className="text-xs text-text-muted mt-0.5">{to12h(startTime)}</p>
          </div>
          <div>
            <label className="block text-xs uppercase text-text-muted mb-1">End</label>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={field} />
            <p className="text-xs text-text-muted mt-0.5">{to12h(endTime)}</p>
          </div>
        </div>

        {!seriesScope && (
          <>
            <div>
              <label className="block text-xs uppercase text-text-muted mb-1">Note for this day</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary"
                placeholder="e.g. Use the back room today" />
            </div>
            {!timesOnly && (
              <label className="flex min-h-[44px] items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={canceled} onChange={(e) => setCanceled(e.target.checked)} />
                <span className="text-text-primary">Cancel {scope === "following" ? "this and the following sessions" : "this session"}</span>
              </label>
            )}
          </>
        )}
        {seriesScope && (
          <p className="text-xs text-text-muted">
            Changes the class itself. Future sessions move to the new time; bookings and one-day edits are kept.
          </p>
        )}

        {err && <div className="text-[13px] rounded px-2 py-1" style={danger}>{err}</div>}
      </div>
    </Sheet>
  );
}
