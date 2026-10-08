// A coach's personal calendar subscription (Branch 3).
//
//   GET /api/public/staff-calendar/<token>   → an ICS feed of ONLY that
//   person's own obligations: the class days they are coaching (regular,
//   one-day and substitute), the events they are assigned to, and their
//   confirmed private lessons. Calendar apps poll it, so a change in the app
//   shows up on its own; a class they are taken off, or that is cancelled,
//   drops out.
//
// The coach chooses what it carries — classes, private lessons, events, any
// mix but never none (some track privates or events on their own). The
// choice lives on the link row and survives "get a new link".
//
// What is NEVER in it: pay of any kind, or anyone else's schedule.
// The token is random (not derived from anything), stored on
// staff_calendar_feeds, and replaced on "get a new link" — the old link stops
// working at once. A removed staff member's link stops working too.
// Class days are resolved by the same switch-aware reader as every other
// schedule screen (lib/classStaffServer.loadSessionStaffResolver).
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { buildIcs, type FeedItem } from "@/lib/calendarFeed";
import { loadSessionStaffResolver } from "@/lib/classStaffServer";
import { roleLabel } from "@/lib/classStaff";

export const FEED_DAYS_BACK = 30;
export const FEED_DAYS_AHEAD = 180;

export function newFeedToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function staffFeedUrls(token: string) {
  const ics = `${getAppBaseUrl()}/api/public/staff-calendar/${token}`;
  const webcal = ics.replace(/^https?:\/\//, "webcal://");
  return {
    ics,
    /** Opens Apple Calendar (and most desktop calendar apps) straight into "subscribe". */
    webcal,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
  };
}

export type FeedChoices = { classes: boolean; privates: boolean; events: boolean };
export const ALL_FEED_CHOICES: FeedChoices = { classes: true, privates: true, events: true };
/** At least one kind has to stay on — an empty calendar link is just "turn off". */
export function validChoices(c: FeedChoices): boolean {
  return c.classes || c.privates || c.events;
}
const choicesOf = (row: { includeClasses: boolean; includePrivates: boolean; includeEvents: boolean } | null): FeedChoices =>
  row ? { classes: row.includeClasses, privates: row.includePrivates, events: row.includeEvents } : ALL_FEED_CHOICES;

export type StaffFeedStatus = { enabled: boolean; createdAt: string | null; rotatedAt: string | null; lastAccessedAt: string | null; choices: FeedChoices };

export async function feedStatus(clubId: string, userId: string): Promise<StaffFeedStatus & { token: string | null }> {
  const row = await prisma.staffCalendarFeed.findFirst({ where: { clubId, userId } });
  return {
    enabled: !!row,
    token: row?.token ?? null,
    createdAt: row ? row.createdAt.toISOString() : null,
    rotatedAt: row?.rotatedAt ? row.rotatedAt.toISOString() : null,
    lastAccessedAt: row?.lastAccessedAt ? row.lastAccessedAt.toISOString() : null,
    choices: choicesOf(row),
  };
}

/** Save what the coach wants on their calendar. false = refused (nothing on, or no link yet). */
export async function setFeedChoices(clubId: string, userId: string, c: FeedChoices): Promise<boolean> {
  if (!validChoices(c)) return false;
  const hit = await prisma.staffCalendarFeed.updateMany({
    where: { clubId, userId },
    data: { includeClasses: c.classes, includePrivates: c.privates, includeEvents: c.events },
  });
  return hit.count > 0;
}

/** The person's link, created the first time it is asked for (with their first choice of what to sync). */
export async function ensureFeed(clubId: string, userId: string, choices: FeedChoices = ALL_FEED_CHOICES): Promise<string> {
  const existing = await prisma.staffCalendarFeed.findFirst({ where: { clubId, userId }, select: { token: true } });
  if (existing) return existing.token;
  const token = newFeedToken();
  const c = validChoices(choices) ? choices : ALL_FEED_CHOICES;
  await prisma.staffCalendarFeed.createMany({
    data: [{ clubId, userId, token, includeClasses: c.classes, includePrivates: c.privates, includeEvents: c.events }],
    skipDuplicates: true,
  });
  const row = await prisma.staffCalendarFeed.findFirst({ where: { clubId, userId }, select: { token: true } });
  return row?.token ?? token;
}

/** A NEW link; the old one stops working immediately. */
export async function regenerateFeed(clubId: string, userId: string, byUserId: string | null, now: Date = new Date()): Promise<string> {
  const token = newFeedToken();
  const hit = await prisma.staffCalendarFeed.updateMany({ where: { clubId, userId }, data: { token, rotatedAt: now, rotatedByUserId: byUserId, lastAccessedAt: null } });
  if (hit.count === 0) await prisma.staffCalendarFeed.createMany({ data: [{ clubId, userId, token }], skipDuplicates: true });
  return token;
}

/** Turn the link off. true = there was one. */
export async function revokeFeed(clubId: string, userId: string): Promise<boolean> {
  const hit = await prisma.staffCalendarFeed.deleteMany({ where: { clubId, userId } });
  return hit.count > 0;
}

/**
 * Everything on one coach's own schedule from 30 days back to 180 ahead.
 * null = no such current staff member.
 */
export async function staffFeedItems(clubId: string, userId: string, now: Date = new Date(), choices: FeedChoices = ALL_FEED_CHOICES): Promise<{ clubName: string; timezone: string | null; name: string; items: FeedItem[] } | null> {
  const [club, user] = await Promise.all([
    prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true } }),
    prisma.user.findFirst({ where: { id: userId, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null }, select: { firstName: true, lastName: true } }),
  ]);
  if (!club || !user) return null;
  const from = new Date(now.getTime() - FEED_DAYS_BACK * 86_400_000);
  const to = new Date(now.getTime() + FEED_DAYS_AHEAD * 86_400_000);

  const none = Promise.resolve([] as never[]);
  const [sessions, assignments, lessons] = await Promise.all([
    !choices.classes ? none : prisma.classSession.findMany({
      // A cancelled class day is not an obligation: it drops out of the feed.
      where: { clubId, canceled: false, startsAt: { gte: from, lte: to }, recurringClass: { deletedAt: null } },
      select: {
        id: true, date: true, startsAt: true, endsAt: true, staffOverride: true, note: true,
        recurringClass: { select: { name: true, assignedStaffIds: true, location: { select: { name: true } } } },
      },
    }),
    !choices.events ? none : prisma.eventStaffAssignment.findMany({
      where: { clubId, userId, event: { deletedAt: null, startsAt: { lte: to }, endsAt: { gte: from } } },
      select: {
        event: {
          select: {
            id: true, name: true, startsAt: true, endsAt: true, location: { select: { name: true } },
            sessions: { select: { id: true, name: true, startsAt: true, endsAt: true } },
          },
        },
      },
    }),
    !choices.privates ? none : prisma.privateBooking.findMany({
      where: { clubId, coachId: userId, status: { in: ["CONFIRMED", "COMPLETED"] }, confirmedStartAt: { gte: from, lte: to } },
      select: {
        id: true, confirmedStartAt: true, confirmedEndAt: true,
        lessonType: { select: { title: true } },
        member: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  const staffOn = await loadSessionStaffResolver(clubId, sessions);
  const items: FeedItem[] = [];
  for (const s of sessions) {
    const who = staffOn.forSession(s, s.recurringClass.assignedStaffIds);
    if (!who.staffIds.includes(userId)) continue;
    const mine = staffOn.isSwitched(s.date) ? staffOn.rowsFor(s.id).find((r) => r.userId === userId && r.status === "SCHEDULED") : null;
    const covering = mine?.kind === "SUBSTITUTE";
    const notes = [mine ? `Your role: ${roleLabel(mine.roleName)}${covering ? " (covering)" : ""}` : null, s.note ? `Note: ${s.note}` : null].filter(Boolean);
    items.push({
      uid: `staff-${userId}-class-${s.id}`,
      title: covering ? `${s.recurringClass.name} (covering)` : s.recurringClass.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      description: notes.length ? notes.join("\n") : null,
      location: s.recurringClass.location?.name ?? null,
      kind: "class",
    });
  }
  for (const a of assignments) {
    const e = a.event;
    const parts = e.sessions.length > 0 ? e.sessions.map((p) => ({ uid: `${e.id}-${p.id}`, title: p.name ? `${e.name} — ${p.name}` : e.name, startsAt: p.startsAt, endsAt: p.endsAt })) : [{ uid: e.id, title: e.name, startsAt: e.startsAt, endsAt: e.endsAt }];
    for (const p of parts) {
      if (p.endsAt < from || p.startsAt > to) continue;
      items.push({ uid: `staff-${userId}-event-${p.uid}`, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, description: null, location: e.location?.name ?? null, kind: "event" });
    }
  }
  for (const b of lessons) {
    if (!b.confirmedStartAt || !b.confirmedEndAt) continue;
    items.push({
      uid: `staff-${userId}-private-${b.id}`,
      title: `Private lesson — ${b.member.firstName} ${b.member.lastName}`.trim(),
      startsAt: b.confirmedStartAt,
      endsAt: b.confirmedEndAt,
      description: b.lessonType.title,
      location: null,
      kind: "private",
    });
  }
  items.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return { clubName: club.name, timezone: club.timezone, name: `${user.firstName} ${user.lastName}`.trim(), items };
}

/** The ICS text for a token, or null when the link is unknown, revoked, or its owner is no longer staff. */
export async function staffFeedIcs(token: string, now: Date = new Date()): Promise<string | null> {
  if (!token || token.length < 20 || token.length > 80) return null;
  const feed = await prisma.staffCalendarFeed.findUnique({
    where: { token },
    select: { id: true, clubId: true, userId: true, lastAccessedAt: true, includeClasses: true, includePrivates: true, includeEvents: true },
  });
  if (!feed) return null;
  const data = await staffFeedItems(feed.clubId, feed.userId, now, choicesOf(feed));
  if (!data) return null;
  // "Last used" — at most one write an hour, and never a reason to fail the feed.
  if (!feed.lastAccessedAt || now.getTime() - feed.lastAccessedAt.getTime() > 3_600_000) {
    await prisma.staffCalendarFeed.updateMany({ where: { id: feed.id }, data: { lastAccessedAt: now } }).catch(() => {});
  }
  return buildIcs(data.clubName, "STAFF", data.items, data.timezone, `${data.name} — ${data.clubName}`);
}
