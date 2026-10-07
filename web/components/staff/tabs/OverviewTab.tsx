"use client";

// B21 — Overview tab (design/Main.dc.html). Read-only summary; every change
// happens on its own tab. The outside-hours banner uses the same resolver
// as the Schedule tab (lib/staffScheduleFit.ts) on the same week feed.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { PERMISSION_CATALOG, type PermissionLevel } from "@/lib/permissions";
import { range12h, to12h } from "@/lib/time12";
import { eventDaysInRange } from "@/lib/staffAssignments";
import { fromMinutes, localHhmm, localYmd, scheduleFit, toMinutes, weekDates, type DayBand } from "@/lib/staffScheduleFit";
import type { StaffTabProps } from "@/components/staff/types";

type FeedPerson = {
  id: string;
  availability: { dayOfWeek: number; startTime: string; endTime: string }[];
  exceptions: { id: string; date: string; type: string; startTime: string | null; endTime: string | null; note: string | null }[];
  classes: { classId: string; name: string; date: string; startTime: string; endTime: string; canceled: boolean }[];
  events: { id: string; name: string; startsAt: string; endsAt: string; sessions?: { startsAt: string; endsAt: string }[] }[];
};
type WeekItem = { key: string; name: string; date: string; startTime: string; endTime: string };
type Plan = { baseType: "SALARY" | "PER_CLASS" | "HOURLY"; baseAmount: number; bonuses: { bonusType: string; amount: number }[] } | null;
type Exception = { id: string; date: string; type: string; startTime: string | null; endTime: string | null; note: string | null };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const tint = {
  ok: { background: "var(--color-success-surface)", color: "var(--color-success-text)" },
  warn: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" },
  chip: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  pending: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
};
const card = "rounded-xl border border-app-border bg-surface p-4 sm:p-5";
const h2 = "text-[15px] font-semibold text-text-primary";
const cardLink = "inline-flex min-h-[44px] items-center text-[13px] font-medium text-brand hover:underline md:min-h-0";
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function shortDate(ymd: string): string {
  return ymdToUtc(ymd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function monthDay(ymd: string): string {
  return ymdToUtc(ymd).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
function bandText(b: DayBand): string {
  const r = b.windows.map((w) => range12h(fromMinutes(w.start), fromMinutes(w.end))).join(", ");
  if (b.kind === "available") return `Available ${r}`;
  if (b.kind === "none") return "Not available";
  if (b.kind === "time_off") return `Time off${b.note ? ` · ${b.note}` : ""}`;
  return r ? `Available ${r} (this date)` : "Not available (this date)";
}
function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function relativeDay(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date(localYmd(new Date())).getTime() - new Date(localYmd(d)).getTime()) / 86400000);
  if (days <= 0) return `Today, ${to12h(localHhmm(d))}`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
const BASE_LABEL: Record<string, string> = { SALARY: "Salary (monthly)", PER_CLASS: "Per class", HOURLY: "Hourly" };
const BASE_UNIT: Record<string, string> = { SALARY: "/ month", PER_CLASS: "per class", HOURLY: "/ hour" };
const BONUS_LABEL: Record<string, string> = { ATTENDANCE: "Attendance bonus", SIGNUP: "Signup bonus", REVENUE_SHARE: "Revenue share" };

function levelStyle(l: PermissionLevel): { className?: string; style?: React.CSSProperties } {
  if (l === "full") return { style: tint.ok };
  if (l === "edit" || l === "send") return { className: "bg-orange-accent/10 text-orange-accent" };
  return { style: tint.pending };
}

export default function OverviewTab({ data, goTo }: StaffTabProps) {
  const { staff, viewer, counts, activity } = data;
  const first = staff.firstName || "This staff member";
  const self = viewer.isSelf;
  const today = localYmd(new Date());
  const days = useMemo(() => weekDates(today), [today]);

  // This week — same feed and resolver as the Schedule tab.
  const [me, setMe] = useState<FeedPerson | null>(null);
  const [weekError, setWeekError] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/staff/schedule?from=${days[0]}&to=${days[6]}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => live && setMe(((d.staff ?? []) as FeedPerson[]).find((p) => p.id === staff.id) ?? null))
      .catch(() => live && setWeekError(true));
    return () => {
      live = false;
    };
  }, [days, staff.id]);

  // Upcoming time off (optional; hidden if the viewer can't read it).
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`/api/staff/${staff.id}/availability/exceptions`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => live && setExceptions(Array.isArray(d) ? d : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [staff.id]);

  // Pay — only fetched when the viewer may see it.
  const [plan, setPlan] = useState<Plan | undefined>(undefined);
  useEffect(() => {
    if (!viewer.canViewPay) return;
    let live = true;
    fetch(`/api/staff/${staff.id}/compensation`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => live && setPlan((d.plan ?? null) as Plan))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [viewer.canViewPay, staff.id]);

  const items: WeekItem[] = useMemo(() => {
    if (!me) return [];
    const out: WeekItem[] = me.classes
      .filter((c) => !c.canceled)
      .map((c) => ({ key: `c-${c.classId}-${c.date}`, name: c.name, date: c.date, startTime: c.startTime, endTime: c.endTime }));
    // A multi-day event shows on every day of this week it touches.
    for (const e of me.events) {
      for (const part of eventDaysInRange(e, days, localYmd)) {
        out.push({ key: `e-${e.id}-${part.date}-${part.startsAt.getTime()}`, name: e.name, date: part.date, startTime: localHhmm(part.startsAt), endTime: localHhmm(part.endsAt) });
      }
    }
    return out.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  }, [me, days]);
  const fit = useMemo(
    () => scheduleFit(days, (me?.availability ?? []).map((a) => ({ ...a, active: true })), me?.exceptions ?? [], items),
    [days, me, items],
  );
  const outside = fit.results.filter((r) => r.fit === "outside").map((r) => r.assignment);
  const outsideKeys = new Set(outside.map((o) => o.key));
  const totalMinutes = items.reduce((sum, it) => {
    const s = toMinutes(it.startTime);
    const e = toMinutes(it.endTime);
    return s !== null && e !== null && e > s ? sum + (e - s) : sum;
  }, 0);
  const hoursText = `${Math.round((totalMinutes / 60) * 10) / 10} hour${totalMinutes === 60 ? "" : "s"}`;
  const upcoming = exceptions.filter((x) => x.date.slice(0, 10) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const nextOff = upcoming[0];
  const availDays = new Set((me?.availability ?? []).map((a) => a.dayOfWeek)).size;

  // Setup link (same API as the header button).
  const [setupNotice, setSetupNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  async function sendSetupLink() {
    setSending(true);
    const res = await fetch(`/api/staff/${staff.id}/setup-link`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setSending(false);
    if (!res.ok) return setSetupNotice(d.error || "Couldn't create a setup link.");
    try {
      await navigator.clipboard.writeText(d.setupUrl);
    } catch {}
    setSetupNotice(d.emailed ? `Setup link emailed to ${staff.email} and copied.` : "Email didn't send — the setup link is copied, send it yourself.");
  }

  const showBanner = outside.length > 0 || counts.w9Missing;
  const n = outside.length;
  const conflictList = outside.map((o) => `${o.name}, ${shortDate(o.date)} ${to12h(o.startTime)}`).join("; ");

  return (
    <div className="space-y-4">
      {showBanner && (
        <div role="status" className="flex flex-col gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center" style={{ ...tint.warn, borderColor: "var(--color-warn-border)" }}>
          <div className="min-w-0 flex-1 space-y-2">
            {n > 0 && (
              <div>
                <div className="text-[14px] font-semibold">
                  {self
                    ? `Your hours don’t cover ${n} assignment${n === 1 ? "" : "s"} this week`
                    : `Waiting on you — ${n} assignment${n === 1 ? "" : "s"} outside ${first}’s availability`}
                </div>
                <div className="mt-0.5 text-[13px]">
                  <b className="font-medium">{conflictList}</b>
                  {self
                    ? ". Add hours that cover it, or tell an owner you can’t make it."
                    : `. ${first} can add hours from their own profile, or change the assignment on the Schedule tab.`}
                </div>
              </div>
            )}
            {counts.w9Missing && (
              <div className="text-[13px]">
                <b className="font-semibold">{self ? "Your W-9 isn’t on file." : `${first}’s W-9 isn’t on file.`}</b> It’s a required document.
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {n > 0 && (
              <button type="button" onClick={() => goTo("schedule")} className={`${btn} bg-charcoal text-white hover:bg-charcoal-hover`}>
                Review schedule
              </button>
            )}
            {counts.w9Missing && (
              <button type="button" onClick={() => goTo("documents")} className={`${btn} border bg-surface text-text-primary hover:bg-app-bg`} style={{ borderColor: "var(--color-warn-border)" }}>
                Documents
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.55fr_1fr]">
        {/* ── Left ────────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-4">
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-x-3">
              <h2 className={h2}>This week</h2>
              <span className="flex items-center gap-3.5">
                <span className="text-[12px] text-text-muted">
                  {monthDay(days[0])} – {monthDay(days[6])}
                </span>
                <button type="button" onClick={() => goTo("schedule")} className={cardLink}>
                  Schedule &amp; availability →
                </button>
              </span>
            </div>
            {weekError ? (
              <p className="mt-3 text-[13px] text-text-muted">Couldn't load this week.</p>
            ) : !me ? (
              <p className="mt-3 text-[13px] text-text-muted">Loading…</p>
            ) : (
              <>
                <ul className="mt-2">
                  {days.map((d, i) => {
                    const band = fit.days[i];
                    const dayItems = items.filter((it) => it.date === d);
                    const bad = dayItems.some((it) => outsideKeys.has(it.key));
                    return (
                      <li key={d} className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-b py-2 last:border-b-0 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center" style={{ borderColor: "var(--color-hairline)" }}>
                        <div className={`text-[12px] ${d === today ? "font-semibold text-brand" : "text-text-muted"}`}>
                          {DOW[i]} <span className="block text-[13px] font-medium text-text-primary">{ymdToUtc(d).getUTCDate()}</span>
                        </div>
                        <div className="flex min-w-0 flex-wrap gap-1.5">
                          {dayItems.length === 0 ? (
                            <span className="text-[12.5px] text-text-muted">Off</span>
                          ) : (
                            dayItems.map((it) => {
                              const out = outsideKeys.has(it.key);
                              return (
                                <span
                                  key={it.key}
                                  className="min-w-0 max-w-full rounded-lg px-2 py-1 text-[13px] font-medium leading-snug"
                                  style={{ ...(out ? tint.warn : tint.pending), ...(out ? { boxShadow: "inset 0 0 0 1px var(--color-warn-border)" } : {}) }}
                                >
                                  <span className="block truncate">{it.name}</span>
                                  <small className="block text-[12px] font-normal">
                                    {range12h(it.startTime, it.endTime)}
                                    {out && " · outside hours"}
                                  </small>
                                </span>
                              );
                            })
                          )}
                        </div>
                        <span className="col-start-2 text-[12px] sm:col-start-auto sm:text-right" style={bad || band.kind === "time_off" || band.kind === "modified" ? { color: "var(--color-warn-text)" } : { color: "var(--color-muted)" }}>
                          {bandText(band)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 border-t pt-3 text-[12.5px] text-text-muted" style={{ borderColor: "var(--color-hairline)" }}>
                  {items.length} assignment{items.length === 1 ? "" : "s"} · {hoursText}
                  {nextOff &&
                    ` · next time off ${monthDay(nextOff.date)} (${nextOff.type === "UNAVAILABLE" ? "Unavailable" : "Modified hours"}${nextOff.note ? ` · ${nextOff.note}` : ""})`}
                </p>
              </>
            )}
          </section>

          <section className={card}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={h2}>Contact &amp; identity</h2>
              {(viewer.canEditRecord || self) && (
                <button type="button" onClick={() => goTo("profile")} className={cardLink}>
                  Edit
                </button>
              )}
            </div>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {[
                ["Name", `${staff.firstName} ${staff.lastName}`.trim()],
                ["Sign-in email", staff.email],
                ["Title", staff.title || "—"],
                ["Role", staff.role === "OWNER" ? "Owner" : "Staff"],
                ["Private phone", staff.phone || "—"],
                ["Portal phone", staff.publicPhone || "—"],
                ["Availability", me ? (availDays ? `${availDays} day${availDays === 1 ? "" : "s"} a week` : "No weekly hours set") : "—"],
                ["Time off", `${upcoming.length} upcoming`],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[12px] text-text-muted">{k}</dt>
                  <dd className="break-words text-[13.5px] text-text-primary">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border px-3 py-2.5" style={{ background: "var(--color-inset-surface)", borderColor: "var(--color-inset-border)" }}>
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
              <div className="min-w-0 text-[12.5px] text-text-muted">
                <div className="flex items-center gap-2.5">
                  <span>Password</span>
                  <span className="font-medium tracking-[0.18em] text-text-primary">••••••••</span>
                  <span className="rounded px-1.5 text-[12px] font-semibold uppercase tracking-wide" style={tint.chip}>Locked</span>
                </div>
                <p className="mt-1">
                  Password — <b className="font-medium text-text-primary">only the staff member can change this, from their own account.</b>
                  {!self && ` Owners never see or set it. Locked out? Send a setup link and ${first} picks a new one.`}
                </p>
              </div>
            </div>
          </section>

          <section className={card}>
            <h2 className={h2}>Recent activity</h2>
            {activity.length === 0 ? (
              <p className="mt-3 text-[13px] text-text-muted">No changes recorded yet.</p>
            ) : (
              <ul className="mt-2">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 border-b py-2 last:border-b-0" style={{ borderColor: "var(--color-hairline)" }}>
                    <span className="min-w-0 flex-1 text-[13px] text-text-primary">
                      {a.summary}
                      <span className="text-text-muted">
                        {" — by "}
                        {a.selfMade ? `${first} (own profile)` : a.actorName || "someone on staff"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[12px] text-text-muted">{relativeDay(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ── Right ───────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-4">
          <section className={card}>
            <h2 className={h2}>Account &amp; security</h2>
            <dl className="mt-2 text-[13px]">
              {[
                [
                  "Staff login",
                  <span key="l" className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: staff.invitePending ? "var(--color-pending-text)" : "var(--color-success-icon)" }} aria-hidden />
                    {staff.invitePending ? "Invited — setup link not used yet" : "Set up"}
                  </span>,
                ],
                ["Signs in with", staff.email],
                ["Last login", staff.lastLoginAt ? relativeDay(staff.lastLoginAt) : "Never"],
                ["Password", "Never visible to staff or owners"],
              ].map(([k, v], i) => (
                <div key={i} className="flex items-start justify-between gap-3 border-b py-2 last:border-b-0" style={{ borderColor: "var(--color-hairline)" }}>
                  <dt className="shrink-0 text-text-muted">{k}</dt>
                  <dd className="min-w-0 break-words text-right text-text-primary">{v}</dd>
                </div>
              ))}
            </dl>
            {viewer.canEditRecord && (
              <div className="mt-3 rounded-lg border px-3 py-3" style={{ background: "var(--color-info-surface)", borderColor: "var(--color-info-border)" }}>
                <div className="text-[13px] font-medium text-text-primary">Setup link</div>
                <p className="mb-2.5 mt-0.5 text-[12.5px] text-text-muted">
                  For first sign-in or a forgotten password. Goes to <b className="font-medium text-text-primary">{staff.email}</b>, works once, and is logged against your name.
                </p>
                <button type="button" onClick={sendSetupLink} disabled={sending} className={`${btn} border border-brand bg-surface text-brand hover:bg-brand/5`}>
                  {sending ? "Sending…" : "Send setup link"}
                </button>
                {setupNotice && (
                  <p role="status" className="mt-2 text-[12.5px] text-text-primary">
                    {setupNotice}
                  </p>
                )}
              </div>
            )}
          </section>

          {viewer.canViewPay && (
            <section className={card}>
              <div className="flex items-center justify-between gap-3">
                <h2 className={h2}>Pay</h2>
                <button type="button" onClick={() => goTo("pay")} className={cardLink}>
                  Pay tab
                </button>
              </div>
              {plan === undefined ? (
                <p className="mt-2 text-[13px] text-text-muted">Loading…</p>
              ) : plan === null ? (
                <p className="mt-2 text-[13px] text-text-muted">No pay plan set yet.</p>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap items-baseline gap-2">
                    <span className="text-[22px] font-semibold tracking-[-0.01em] text-text-primary">{money(plan.baseAmount)}</span>
                    <span className="text-[12px] text-text-muted">{BASE_UNIT[plan.baseType] ?? ""}</span>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-text-muted">
                    {BASE_LABEL[plan.baseType] ?? plan.baseType}
                    {" · "}
                    {plan.bonuses.length === 0
                      ? "no bonuses set"
                      : plan.bonuses
                          .map((b) => `${BONUS_LABEL[b.bonusType] ?? b.bonusType} ${b.bonusType === "REVENUE_SHARE" ? `${b.amount}%` : money(b.amount)}`)
                          .join(" · ")}
                  </p>
                </>
              )}
              {!self && (
                <div className="mt-1.5 flex gap-4">
                  <Link href="/dashboard/staff/payroll" className={cardLink}>
                    Payroll →
                  </Link>
                  <Link href="/dashboard/staff/payouts" className={cardLink}>
                    Payouts →
                  </Link>
                </div>
              )}
            </section>
          )}

          {viewer.canSeeAccess !== false && (
          <section className={card}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={h2}>Access</h2>
              {!viewer.targetIsOwner && (
                <button type="button" onClick={() => goTo("access")} className={cardLink}>
                  {viewer.canEditAccess ? "Change" : "View"}
                </button>
              )}
            </div>
            {viewer.targetIsOwner ? (
              <p className="mt-2 inline-flex rounded-full px-2.5 py-1 text-[12.5px] font-medium" style={tint.ok}>
                Full access (owner)
              </p>
            ) : (
              <>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {PERMISSION_CATALOG.filter((a) => staff.permissions[a.key] && staff.permissions[a.key] !== "none").map((a) => {
                    const lvl = staff.permissions[a.key];
                    const s = levelStyle(lvl);
                    return (
                      <span key={a.key} className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${s.className ?? ""}`} style={s.style}>
                        {a.label}: {lvl}
                      </span>
                    );
                  })}
                </div>
                {PERMISSION_CATALOG.some((a) => (staff.permissions[a.key] ?? "none") === "none") && (
                  <p className="mt-2 text-[12px] text-text-muted">
                    No access:{" "}
                    {PERMISSION_CATALOG.filter((a) => (staff.permissions[a.key] ?? "none") === "none")
                      .map((a) => a.label)
                      .join(", ")}
                  </p>
                )}
              </>
            )}
          </section>
          )}

          <section className={card}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={h2}>Private lessons</h2>
              <button type="button" onClick={() => goTo("lessons")} className={cardLink}>
                Lessons
              </button>
            </div>
            <p className="mt-1 text-[13px] text-text-muted">
              {counts.lessons === 0 ? "Not set up for any lesson types yet." : `Coaches ${counts.lessons} lesson type${counts.lessons === 1 ? "" : "s"}.`}
            </p>
          </section>

          <section className={card}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={h2}>Documents</h2>
              {counts.w9Missing && (
                <span className="text-[12px] font-medium" style={{ color: "var(--color-danger-text)" }}>
                  1 missing
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 border-b py-2 text-[13px]" style={{ borderColor: "var(--color-hairline)" }}>
              <span className="text-text-primary">On file</span>
              <span className="text-text-muted">{counts.documents}</span>
            </div>
            {!viewer.targetIsOwner && (
              <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
                <span className="text-text-primary">W-9</span>
                {counts.w9Missing ? (
                  <button type="button" onClick={() => goTo("documents")} className="inline-flex min-h-[44px] items-center font-medium md:min-h-0" style={{ color: "var(--color-danger-text)" }}>
                    Missing — open Documents
                  </button>
                ) : (
                  <span style={{ color: "var(--color-success-text)" }}>On file</span>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
