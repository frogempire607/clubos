import { notFound } from "next/navigation";
import { resolveFeedScope, feedItems, type FeedItem } from "@/lib/calendarFeed";
import { kindIsWallClockUTC, wallClockNowUTC } from "@/lib/datetime";

// Embeddable, auto-updating HTML calendar. Public but token-gated (same
// tokens as the ICS feed) — safe to iframe on a club's website. Server
// component: every load reflects the current schedule.
export const dynamic = "force-dynamic";

// Classes are wall-clock pinned to UTC, so render them in UTC to show their
// true time regardless of the (UTC) server timezone. Events/privates are true
// instants: with Club.timezone set they render in the club's local time (so a
// server-rendered embed matches the clock on the gym wall); without it they
// fall back to the server timezone (pre-timezone behavior).
function tzOpt(utc: boolean, clubTz: string | null): { timeZone?: string } {
  if (utc) return { timeZone: "UTC" };
  return clubTz ? { timeZone: clubTz } : {};
}

function dayKey(d: Date, utc: boolean, clubTz: string | null): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...tzOpt(utc, clubTz),
  });
}

function fmtTime(d: Date, utc: boolean, clubTz: string | null): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...tzOpt(utc, clubTz),
  });
}

export default async function EmbeddedCalendarPage(context: {
  params: Promise<{ clubId: string; token: string }>;
}) {
  const { clubId, token } = await context.params;
  const scope = resolveFeedScope(clubId, token);
  if (!scope) notFound();

  const data = await feedItems(clubId, scope);
  if (!data) notFound();

  // A bad stored timezone must degrade to the no-timezone rendering, never 500
  // a public embed.
  let clubTz: string | null = data.timezone;
  if (clubTz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: clubTz });
    } catch {
      clubTz = null;
    }
  }

  // Classes are wall-clock-UTC stamps, so they must be compared against the
  // club's wall clock (or a graced fallback), never raw UTC now — otherwise
  // today's classes drop off the embed hours before they start for any club
  // west of UTC. Events/privates are true instants and compare against now.
  const now = Date.now();
  const wallNow = wallClockNowUTC(clubTz).getTime();
  const upcoming = data.items
    .filter((i) => i.endsAt.getTime() >= (kindIsWallClockUTC(i.kind) ? wallNow : now))
    .slice(0, 200);
  const byDay = new Map<string, FeedItem[]>();
  for (const item of upcoming) {
    const key = dayKey(item.startsAt, kindIsWallClockUTC(item.kind), clubTz);
    const list = byDay.get(key) ?? [];
    list.push(item);
    byDay.set(key, list);
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 4px" }}>{data.clubName} — schedule</h1>
      <p style={{ fontSize: 12, color: "#78716c", margin: "0 0 16px" }}>
        {clubTz
          ? `Updates automatically. All times are in the club's local time (${clubTz.replace(/_/g, " ")}).`
          : "Updates automatically. Times shown in your device timezone may differ — see the club for details."}
      </p>
      {byDay.size === 0 && (
        <p style={{ fontSize: 14, color: "#57534e" }}>Nothing scheduled in the next few months.</p>
      )}
      {[...byDay.entries()].map(([day, items]) => (
        <section key={day} style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: "#57534e", margin: "0 0 6px" }}>{day}</h2>
          <div>
            {items.map((item) => (
              <div
                key={item.uid}
                style={{
                  border: "1px solid #e7e5e4",
                  borderRadius: 10,
                  padding: "8px 12px",
                  marginBottom: 6,
                  background: "#fff",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1c1917" }}>{item.title}</div>
                <div style={{ fontSize: 12, color: "#78716c" }}>
                  {fmtTime(item.startsAt, kindIsWallClockUTC(item.kind), clubTz)} – {fmtTime(item.endsAt, kindIsWallClockUTC(item.kind), clubTz)}
                  {item.location ? ` · ${item.location}` : ""}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
