"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import type { WidgetDef, WidgetPrefs } from "@/lib/dashboardWidgets";
import { fmtTime, kindIsWallClockUTC, dayNumber, sameMonth } from "@/lib/datetime";

type CalItem = { kind: string; id: string; name: string; startsAt: string };

const sections = [
  { label: "Members", icon: "◉", href: "/dashboard/members", desc: "Manage your club roster" },
  { label: "Classes", icon: "◈", href: "/dashboard/classes", desc: "Recurring weekly programming" },
  { label: "Events", icon: "◈", href: "/dashboard/events", desc: "Clinics, camps, tournaments" },
  { label: "Memberships", icon: "◇", href: "/dashboard/purchase-options/memberships", desc: "Plans and billing options" },
  { label: "Privates", icon: "◎", href: "/dashboard/purchase-options/privates", desc: "Lessons and credit packages" },
  { label: "Products", icon: "□", href: "/dashboard/purchase-options/products", desc: "Gear, services, rentals" },
  { label: "Calendar", icon: "▦", href: "/dashboard/calendar", desc: "Monthly event view" },
  { label: "Messages", icon: "✉", href: "/dashboard/messages", desc: "Announce to your members" },
  { label: "Financials", icon: "$", href: "/dashboard/financials", desc: "Revenue and transactions" },
  { label: "Documents", icon: "□", href: "/dashboard/documents", desc: "Waivers and forms" },
  { label: "Settings", icon: "⚙", href: "/dashboard/settings", desc: "Billing, Stripe, club info" },
];

// Primary daily actions — rendered as a persistent CTA bar above the
// stats grid. Order matters: most common (Add member, New class) first.
// Secondary actions stay in the widget grid via the `quickActions`
// widget for owners who want them.
const PRIMARY_QUICK_ACTIONS = [
  { label: "Add member", href: "/dashboard/members", icon: "◉", primary: true },
  { label: "New class", href: "/dashboard/classes", icon: "◈", primary: false },
  { label: "New event", href: "/dashboard/events", icon: "◈", primary: false },
  { label: "Send message", href: "/dashboard/messages", icon: "✉", primary: false },
  { label: "Client view", href: "/dashboard/preview", icon: "◐", primary: false },
];

const QUICK_ACTIONS = [
  { label: "Add member", href: "/dashboard/members" },
  { label: "New event", href: "/dashboard/events" },
  { label: "New class", href: "/dashboard/classes" },
  { label: "Send message", href: "/dashboard/messages" },
  { label: "Record payment", href: "/dashboard/financials" },
  { label: "Add document", href: "/dashboard/documents" },
];

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

type Summary = {
  activeMembers: number;
  totalMembers: number;
  newMembers: number;
  revenueMonth: number;
  netIncome: number;
  attendanceMonth: number;
  failedPayments: number;
  unreadMessages: number;
  pendingPayments: { count: number; total: number };
  docsNeedingSignatures: number;
  upcomingEvents: number;
  todayEvents: number;
  upcomingClasses: { id: string; name: string; startsAt: string }[];
  setup: { items: { key: string; label: string; done: boolean }[]; done: number; total: number };
};

const SECTION_SPAN: Record<string, string> = {
  quickNav: "col-span-2",
  setupProgress: "col-span-2",
};

