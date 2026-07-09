import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { wallClockUTCToInstant } from "@/lib/datetime";

// Auto-updating calendar feeds
// ----------------------------
// Three club-level feed scopes, each with its own unguessable URL:
//   PUBLIC — only PUBLIC classes/events (safe to embed on a public website)
//   MEMBER — PUBLIC + MEMBERS_ONLY (what the member portal schedule shows)
//   STAFF  — everything: + STAFF_ONLY events, PRIVATE classes, confirmed
//            private lessons (athlete names included — treat the link as
//            private).
// Tokens are stateless HMACs of (clubId, scope) keyed on NEXTAUTH_SECRET, so
// no schema change and no lookup: the feed route recomputes and compares.
// Rotation would need a per-club seed column — intentionally out of scope.

export type FeedScope = "PUBLIC" | "MEMBER" | "STAFF";
export const FEED_SCOPES: FeedScope[] = ["PUBLIC", "MEMBER", "STAFF"];

function feedSecret(): string {
  // NEXTAUTH_SECRET is required in every deployed environment already.
  return process.env.NEXTAUTH_SECRET || "dev-insecure-calendar-feed";
}

export function calendarFeedToken(clubId: string, scope: FeedScope): string {
  return crypto
    .createHmac("sha256", feedSecret())
    .update(`calfeed:${clubId}:${scope}`)
    .digest("hex")
    .slice(0, 40);
}

/** Constant-time token check; returns the matching scope or null. */
export function resolveFeedScope(clubId: string, token: string): FeedScope | null {
  for (const scope of FEED_SCOPES) {
    const expected = calendarFeedToken(clubId, scope);
    if (
      token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      return scope;
    }
  }
  return null;
}

