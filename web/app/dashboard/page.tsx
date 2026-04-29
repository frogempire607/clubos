"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

type Stats = {
  memberCount: number;
  upcomingEventCount: number;
  revenue: number;
  activeMembers: number;
  todayEventCount: number;
  monthRevenue: number;
};

const sections = [
  { label: "Members", icon: "◉", href: "/dashboard/members", desc: "Manage your club roster" },
  { label: "Events", icon: "◈", href: "/dashboard/events", desc: "Classes, privates, tournaments" },
  { label: "Memberships", icon: "◇", href: "/dashboard/memberships", desc: "Plans and billing options" },
  { label: "Calendar", icon: "▦", href: "/dashboard/calendar", desc: "Monthly event view" },
  { label: "Messages", icon: "✉", href: "/dashboard/messages", desc: "Announce to your members" },
  { label: "Financials", icon: "$", href: "/dashboard/financials", desc: "Revenue and transactions" },
  { label: "Custom fields", icon: "▤", href: "/dashboard/custom-fields", desc: "Extra member data fields" },
  { label: "Settings", icon: "⚙", href: "/dashboard/settings", desc: "Billing, Stripe, club info" },
];

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export default function DashboardPage() {
  const { data: session } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentMembers, setRecentMembers] = useState<any[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<any[]>([]);
  const [allEvents, setAllEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  useEffect(() => {
    async function load() {
      const [mRes, eRes, txRes] = await Promise.all([
        fetch("/api/members"),
        fetch("/api/events"),
        fetch("/api/transactions"),
      ]);
      const members = mRes.ok ? await mRes.json() : [];
      const events = eRes.ok ? await eRes.json() : [];
      const txData = txRes.ok ? await txRes.json() : { totals: { revenue: 0 } };

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(todayStart.getTime() + 86400000);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const upcoming = events.filter((e: any) => new Date(e.startsAt) >= now);
      const todayEvents = events.filter(
        (e: any) => new Date(e.startsAt) >= todayStart && new Date(e.startsAt) < todayEnd
      );

      const transactions = txData.transactions || [];
      const monthRevenue = transactions
        .filter((t: any) => t.status === "SUCCEEDED" && new Date(t.createdAt) >= monthStart)
        .reduce((sum: number, t: any) => sum + Number(t.amount), 0);

      setRecentMembers(members.slice(0, 5));
      setUpcomingEvents(upcoming.slice(0, 5));
      setAllEvents(events);
      setStats({
        memberCount: members.length,
        upcomingEventCount: upcoming.length,
        revenue: txData.totals?.revenue || 0,
        activeMembers: members.filter((m: any) => m.status === "ACTIVE").length,
        todayEventCount: todayEvents.length,
        monthRevenue,
      });
      setLoading(false);
    }
    load();
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = session?.user?.name?.split(" ")[0] || "";

  // Mini calendar helpers
  const { year, month } = calMonth;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  const eventDays = new Set(
    allEvents
      .filter((e) => {
        const d = new Date(e.startsAt);
        return d.getFullYear() === year && d.getMonth() === month;
      })
      .map((e) => new Date(e.startsAt).getDate())
  );

  const selectedDayEvents = selectedDay
    ? allEvents.filter((e) => {
        const d = new Date(e.startsAt);
        return d.getFullYear() === year && d.getMonth() === month && d.getDate() === selectedDay;
      })
    : [];

  function prevMonth() {
    setCalMonth(({ year, month }) =>
      month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }
    );
    setSelectedDay(null);
  }
  function nextMonth() {
    setCalMonth(({ year, month }) =>
      month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }
    );
    setSelectedDay(null);
  }

  const cells = Array.from({ length: firstDay + daysInMonth }, (_, i) => i < firstDay ? null : i - firstDay + 1);

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-stone-900">
          {greeting}{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-sm text-stone-500 mt-1">Here's what's happening at your club today.</p>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Active members" value={loading ? "—" : String(stats?.activeMembers ?? 0)} sub={loading ? "" : `of ${stats?.memberCount ?? 0} total`} href="/dashboard/members" accent="#1D9E75" />
        <StatCard label="Today's events" value={loading ? "—" : String(stats?.todayEventCount ?? 0)} sub="scheduled today" href="/dashboard/events" accent="#534AB7" />
        <StatCard label="This month" value={loading ? "—" : `$${Number(stats?.monthRevenue ?? 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} sub="revenue" href="/dashboard/financials" accent="#BA7517" />
        <StatCard label="Upcoming events" value={loading ? "—" : String(stats?.upcomingEventCount ?? 0)} sub="total ahead" href="/dashboard/events" accent="#0C447C" />
      </div>

      {/* Middle row: calendar + quick nav */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {/* Mini calendar */}
        <div className="col-span-1 bg-white rounded-xl border border-stone-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <button onClick={prevMonth} className="text-stone-400 hover:text-stone-700 w-6 h-6 flex items-center justify-center rounded hover:bg-stone-100">‹</button>
            <span className="text-sm font-semibold text-stone-900">{MONTHS[month]} {year}</span>
            <button onClick={nextMonth} className="text-stone-400 hover:text-stone-700 w-6 h-6 flex items-center justify-center rounded hover:bg-stone-100">›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[10px] font-medium text-stone-400 py-0.5">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) => {
              if (!day) return <div key={i} />;
              const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
              const hasEvents = eventDays.has(day);
              const isSelected = selectedDay === day;
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDay(isSelected ? null : day)}
                  className={`relative flex flex-col items-center justify-center rounded text-xs py-1 transition
                    ${isSelected ? "bg-stone-900 text-white" : isToday ? "bg-stone-100 text-stone-900 font-semibold" : "text-stone-700 hover:bg-stone-50"}`}
                >
                  {day}
                  {hasEvents && !isSelected && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-violet-500" />
                  )}
                </button>
              );
            })}
          </div>

          {selectedDay && (
            <div className="mt-3 border-t border-stone-100 pt-3">
              {selectedDayEvents.length === 0 ? (
                <p className="text-xs text-stone-400 text-center">No events on {MONTHS[month]} {selectedDay}</p>
              ) : (
                <div className="space-y-1">
                  {selectedDayEvents.map((e) => (
                    <div key={e.id} className="text-xs text-stone-700 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
                      <span className="truncate">{e.name}</span>
                      <span className="text-stone-400 flex-shrink-0 ml-auto">
                        {new Date(e.startsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Navigate quick links */}
        <div className="col-span-2 grid grid-cols-4 gap-3 content-start">
          {sections.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm hover:border-stone-300 transition group"
            >
              <div className="text-xl mb-2 text-stone-400 group-hover:text-stone-700 transition">{s.icon}</div>
              <div className="text-sm font-semibold text-stone-900 mb-0.5">{s.label}</div>
              <div className="text-xs text-stone-500">{s.desc}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* Bottom: recent members + upcoming events */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-stone-200">
          <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Recent members</h2>
            <Link href="/dashboard/members" className="text-xs text-stone-500 hover:text-stone-900">View all →</Link>
          </div>
          {loading ? (
            <div className="p-6 text-sm text-stone-400 text-center">Loading…</div>
          ) : recentMembers.length === 0 ? (
            <div className="p-6 text-sm text-stone-400 text-center">No members yet.</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {recentMembers.map((m) => {
                const statusColor: Record<string, string> = { ACTIVE: "#27500A", PROSPECT: "#0C447C", INACTIVE: "#5F5E5A", PAUSED: "#633806" };
                const statusBg: Record<string, string> = { ACTIVE: "#EAF3DE", PROSPECT: "#E6F1FB", INACTIVE: "#F1EFE8", PAUSED: "#FAEEDA" };
                return (
                  <div key={m.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-8 h-8 rounded-full bg-stone-200 flex items-center justify-center text-xs font-medium text-stone-700 flex-shrink-0">
                      {m.firstName[0]}{m.lastName[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-stone-900 truncate">{m.firstName} {m.lastName}</div>
                      <div className="text-xs text-stone-500">{new Date(m.joinedAt).toLocaleDateString()}{m.isMinor ? " · Minor" : ""}</div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0" style={{ background: statusBg[m.status] || "#F1EFE8", color: statusColor[m.status] || "#5F5E5A" }}>
                      {m.status.charAt(0) + m.status.slice(1).toLowerCase()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-stone-200">
          <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Upcoming events</h2>
            <Link href="/dashboard/events" className="text-xs text-stone-500 hover:text-stone-900">View all →</Link>
          </div>
          {loading ? (
            <div className="p-6 text-sm text-stone-400 text-center">Loading…</div>
          ) : upcomingEvents.length === 0 ? (
            <div className="p-6 text-sm text-stone-400 text-center">No upcoming events.</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {upcomingEvents.map((e) => {
                const start = new Date(e.startsAt);
                const typeName = e.customEventType?.name || e.type.charAt(0) + e.type.slice(1).toLowerCase();
                const typeBg = e.customEventType?.color || "#F1EFE8";
                const typeFg = e.customEventType?.textColor || "#5F5E5A";
                return (
                  <div key={e.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-10 text-center bg-stone-50 rounded-lg py-1.5 flex-shrink-0">
                      <div className="text-[9px] uppercase font-medium text-stone-500">{start.toLocaleString("en-US", { month: "short" })}</div>
                      <div className="text-base font-semibold text-stone-900 leading-tight">{start.getDate()}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-stone-900 truncate">{e.name}</div>
                      <div className="text-xs text-stone-500">{start.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0" style={{ background: typeBg, color: typeFg }}>
                      {typeName}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, href, accent }: { label: string; value: string; sub: string; href: string; accent: string }) {
  return (
    <Link href={href} className="bg-white rounded-xl border border-stone-200 p-5 hover:shadow-sm hover:border-stone-300 transition group">
      <div className="flex items-start justify-between mb-3">
        <div className="text-xs text-stone-500 uppercase tracking-wider">{label}</div>
        <div className="w-2 h-2 rounded-full mt-0.5" style={{ background: accent }} />
      </div>
      <div className="text-3xl font-semibold text-stone-900 mb-1">{value}</div>
      <div className="text-xs text-stone-400">{sub}</div>
    </Link>
  );
}