export default function DashboardPage() {
  const { data: session } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recentMembers, setRecentMembers] = useState<any[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<any[]>([]);
  const [allEvents, setAllEvents] = useState<any[]>([]);
  const [calItems, setCalItems] = useState<CalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<WidgetPrefs | null>(null);
  const [catalog, setCatalog] = useState<WidgetDef[]>([]);
  const [customizing, setCustomizing] = useState(false);

  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // Initial load of everything EXCEPT the calendar feed (that has its own
  // month-aware effect below).
  useEffect(() => {
    async function load() {
      const [mRes, eRes, sRes, wRes] = await Promise.all([
        fetch("/api/members"),
        fetch("/api/events"),
        fetch("/api/dashboard/summary"),
        fetch("/api/dashboard/widgets"),
      ]);
      const members = mRes.ok ? await mRes.json() : [];
      const events = eRes.ok ? await eRes.json() : [];
      const now = new Date();
      const upcoming = events.filter((e: any) => new Date(e.startsAt) >= now);

      setRecentMembers(members.slice(0, 5));
      setUpcomingEvents(upcoming.slice(0, 5));
      setAllEvents(events);
      if (sRes.ok) setSummary(await sRes.json());
      if (wRes.ok) {
        const w = await wRes.json();
        setPrefs(w.prefs);
        setCatalog(w.catalog);
      }
      setLoading(false);
    }
    load();
  }, []);

  // Refetch the calendar feed whenever the mini-calendar's visible month
  // changes — without this, navigating prev/next on the dashboard mini
  // calendar showed nothing for months outside the initial ±1-month window.
  useEffect(() => {
    const { year, month } = calMonth;
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month + 2, 0, 23, 59, 59, 999);
    fetch(`/api/calendar?from=${start.toISOString()}&to=${end.toISOString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cd) => {
        if (cd && Array.isArray(cd.items)) setCalItems(cd.items);
      })
      .catch(() => {});
  }, [calMonth]);

  const savePrefs = useCallback(async (next: WidgetPrefs) => {
    setPrefs(next);
    await fetch("/api/dashboard/widgets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = session?.user?.name?.split(" ")[0] || "";

  const { year, month } = calMonth;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  // Mini-calendar reflects the full schedule (events + classes + privates),
  // kind-aware so class wall-clock times land on the right day.
  const eventDays = new Set(
    calItems
      .filter((e) => sameMonth(e.startsAt, year, month, kindIsWallClockUTC(e.kind)))
      .map((e) => dayNumber(e.startsAt, kindIsWallClockUTC(e.kind))),
  );
  const selectedDayEvents = selectedDay
    ? calItems.filter(
        (e) =>
          sameMonth(e.startsAt, year, month, kindIsWallClockUTC(e.kind)) &&
          dayNumber(e.startsAt, kindIsWallClockUTC(e.kind)) === selectedDay,
      )
    : [];
  function prevMonth() {
    setCalMonth(({ year, month }) => (month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }));
    setSelectedDay(null);
  }
  function nextMonth() {
    setCalMonth(({ year, month }) => (month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }));
    setSelectedDay(null);
  }
  const cells = Array.from({ length: firstDay + daysInMonth }, (_, i) => (i < firstDay ? null : i - firstDay + 1));

  const fmtMoney = (n: number) =>
    `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  function statWidget(key: string): React.ReactNode {
    const s = summary;
    const v = (x: string | number) => (loading || !s ? "—" : String(x));
    switch (key) {
      case "activeMembers":
        return <StatCard key={key} label="Active members" value={v(s?.activeMembers ?? 0)} sub={s ? `of ${s.totalMembers} total` : ""} href="/dashboard/members" accent="var(--color-success)" />;
      case "newMembers":
        return <StatCard key={key} label="New members" value={v(s?.newMembers ?? 0)} sub="joined this month" href="/dashboard/members" accent="var(--color-success)" />;
      case "revenueMonth":
        return <StatCard key={key} label="Revenue" value={loading || !s ? "—" : fmtMoney(s.revenueMonth)} sub="this month" href="/dashboard/financials" accent="var(--color-warning)" />;
      case "netIncome":
        return <StatCard key={key} label="Net income" value={loading || !s ? "—" : fmtMoney(s.netIncome)} sub="revenue − expenses" href="/dashboard/financials" accent="var(--color-warning)" />;
      case "todayEvents":
        return <StatCard key={key} label="Today's events" value={v(s?.todayEvents ?? 0)} sub="scheduled today" href="/dashboard/events" accent="var(--color-primary)" />;
      case "upcomingEvents":
        return <StatCard key={key} label="Upcoming events" value={v(s?.upcomingEvents ?? 0)} sub="total ahead" href="/dashboard/events" accent="var(--color-primary)" />;
      case "attendanceMonth":
        return <StatCard key={key} label="Attendance" value={v(s?.attendanceMonth ?? 0)} sub="check-ins this month" href="/dashboard/attendance" accent="var(--color-primary)" />;
      case "pendingPayments":
        return <StatCard key={key} label="Pending payments" value={v(s?.pendingPayments.count ?? 0)} sub={s && s.pendingPayments.total > 0 ? `${fmtMoney(s.pendingPayments.total)} owed` : "registrants owing"} href="/dashboard/events" accent="var(--color-warning)" />;
      case "failedPayments":
        return <StatCard key={key} label="Failed payments" value={v(s?.failedPayments ?? 0)} sub="this month" href="/dashboard/financials" accent="#dc2626" />;
      case "unreadMessages":
        return <StatCard key={key} label="Unread messages" value={v(s?.unreadMessages ?? 0)} sub="direct messages" href="/dashboard/messages" accent="var(--color-primary)" />;
      case "docsNeedingSignatures":
        return <StatCard key={key} label="Docs needing signatures" value={v(s?.docsNeedingSignatures ?? 0)} sub="outstanding" href="/dashboard/documents" accent="var(--color-warning)" />;
      default:
        return null;
    }
  }

  function sectionWidget(key: string): React.ReactNode {
    switch (key) {
      case "calendar":
        return (
          <div key={key} className="bg-surface rounded-xl border border-app-border p-4">
            <div className="flex items-center justify-between mb-3">
              <button onClick={prevMonth} className="text-text-muted hover:text-text-primary w-6 h-6 flex items-center justify-center rounded hover:bg-app-bg">‹</button>
              <span className="text-sm font-semibold text-text-primary">{MONTHS[month]} {year}</span>
              <button onClick={nextMonth} className="text-text-muted hover:text-text-primary w-6 h-6 flex items-center justify-center rounded hover:bg-app-bg">›</button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {DAYS.map((d) => <div key={d} className="text-center text-[10px] font-medium text-text-muted py-0.5">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((day, i) => {
                if (!day) return <div key={i} />;
                const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                const hasEvents = eventDays.has(day);
                const isSelected = selectedDay === day;
                return (
                  <button key={i} onClick={() => setSelectedDay(isSelected ? null : day)}
                    className={`relative flex flex-col items-center justify-center rounded text-xs py-1 transition ${isSelected ? "bg-brand text-white" : isToday ? "bg-app-bg text-text-primary font-semibold" : "text-text-primary hover:bg-app-bg"}`}>
                    {day}
                    {hasEvents && !isSelected && <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-brand" />}
                  </button>
                );
              })}
            </div>
            {selectedDay && (
              <div className="mt-3 border-t border-app-border pt-3">
                {selectedDayEvents.length === 0 ? (
                  <p className="text-xs text-text-muted text-center">No events on {MONTHS[month]} {selectedDay}</p>
                ) : (
                  <div className="space-y-1">
                    {selectedDayEvents.map((e) => (
                      <div key={e.id} className="text-xs text-text-primary flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-brand flex-shrink-0" />
                        <span className="truncate">{e.name}</span>
                        <span className="text-text-muted flex-shrink-0 ml-auto">{fmtTime(e.startsAt, { utc: kindIsWallClockUTC(e.kind) })}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      case "quickNav":
        return (
          <div key={key} className="grid grid-cols-4 gap-3 content-start">
            {sections.map((sx) => (
              <Link key={sx.href} href={sx.href} className="bg-surface rounded-xl border border-app-border p-4 hover:shadow-sm transition group">
                <div className="text-xl mb-2 text-text-muted group-hover:text-text-primary transition">{sx.icon}</div>
                <div className="text-sm font-semibold text-text-primary mb-0.5">{sx.label}</div>
                <div className="text-xs text-text-muted">{sx.desc}</div>
              </Link>
            ))}
          </div>
        );
      case "quickActions":
        return (
          <div key={key} className="bg-surface rounded-xl border border-app-border p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Quick actions</h2>
            <div className="grid grid-cols-2 gap-2">
              {QUICK_ACTIONS.map((a) => (
                <Link key={a.href + a.label} href={a.href} className="text-sm text-text-primary border border-app-border rounded-lg px-3 py-2 hover:bg-app-bg transition text-center">
                  {a.label}
                </Link>
              ))}
            </div>
          </div>
        );
      case "recentMembers":
        return (
          <div key={key} className="bg-surface rounded-xl border border-app-border">
            <div className="px-5 py-3 border-b border-app-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">Recent members</h2>
              <Link href="/dashboard/members" className="text-xs text-text-muted hover:text-text-primary">View all →</Link>
            </div>
            {loading ? (
              <div className="p-6 text-sm text-text-muted text-center">Loading…</div>
            ) : recentMembers.length === 0 ? (
              <div className="p-6 text-sm text-text-muted text-center">No members yet.</div>
            ) : (
              <div className="divide-y divide-app-border">
                {recentMembers.map((m) => {
                  const statusColor: Record<string, string> = { ACTIVE: "#1F1F23", PROSPECT: "#fff", INACTIVE: "var(--color-muted)", PAUSED: "#fff" };
                  const statusBg: Record<string, string> = { ACTIVE: "var(--color-success)", PROSPECT: "var(--color-primary)", INACTIVE: "var(--color-bg)", PAUSED: "var(--color-warning)" };
                  return (
                    <div key={m.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="w-8 h-8 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary flex-shrink-0">{m.firstName[0]}{m.lastName[0]}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{m.firstName} {m.lastName}</div>
                        <div className="text-xs text-text-muted">{new Date(m.joinedAt).toLocaleDateString()}{m.isMinor ? " · Minor" : ""}</div>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0" style={{ background: statusBg[m.status] || "var(--color-bg)", color: statusColor[m.status] || "var(--color-muted)" }}>
                        {m.status.charAt(0) + m.status.slice(1).toLowerCase()}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      case "upcomingEventsList":
        return (
          <div key={key} className="bg-surface rounded-xl border border-app-border">
            <div className="px-5 py-3 border-b border-app-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">Upcoming events</h2>
              <Link href="/dashboard/events" className="text-xs text-text-muted hover:text-text-primary">View all →</Link>
            </div>
            {loading ? (
              <div className="p-6 text-sm text-text-muted text-center">Loading…</div>
            ) : upcomingEvents.length === 0 ? (
              <div className="p-6 text-sm text-text-muted text-center">No upcoming events.</div>
            ) : (
              <div className="divide-y divide-app-border">
                {upcomingEvents.map((e) => {
                  const start = new Date(e.startsAt);
                  const typeName = e.customEventType?.name || e.type.charAt(0) + e.type.slice(1).toLowerCase();
                  const typeBg = e.customEventType?.color || "var(--color-bg)";
                  const typeFg = e.customEventType?.textColor || "var(--color-muted)";
                  return (
                    <div key={e.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="w-10 text-center bg-app-bg rounded-lg py-1.5 flex-shrink-0">
                        <div className="text-[9px] uppercase font-medium text-text-muted">{start.toLocaleString("en-US", { month: "short" })}</div>
                        <div className="text-base font-semibold text-text-primary leading-tight">{start.getDate()}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{e.name}</div>
                        <div className="text-xs text-text-muted">{start.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0" style={{ background: typeBg, color: typeFg }}>{typeName}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      case "upcomingClassesList":
        return (
          <div key={key} className="bg-surface rounded-xl border border-app-border">
            <div className="px-5 py-3 border-b border-app-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">Upcoming classes</h2>
              <Link href="/dashboard/classes" className="text-xs text-text-muted hover:text-text-primary">View all →</Link>
            </div>
            {loading ? (
              <div className="p-6 text-sm text-text-muted text-center">Loading…</div>
            ) : !summary || summary.upcomingClasses.length === 0 ? (
              <div className="p-6 text-sm text-text-muted text-center">No upcoming class sessions.</div>
            ) : (
              <div className="divide-y divide-app-border">
                {summary.upcomingClasses.map((c) => {
                  const start = new Date(c.startsAt);
                  return (
                    <div key={c.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="w-10 text-center bg-app-bg rounded-lg py-1.5 flex-shrink-0">
                        <div className="text-[9px] uppercase font-medium text-text-muted">{start.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}</div>
                        <div className="text-base font-semibold text-text-primary leading-tight">{start.getUTCDate()}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{c.name}</div>
                        <div className="text-xs text-text-muted">{start.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "UTC" })}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      case "setupProgress": {
        const setup = summary?.setup;
        const pct = setup ? Math.round((setup.done / setup.total) * 100) : 0;
        return (
          <div key={key} className="bg-surface rounded-xl border border-app-border p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-text-primary">Setup progress</h2>
              <span className="text-xs text-text-muted">{setup ? `${setup.done}/${setup.total}` : "—"}</span>
            </div>
            <div className="h-2 rounded-full bg-app-bg overflow-hidden mb-4">
              <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(setup?.items ?? []).map((it) => (
                <div key={it.key} className="flex items-center gap-2 text-sm">
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 ${it.done ? "bg-lime-accent text-text-primary" : "bg-app-bg text-text-muted border border-app-border"}`}>
                    {it.done ? "✓" : ""}
                  </span>
                  <span className={it.done ? "text-text-muted line-through" : "text-text-primary"}>{it.label}</span>
                </div>
              ))}
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  }

  const order = prefs?.order ?? [];
  const hidden = new Set(prefs?.hidden ?? []);
  const isStat = (k: string) => catalog.find((c) => c.key === k)?.kind === "stat";
  const visible = order.filter((k) => !hidden.has(k));
  const visibleStats = visible.filter((k) => isStat(k));
  const visibleSections = visible.filter((k) => !isStat(k));

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl">
      {/* Greeting + Customize. Stacks on mobile; row on sm+. */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold text-text-primary leading-tight tracking-tight">
            {greeting}{firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Here&apos;s what&apos;s happening at your club today.
          </p>
        </div>
        <button
          onClick={() => setCustomizing(true)}
          className="text-xs px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg transition self-start sm:self-auto sm:flex-shrink-0"
        >
          Customize
        </button>
      </div>

      {/* Primary quick-action bar — always rendered above the widget grid
          so owners can hit the daily actions without scrolling, even if
          they hid the quickActions widget. Horizontal scroll on mobile. */}
      <div className="mb-6 -mx-4 sm:mx-0 overflow-x-auto px-4 sm:px-0">
        <div className="flex items-stretch gap-2 sm:gap-3 sm:flex-wrap">
          {PRIMARY_QUICK_ACTIONS.map((a) => (
            <Link
              key={a.href + a.label}
              href={a.href}
              className={
                a.primary
                  ? "flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-semibold whitespace-nowrap bg-brand text-white hover:bg-brand-hover transition shrink-0"
                  : "flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-medium whitespace-nowrap bg-surface border border-app-border text-text-primary hover:bg-app-bg transition shrink-0"
              }
            >
              <span className="text-base leading-none opacity-90">{a.icon}</span>
              {a.label}
            </Link>
          ))}
        </div>
      </div>

      {visibleStats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
          {visibleStats.map((k) => statWidget(k))}
        </div>
      )}

      {visibleSections.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
          {visibleSections.map((k) => (
            <div key={k} className={SECTION_SPAN[k] ?? "col-span-1"}>
              {sectionWidget(k)}
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 && !loading && (
        <div className="bg-surface rounded-xl border border-app-border p-12 text-center">
          <p className="text-sm text-text-primary font-medium mb-1">Your dashboard is empty</p>
          <p className="text-xs text-text-muted mb-4">All widgets are hidden. Add some back to see your club at a glance.</p>
          <button onClick={() => setCustomizing(true)} className="text-xs px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover">Customize dashboard</button>
        </div>
      )}

      {customizing && prefs && (
        <CustomizeModal
          prefs={prefs}
          catalog={catalog}
          onClose={() => setCustomizing(false)}
          onSave={(next) => { savePrefs(next); setCustomizing(false); }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, sub, href, accent }: { label: string; value: string; sub: string; href: string; accent: string }) {
  return (
    <Link href={href} className="bg-surface rounded-xl border border-app-border p-4 sm:p-5 hover:shadow-sm transition group min-w-0">
      <div className="flex items-start justify-between mb-2 sm:mb-3 gap-2">
        <div className="text-[10px] sm:text-xs text-text-muted uppercase tracking-wider truncate">{label}</div>
        <div className="w-2 h-2 rounded-full mt-0.5 shrink-0" style={{ background: accent }} />
      </div>
      <div className="text-2xl sm:text-3xl font-semibold text-text-primary mb-1 leading-tight truncate">{value}</div>
      <div className="text-[11px] sm:text-xs text-text-muted truncate">{sub}</div>
    </Link>
  );
}

function CustomizeModal({
  prefs,
  catalog,
  onClose,
  onSave,
}: {
  prefs: WidgetPrefs;
  catalog: WidgetDef[];
  onClose: () => void;
  onSave: (p: WidgetPrefs) => void;
}) {
  // Working copy: ordered list of all keys with a visible flag.
  const allKeys = catalog.map((c) => c.key);
  const initialOrder = [
    ...prefs.order.filter((k) => allKeys.includes(k)),
    ...allKeys.filter((k) => !prefs.order.includes(k)),
  ];
  const [list, setList] = useState<string[]>(initialOrder);
  const [hidden, setHidden] = useState<Set<string>>(new Set(prefs.hidden));

  const meta = (k: string) => catalog.find((c) => c.key === k);

  function move(idx: number, dir: -1 | 1) {
    const next = [...list];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setList(next);
  }
  function toggle(k: string) {
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }
  function save() {
    onSave({ order: list, hidden: [...hidden] });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Customize dashboard</h2>
            <p className="text-xs text-text-muted">Show, hide, and reorder your widgets.</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-4 space-y-1">
          {list.map((k, idx) => {
            const m = meta(k);
            if (!m) return null;
            const isHidden = hidden.has(k);
            return (
              <div key={k} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${isHidden ? "border-app-border bg-app-bg/50" : "border-app-border bg-surface"}`}>
                <div className="flex flex-col">
                  <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-text-muted hover:text-text-primary disabled:opacity-30 leading-none text-xs">▲</button>
                  <button onClick={() => move(idx, 1)} disabled={idx === list.length - 1} className="text-text-muted hover:text-text-primary disabled:opacity-30 leading-none text-xs">▼</button>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">
                    {m.label}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-text-muted">{m.kind}</span>
                  </div>
                  <div className="text-xs text-text-muted truncate">{m.description}</div>
                </div>
                <button
                  onClick={() => toggle(k)}
                  className={`text-xs px-2.5 py-1 rounded-lg border flex-shrink-0 transition ${isHidden ? "border-app-border text-text-muted hover:bg-app-bg" : "border-brand bg-brand/10 text-brand"}`}
                >
                  {isHidden ? "Hidden" : "Shown"}
                </button>
              </div>
            );
          })}
        </div>
        <div className="px-6 py-4 border-t border-app-border flex justify-end gap-2 sticky bottom-0 bg-surface">
          <button onClick={onClose} className="text-sm px-4 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Cancel</button>
          <button onClick={save} className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover">Save layout</button>
        </div>
      </div>
    </div>
  );
}
