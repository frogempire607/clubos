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
        <h1 className="text-3xl font-semibold text-text-primary">
          {greeting}{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-sm text-text-muted mt-1">Here's what's happening at your club today.</p>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Active members" value={loading ? "—" : String(stats?.activeMembers ?? 0)} sub={loading ? "" : `of ${stats?.memberCount ?? 0} total`} href="/dashboard/members" accent="var(--color-success)" />
        <StatCard label="Today's events" value={loading ? "—" : String(stats?.todayEventCount ?? 0)} sub="scheduled today" href="/dashboard/events" accent="var(--color-primary)" />
        <StatCard label="This month" value={loading ? "—" : `$${Number(stats?.monthRevenue ?? 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} sub="revenue" href="/dashboard/financials" accent="var(--color-warning)" />
        <StatCard label="Upcoming events" value={loading ? "—" : String(stats?.upcomingEventCount ?? 0)} sub="total ahead" href="/dashboard/events" accent="var(--color-primary)" />
      </div>

      {/* Middle row: calendar + quick nav */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {/* Mini calendar */}
        <div className="col-span-1 bg-surface rounded-xl border border-app-border p-4">
          <div className="flex items-center justify-between mb-3">
            <button onClick={prevMonth} className="text-text-muted hover:text-text-primary w-6 h-6 flex items-center justify-center rounded hover:bg-app-bg">‹</button>
            <span className="text-sm font-semibold text-text-primary">{MONTHS[month]} {year}</span>
            <button onClick={nextMonth} className="text-text-muted hover:text-text-primary w-6 h-6 flex items-center justify-center rounded hover:bg-app-bg">›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[10px] font-medium text-text-muted py-0.5">{d}</div>
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
                    ${isSelected ? "bg-brand text-white" : isToday ? "bg-app-bg text-text-primary font-semibold" : "text-text-primary hover:bg-app-bg"}`}
                >
                  {day}
                  {hasEvents && !isSelected && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-brand" />
                  )}
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
                      <span className="text-text-muted flex-shrink-0 ml-auto">
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
              className="bg-surface rounded-xl border border-app-border p-4 hover:shadow-sm hover:border-app-border transition group"
            >
              <div className="text-xl mb-2 text-text-muted group-hover:text-text-primary transition">{s.icon}</div>
              <div className="text-sm font-semibold text-text-primary mb-0.5">{s.label}</div>
              <div className="text-xs text-text-muted">{s.desc}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* Bottom: recent members + upcoming events */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-surface rounded-xl border border-app-border">
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
                const statusColor: Record<string, string> = { ACTIVE: "var(--color-text)", PROSPECT: "#fff", INACTIVE: "var(--color-muted)", PAUSED: "#fff" };
                const statusBg: Record<string, string> = { ACTIVE: "var(--color-success)", PROSPECT: "var(--color-primary)", INACTIVE: "var(--color-bg)", PAUSED: "var(--color-warning)" };
                return (
                  <div key={m.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-8 h-8 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary flex-shrink-0">
                      {m.firstName[0]}{m.lastName[0]}
                    </div>
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

        <div className="bg-surface rounded-xl border border-app-border">
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
    <Link href={href} className="bg-surface rounded-xl border border-app-border p-5 hover:shadow-sm hover:border-app-border transition group">
      <div className="flex items-start justify-between mb-3">
        <div className="text-xs text-text-muted uppercase tracking-wider">{label}</div>
        <div className="w-2 h-2 rounded-full mt-0.5" style={{ background: accent }} />
      </div>
      <div className="text-3xl font-semibold text-text-primary mb-1">{value}</div>
      <div className="text-xs text-text-muted">{sub}</div>
    </Link>
  );
}
