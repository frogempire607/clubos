import { notFound } from "next/navigation";
import { resolveFeedScope, feedItems, type FeedItem } from "@/lib/calendarFeed";
import { kindIsWallClockUTC } from "@/lib/datetime";

// Embeddable, auto-updating HTML calendar. Public but token-gated (same
// tokens as the ICS feed) — safe to iframe on a club's website. Server
// component: every load reflects the current schedule.
export const dynamic = "force-dynamic";

function dayKey(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// Classes are wall-clock pinned to UTC, so render them in UTC to show their
// true time regardless of the (UTC) server timezone. Events/privates are true
// instants and render in the server timezone.
function fmtTime(d: Date, utc: boolean): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(utc ? { timeZone: "UTC" } : {}),
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

  const now = Date.now();
  const upcoming = data.items.filter((i) => i.endsAt.getTime() >= now).slice(0, 200);
  const byDay = new Map<string, FeedItem[]>();
  for (const item of upcoming) {
    const key = dayKey(item.startsAt);
    const list = byDay.get(key) ?? [];
    list.push(item);
    byDay.set(key, list);
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 4px" }}>{data.clubName} — schedule</h1>
      <p style={{ fontSize: 12, color: "#78716c", margin: "0 0 16px" }}>
        Updates automatically. Times shown in your device timezone may differ — see the club for details.
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
                  {fmtTime(item.startsAt, kindIsWallClockUTC(item.kind))} – {fmtTime(item.endsAt, kindIsWallClockUTC(item.kind))}
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