export function feedUrls(clubId: string, scope: FeedScope) {
  const base = getAppBaseUrl();
  const token = calendarFeedToken(clubId, scope);
  const ics = `${base}/api/public/calendar/${clubId}/${token}`;
  const webcal = ics.replace(/^https?:\/\//, "webcal://");
  return {
    scope,
    ics,
    webcal,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    embed: `${base}/cal/${clubId}/${token}`,
  };
}

export type FeedItem = {
  uid: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  description?: string | null;
  location?: string | null;
  // "class" times are the owner's wall clock pinned to UTC; "event"/"private"
  // are true instants. Lets the HTML embed render class times in UTC (their
  // true wall clock) regardless of the server's timezone.
  kind: "class" | "event" | "private";
};

/** Fetch calendar items for a scope. Window: 30 days back, 180 forward. */
export async function feedItems(
  clubId: string,
  scope: FeedScope,
): Promise<{ clubName: string; timezone: string | null; items: FeedItem[] } | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true } });
  if (!club) return null;

  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86_400_000);
  const to = new Date(now.getTime() + 180 * 86_400_000);

  const eventVisibility =
    scope === "PUBLIC" ? ["PUBLIC"] : scope === "MEMBER" ? ["PUBLIC", "MEMBERS_ONLY"] : ["PUBLIC", "MEMBERS_ONLY", "STAFF_ONLY"];
  const classVisibility =
    scope === "PUBLIC" ? ["PUBLIC"] : scope === "MEMBER" ? ["PUBLIC", "MEMBERS_ONLY"] : ["PUBLIC", "MEMBERS_ONLY", "PRIVATE"];

  const [events, classSessions, privateBookings] = await Promise.all([
    prisma.event.findMany({
      where: {
        clubId,
        deletedAt: null,
        visibility: { in: eventVisibility },
        startsAt: { lte: to },
        endsAt: { gte: from },
        // Publish window applies to non-staff feeds; staff see drafts too.
        ...(scope === "STAFF"
          ? {}
          : {
              AND: [
                { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
                { OR: [{ unpublishAt: null }, { unpublishAt: { gte: now } }] },
              ],
            }),
      },
      select: {
        id: true,
        name: true,
        description: true,
        startsAt: true,
        endsAt: true,
        location: { select: { name: true } },
        sessions: { select: { id: true, name: true, startsAt: true, endsAt: true } },
      },
    }),
    prisma.classSession.findMany({
      where: {
        clubId,
        canceled: false,
        startsAt: { gte: from, lte: to },
        recurringClass: { visibility: { in: classVisibility } },
      },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        recurringClass: { select: { name: true, description: true, location: { select: { name: true } } } },
      },
    }),
    scope === "STAFF"
      ? prisma.privateBooking.findMany({
          where: {
            clubId,
            status: { in: ["CONFIRMED", "COMPLETED"] },
            confirmedStartAt: { gte: from, lte: to },
          },
          select: {
            id: true,
            confirmedStartAt: true,
            confirmedEndAt: true,
            lessonType: { select: { title: true } },
            coach: { select: { firstName: true, lastName: true } },
            member: { select: { firstName: true, lastName: true } },
          },
        })
      : Promise.resolve([] as never[]),
  ]);

  const items: FeedItem[] = [];
  for (const e of events) {
    if (e.sessions.length > 0) {
      for (const s of e.sessions) {
        items.push({
          uid: `event-${e.id}-${s.id}`,
          title: s.name ? `${e.name} — ${s.name}` : e.name,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          description: e.description,
          location: e.location?.name ?? null,
          kind: "event",
        });
      }
    } else {
      items.push({
        uid: `event-${e.id}`,
        title: e.name,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        description: e.description,
        location: e.location?.name ?? null,
        kind: "event",
      });
    }
  }
  for (const s of classSessions) {
    items.push({
      uid: `class-${s.id}`,
      title: s.recurringClass.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      description: s.recurringClass.description,
      location: s.recurringClass.location?.name ?? null,
      kind: "class",
    });
  }
  for (const b of privateBookings) {
    if (!b.confirmedStartAt || !b.confirmedEndAt) continue;
    items.push({
      uid: `private-${b.id}`,
      title: `Private: ${b.lessonType.title} — ${b.member.firstName} ${b.member.lastName}`,
      startsAt: b.confirmedStartAt,
      endsAt: b.confirmedEndAt,
      description: b.coach ? `Coach ${b.coach.firstName} ${b.coach.lastName}` : null,
      location: null,
      kind: "private",
    });
  }

  items.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return { clubName: club.name, timezone: club.timezone, items };
}

// ── ICS serialization ──────────────────────────────────────────────────────

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// RFC 5545 line folding: max 75 octets per line, continuation lines start
// with a space. Folding on character count is fine for our ASCII-dominant
// content and keeps strict parsers happy.
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  return parts.join("\r\n");
}

// `timezone` (Club.timezone, IANA) resolves the wall-clock-UTC class stamps to
// real instants so calendar apps show a 5:30 PM class at 5:30 PM club time.
// Without it, class stamps are emitted as-is (pre-timezone behavior: correct
// wall clock only for viewers whose calendar runs in UTC). Events/privates are
// already true instants and are never converted.
export function buildIcs(
  clubName: string,
  scope: FeedScope,
  items: FeedItem[],
  timezone?: string | null,
): string {
  const calName = scope === "STAFF" ? `${clubName} — staff calendar` : `${clubName} calendar`;
  const stamp = icsDate(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AthletixOS//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calName)}`,
    // Hint clients to refresh hourly — the feed is always current anyway.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const item of items) {
    const isClass = item.kind === "class";
    const startsAt = isClass ? wallClockUTCToInstant(item.startsAt, timezone) : item.startsAt;
    const endsAt = isClass ? wallClockUTCToInstant(item.endsAt, timezone) : item.endsAt;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(item.uid)}@athletix-os.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(startsAt)}`,
      `DTEND:${icsDate(endsAt)}`,
      `SUMMARY:${icsEscape(item.title)}`,
    );
    if (item.description) lines.push(`DESCRIPTION:${icsEscape(item.description)}`);
    if (item.location) lines.push(`LOCATION:${icsEscape(item.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
