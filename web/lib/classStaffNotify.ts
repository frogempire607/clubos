// Class coach assignments — the NOTICES (stage 2).
//
// Called by the routes AFTER their transaction has committed, never inside it:
// a notice that fails must not undo or block the change it describes. Every
// function here is best-effort — it catches, logs and returns what it managed.
//
// Channels
//   staff notices    in-app = a Message row (the same mechanism
//                    lib/staffAssignmentsServer.notifySelfRemoval uses), from
//                    the person who made the change; email = lib/email.sendEmail.
//                    Coverage notices follow ClubScheduleSettings
//                    .coverageChannels (IN_APP / EMAIL; an unknown channel such
//                    as PUSH is ignored until it exists).
//   member notices   class cancellations only: one email per ADDRESS through
//                    lib/sendClubEmail (kind TRANSACTIONAL — logged as an
//                    EmailSend row, shows in Communications history), deduped
//                    by sendBatchId `class-cancel:<sessionId>:<canceledAt>` +
//                    dedupeKey `class-cancel:<sessionId>:<email>`. More than
//                    INLINE_CANCEL_MAX recipients are QUEUED for the email
//                    worker (lib/enqueueEmailSend) instead of sent inline, so a
//                    large class cannot time the request out half way.
//   audit            a StaffActivity ASSIGNMENT line per coach affected.
//
// Nobody is ever sent a notice about their own action.
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { enqueueEmailSendRows } from "@/lib/enqueueEmailSend";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { recordStaffActivity } from "@/lib/staffActivity";
import { asIdList, effectiveClassStaff } from "@/lib/staffAssignments";
import {
  calloutNotice,
  clubTodayYmd,
  fmtDayLong,
  fmtDayShort,
  fmtMonthDay,
  fmtStampTime,
  isSwitchedOn,
  relativeDayLabel,
  scheduleDayHref,
  toYmd,
  type CancelAudience,
} from "@/lib/classStaff";
import {
  cancelAudienceMembers,
  coverageRecipients,
  getScheduleSettings,
  recordCancelNotified,
  type CallOutResult,
} from "@/lib/classStaffServer";

/** At or below this many recipients a cancellation is emailed inline; above it, queued for the worker. */
export const INLINE_CANCEL_MAX = 40;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function staffEmailHtml(p: { banner?: string | null; headline: string; body: string; linkUrl?: string | null; linkLabel?: string; clubName?: string | null }): string {
  return `
<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1917">
  ${p.banner ? `<p style="margin:0 0 12px;padding:8px 12px;border-radius:8px;background:#fef2f2;color:#b91c1c;font-weight:700;font-size:13px">${esc(p.banner)}</p>` : ""}
  <h2 style="margin:0 0 10px;font-size:18px">${esc(p.headline)}</h2>
  <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1c1917">${esc(p.body).replace(/\n/g, "<br/>")}</p>
  ${p.linkUrl ? `<p style="margin:0 0 16px"><a href="${esc(p.linkUrl)}" style="display:inline-block;background:#534AB7;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${esc(p.linkLabel ?? "Open the staff schedule")}</a></p>` : ""}
  ${p.clubName ? `<p style="color:#a8a29e;font-size:12px;margin:0">${esc(p.clubName)}</p>` : ""}
</div>`;
}

type Tell = {
  clubId: string;
  /** The person who made the change — the Message sender; never notified themself. */
  senderId: string;
  toUserIds: readonly string[];
  /** In-app text. */
  message: string;
  subject: string;
  html: string;
  /** Which of IN_APP / EMAIL to use (anything else is ignored). */
  channels: readonly string[];
  fromName?: string | null;
};

/** Send one notice to current staff. Returns who was actually reached. */
async function tell(t: Tell): Promise<{ userIds: string[]; inApp: number; emailed: number }> {
  const ids = Array.from(new Set(t.toUserIds)).filter((id) => id && id !== t.senderId);
  if (ids.length === 0) return { userIds: [], inApp: 0, emailed: 0 };
  const users = await prisma.user.findMany({
    where: { clubId: t.clubId, id: { in: ids }, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true, email: true },
  });
  if (users.length === 0) return { userIds: [], inApp: 0, emailed: 0 };
  let inApp = 0;
  let emailed = 0;
  if (t.channels.includes("IN_APP")) {
    await prisma.message.createMany({
      data: users.map((u) => ({ clubId: t.clubId, senderId: t.senderId, recipientId: u.id, body: t.message.slice(0, 4000) })),
    });
    inApp = users.length;
  }
  if (t.channels.includes("EMAIL")) {
    const withEmail = users.filter((u) => !!u.email);
    const res = await Promise.allSettled(
      withEmail.map((u) => sendEmail({ to: u.email, subject: t.subject, html: t.html, fromName: t.fromName ?? null })),
    );
    emailed = res.filter((r) => r.status === "fulfilled").length;
  }
  return { userIds: users.map((u) => u.id), inApp, emailed };
}

async function clubInfo(clubId: string): Promise<{ name: string | null; timezone: string | null; contactEmail: string | null }> {
  const c = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true, contactEmail: true } });
  return { name: c?.name ?? null, timezone: c?.timezone ?? null, contactEmail: c?.contactEmail ?? null };
}

async function nameOfUser(clubId: string, ids: readonly string[]): Promise<(id: string) => string> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const rows = uniq.length
    ? await prisma.user.findMany({ where: { clubId, id: { in: uniq } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const map = new Map(rows.map((u) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "A coach"]));
  return (id: string) => map.get(id) ?? "A coach";
}

const dayLink = (dateYmd: string, classId: string, sessionId: string) => `${getAppBaseUrl()}${scheduleDayHref(dateYmd, { classId, sessionId })}`;

type DayRef = { sessionId: string; classId: string; className: string; date: string; startsAt: Date };
const whenShort = (d: DayRef) => `${fmtDayShort(d.date)} ${fmtStampTime(d.startsAt)}`;
const whenLong = (d: DayRef) => `${fmtDayLong(d.date)} at ${fmtStampTime(d.startsAt)}`;

// ── Coverage ────────────────────────────────────────────────────────────────

export type CoverageNoticeResult = {
  /** People told (deduped across days). */
  notified: number;
  recipientIds: string[];
  /** What the first (or only) notice said — the tests and the API echo it. */
  subject: string | null;
  body: string | null;
  late: boolean;
};

/**
 * A coach called out (one class day, or several from a date range): tell the
 * club's configured coverage recipients, in-app + email per its channels.
 * One notice per recipient — several days are folded into one message, late
 * ones first. A LATE call-out says so in the subject and opens with
 * "LATE CALL-OUT — class starts in 1h 20m".
 */
export async function notifyCoverageNeeded(input: {
  clubId: string;
  /** Who recorded it: the coach, or a manager on their behalf. */
  actorId: string;
  actorName?: string | null;
  coachId: string;
  reason?: string | null;
  results: readonly CallOutResult[];
  now?: Date;
}): Promise<CoverageNoticeResult> {
  const none: CoverageNoticeResult = { notified: 0, recipientIds: [], subject: null, body: null, late: false };
  if (input.results.length === 0) return none;
  try {
    const now = input.now ?? new Date();
    const [club, nameOf] = await Promise.all([clubInfo(input.clubId), nameOfUser(input.clubId, [input.coachId, input.actorId])]);
    const coachName = nameOf(input.coachId);
    const today = clubTodayYmd(club.timezone, now);
    const onBehalf = input.actorId !== input.coachId ? (input.actorName ?? nameOf(input.actorId)) : null;

    type Item = { r: CallOutResult; notice: ReturnType<typeof calloutNotice>; link: string };
    const perUser = new Map<string, Item[]>();
    let channels: string[] = ["IN_APP", "EMAIL"];
    const items: Item[] = [];
    for (const r of input.results) {
      const notice = calloutNotice({
        className: r.className, dateYmd: r.date, startsAt: r.startsAt, coachName, reason: input.reason,
        late: r.late, startInstant: r.startInstant, now, todayYmd: today, byName: onBehalf,
      });
      const item: Item = { r, notice, link: dayLink(r.date, r.classId, r.sessionId) };
      items.push(item);
      const rec = await coverageRecipients(input.clubId, r.sessionId, input.coachId);
      channels = rec.channels;
      for (const id of rec.userIds) {
        const list = perUser.get(id);
        if (list) list.push(item);
        else perUser.set(id, [item]);
      }
    }

    // Recent activity on the coach's own profile.
    const lateCount = items.filter((i) => i.r.late).length;
    await recordStaffActivity({
      clubId: input.clubId, staffUserId: input.coachId, actorUserId: input.actorId, actorName: input.actorName ?? null, kind: "ASSIGNMENT",
      summary: items.length === 1
        ? `Called out of ${items[0].r.className} on ${fmtMonthDay(items[0].r.date)}${items[0].r.late ? " (late call-out)" : ""} — needs coverage`
        : `Called out of ${items.length} class days, ${fmtMonthDay(items[0].r.date)} – ${fmtMonthDay(items[items.length - 1].r.date)}${lateCount ? ` (${lateCount} late)` : ""} — need coverage`,
    });

    const render = (list: Item[]) => {
      const sorted = [...list].sort((a, b) => Number(b.r.late) - Number(a.r.late) || a.r.startInstant.getTime() - b.r.startInstant.getTime());
      if (sorted.length === 1) {
        const { notice, link } = sorted[0];
        return {
          subject: notice.subject,
          message: `${notice.body} ${link}`,
          html: staffEmailHtml({ banner: notice.banner, headline: notice.headline, body: notice.body, linkUrl: link, clubName: club.name }),
          body: notice.body,
        };
      }
      const anyLate = sorted.some((i) => i.r.late);
      const subject = `${anyLate ? "Late call-out" : "Needs coverage"}: ${coachName} can't make ${sorted.length} classes`;
      const lines = sorted.map((i) => `• ${i.notice.banner ? `${i.notice.banner} — ` : ""}${i.r.className}, ${relativeDayLabel(i.r.date, today)} ${fmtStampTime(i.r.startsAt)}`);
      const reason = (input.reason ?? "").trim();
      const body = `${coachName} can't make ${sorted.length} classes. They are still on and need someone to cover:\n${lines.join("\n")}${reason ? `\nReason: ${reason}` : ""}`;
      const link = sorted[0].link;
      return { subject, message: `${body}\n${link}`, html: staffEmailHtml({ banner: anyLate ? "LATE CALL-OUT" : null, headline: subject, body, linkUrl: link, clubName: club.name }), body };
    };

    const reached = new Set<string>();
    let first: { subject: string; body: string } | null = null;
    for (const [userId, list] of perUser) {
      const out = render(list);
      if (!first) first = { subject: out.subject, body: out.body };
      const res = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: [userId], message: out.message, subject: out.subject, html: out.html, channels, fromName: club.name });
      for (const id of res.userIds) reached.add(id);
    }
    if (!first) {
      const out = render(items);
      first = { subject: out.subject, body: out.body };
    }
    // Recorded by a manager for them: the coach hears it too (in-app).
    if (onBehalf) {
      const i = items[0];
      const mine = items.length === 1
        ? `${onBehalf} recorded that you can't make ${i.r.className} on ${fmtDayLong(i.r.date)} at ${fmtStampTime(i.r.startsAt)}. It is marked as needing coverage.`
        : `${onBehalf} recorded that you can't make ${items.length} classes. They are marked as needing coverage.`;
      const res = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: [input.coachId], message: mine, subject: "", html: "", channels: ["IN_APP"] });
      for (const id of res.userIds) reached.add(id);
    }
    return { notified: reached.size, recipientIds: Array.from(reached), subject: first.subject, body: first.body, late: lateCount > 0 };
  } catch (err) {
    console.error("[classStaffNotify] needs-coverage notice failed", err);
    return none;
  }
}

/** A coach (or a manager for them) withdrew an unfilled call-out: the coverage group stands down. */
export async function notifyCoverageUndone(input: { clubId: string; actorId: string; actorName?: string | null; coachId: string; day: DayRef }): Promise<{ notified: number }> {
  try {
    const [club, nameOf, rec] = await Promise.all([
      clubInfo(input.clubId),
      nameOfUser(input.clubId, [input.coachId, input.actorId]),
      coverageRecipients(input.clubId, input.day.sessionId, input.coachId),
    ]);
    const coach = nameOf(input.coachId);
    const headline = `No cover needed: ${input.day.className} ${whenShort(input.day)}`;
    const body = `${coach} is back on ${input.day.className} on ${whenLong(input.day)}. No cover is needed.`;
    await recordStaffActivity({
      clubId: input.clubId, staffUserId: input.coachId, actorUserId: input.actorId, actorName: input.actorName ?? null, kind: "ASSIGNMENT",
      summary: `Call-out withdrawn — back on ${input.day.className} on ${fmtMonthDay(input.day.date)}`,
    });
    const link = dayLink(input.day.date, input.day.classId, input.day.sessionId);
    const group = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: rec.userIds, message: body, subject: headline, html: staffEmailHtml({ headline, body, linkUrl: link, clubName: club.name }), channels: rec.channels, fromName: club.name });
    let extra = 0;
    if (input.actorId !== input.coachId) {
      const me = `${input.actorName ?? nameOf(input.actorId)} withdrew your call-out: you are back on ${input.day.className} on ${whenLong(input.day)}.`;
      extra = (await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: [input.coachId], message: me, subject: `You're back on ${input.day.className} ${whenShort(input.day)}`, html: staffEmailHtml({ headline: `You're back on ${input.day.className}`, body: me, linkUrl: link, clubName: club.name }), channels: rec.channels, fromName: club.name })).userIds.length;
    }
    return { notified: group.userIds.length + extra };
  } catch (err) {
    console.error("[classStaffNotify] call-out-withdrawn notice failed", err);
    return { notified: 0 };
  }
}

/**
 * A schedule manager filled a coverage request: tell the substitute, the
 * coach who called out, and the coverage group ("Covered by X").
 */
export async function notifyCoverageFilled(input: {
  clubId: string; actorId: string; actorName?: string | null;
  originalUserId: string; substituteUserId: string; day: DayRef;
}): Promise<{ notified: number; substitute: boolean; original: boolean; group: number; subject: string | null }> {
  try {
    const [club, nameOf, rec] = await Promise.all([
      clubInfo(input.clubId),
      nameOfUser(input.clubId, [input.originalUserId, input.substituteUserId, input.actorId]),
      coverageRecipients(input.clubId, input.day.sessionId, input.originalUserId),
    ]);
    const sub = nameOf(input.substituteUserId);
    const orig = nameOf(input.originalUserId);
    const d = input.day;
    const link = dayLink(d.date, d.classId, d.sessionId);
    await recordStaffActivity({ clubId: input.clubId, staffUserId: input.substituteUserId, actorUserId: input.actorId, actorName: input.actorName ?? null, kind: "ASSIGNMENT", summary: `Covering ${d.className} on ${fmtMonthDay(d.date)} for ${orig}` });
    await recordStaffActivity({ clubId: input.clubId, staffUserId: input.originalUserId, actorUserId: input.actorId, actorName: input.actorName ?? null, kind: "ASSIGNMENT", summary: `${d.className} on ${fmtMonthDay(d.date)} covered by ${sub}` });

    const subBody = `You're covering ${d.className} on ${whenLong(d)} for ${orig}.`;
    const toSub = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: [input.substituteUserId], message: `${subBody} ${link}`, subject: `You're covering ${d.className} ${whenShort(d)}`, html: staffEmailHtml({ headline: `You're covering ${d.className}`, body: subBody, linkUrl: link, clubName: club.name }), channels: rec.channels, fromName: club.name });
    const origBody = `${sub} is covering ${d.className} on ${whenLong(d)} for you.`;
    const toOrig = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: [input.originalUserId], message: origBody, subject: `Covered: ${d.className} ${whenShort(d)}`, html: staffEmailHtml({ headline: `${d.className} is covered`, body: origBody, clubName: club.name }), channels: rec.channels, fromName: club.name });
    const subject = `Covered by ${sub}: ${d.className} ${whenShort(d)}`;
    const groupBody = `${sub} is covering ${d.className} on ${whenLong(d)} for ${orig}.`;
    const group = await tell({
      clubId: input.clubId, senderId: input.actorId,
      toUserIds: rec.userIds.filter((id) => id !== input.substituteUserId && id !== input.originalUserId),
      message: `Covered by ${sub}: ${groupBody}`, subject, html: staffEmailHtml({ headline: subject, body: groupBody, linkUrl: link, clubName: club.name }),
      channels: rec.channels, fromName: club.name,
    });
    return {
      notified: toSub.userIds.length + toOrig.userIds.length + group.userIds.length,
      substitute: toSub.userIds.length > 0, original: toOrig.userIds.length > 0, group: group.userIds.length, subject,
    };
  } catch (err) {
    console.error("[classStaffNotify] coverage-filled notice failed", err);
    return { notified: 0, substitute: false, original: false, group: 0, subject: null };
  }
}

/** A manager closed a coverage request with nobody replacing: tell the coach (in-app + email) and the group (in-app). */
export async function notifyCoverageClosed(input: { clubId: string; actorId: string; actorName?: string | null; coachId: string; day: DayRef; note?: string | null }): Promise<{ notified: number }> {
  try {
    const [club, nameOf, rec] = await Promise.all([
      clubInfo(input.clubId),
      nameOfUser(input.clubId, [input.coachId, input.actorId]),
      coverageRecipients(input.clubId, input.day.sessionId, input.coachId),
    ]);
    const d = input.day;
    const coach = nameOf(input.coachId);
    const note = (input.note ?? "").trim();
    await recordStaffActivity({ clubId: input.clubId, staffUserId: input.coachId, actorUserId: input.actorId, actorName: input.actorName ?? null, kind: "ASSIGNMENT", summary: `Call-out for ${d.className} on ${fmtMonthDay(d.date)} closed — no replacement${note ? ` (${note})` : ""}` });
    const mine = `Your call-out for ${d.className} on ${whenLong(d)} was closed — no replacement is needed. You are off that class day.`;
    const a = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: [input.coachId], message: mine, subject: `Call-out closed: ${d.className} ${whenShort(d)}`, html: staffEmailHtml({ headline: "Your call-out was closed", body: mine, clubName: club.name }), channels: rec.channels, fromName: club.name });
    const body = `No cover needed for ${d.className} on ${whenLong(d)}: ${coach}'s call-out was closed without a replacement.`;
    const b = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: rec.userIds, message: body, subject: `No cover needed: ${d.className} ${whenShort(d)}`, html: "", channels: rec.channels.filter((c) => c === "IN_APP") });
    return { notified: a.userIds.length + b.userIds.length };
  } catch (err) {
    console.error("[classStaffNotify] coverage-closed notice failed", err);
    return { notified: 0 };
  }
}

/** A coach was marked (or un-marked) as a no-show: tell them in-app, and log it. */
export async function notifyNoShow(input: { clubId: string; actorId: string; actorName?: string | null; coachId: string; day: DayRef; cleared: boolean }): Promise<{ notified: number }> {
  try {
    const d = input.day;
    await recordStaffActivity({ clubId: input.clubId, staffUserId: input.coachId, actorUserId: input.actorId, actorName: input.actorName ?? null, kind: "ASSIGNMENT", summary: input.cleared ? `No-show mark removed for ${d.className} on ${fmtMonthDay(d.date)}` : `Marked as a no-show for ${d.className} on ${fmtMonthDay(d.date)}` });
    const body = input.cleared
      ? `The no-show mark for ${d.className} on ${whenLong(d)} was removed.`
      : `You were marked as a no-show for ${d.className} on ${whenLong(d)}. If that is not right, talk to a schedule manager.`;
    const res = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: [input.coachId], message: body, subject: "", html: "", channels: ["IN_APP"] });
    return { notified: res.userIds.length };
  } catch (err) {
    console.error("[classStaffNotify] no-show notice failed", err);
    return { notified: 0 };
  }
}

// ── Assignments ─────────────────────────────────────────────────────────────

/**
 * A schedule manager changed who coaches a class: tell the coaches put on and
 * taken off, in-app, and log a line on each one's Recent activity.
 * `when` reads after the class name: "on Tue Oct 20" / "on Tuesdays from
 * Oct 20" / "every class day from Oct 20".
 */
export async function notifyAssignmentChange(input: {
  clubId: string; actorId: string; actorName?: string | null;
  className: string; when: string; addedIds: readonly string[]; removedIds: readonly string[];
}): Promise<{ notified: number; addedNotified: string[]; removedNotified: string[] }> {
  const out = { notified: 0, addedNotified: [] as string[], removedNotified: [] as string[] };
  if (input.addedIds.length === 0 && input.removedIds.length === 0) return out;
  try {
    const nameOf = await nameOfUser(input.clubId, [input.actorId]);
    const actor = (input.actorName ?? "").trim() || nameOf(input.actorId);
    for (const id of input.addedIds) {
      await recordStaffActivity({ clubId: input.clubId, staffUserId: id, actorUserId: input.actorId, actorName: actor, kind: "ASSIGNMENT", summary: `Put on ${input.className} ${input.when}` });
    }
    for (const id of input.removedIds) {
      await recordStaffActivity({ clubId: input.clubId, staffUserId: id, actorUserId: input.actorId, actorName: actor, kind: "ASSIGNMENT", summary: `Taken off ${input.className} ${input.when}` });
    }
    const a = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: input.addedIds, message: `${actor} put you on ${input.className} ${input.when}.`, subject: "", html: "", channels: ["IN_APP"] });
    const r = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: input.removedIds, message: `${actor} took you off ${input.className} ${input.when}.`, subject: "", html: "", channels: ["IN_APP"] });
    return { notified: a.userIds.length + r.userIds.length, addedNotified: a.userIds, removedNotified: r.userIds };
  } catch (err) {
    console.error("[classStaffNotify] assignment notice failed", err);
    return out;
  }
}

// ── Cancellation ────────────────────────────────────────────────────────────

export type CancelEmailCopy = { subject: string; html: string; text: string };

/**
 * The cancellation email a family gets. Plain, the club's name on it, the
 * class, its day and time on the club's own clock, the reason when one was
 * given. No sport-specific wording — it goes to every kind of club.
 */
export function renderClassCancelEmail(p: {
  clubName: string | null; className: string; dateYmd: string; startsAt: Date | string; endsAt?: Date | string | null;
  reason?: string | null; recipientName?: string | null; memberNames?: readonly string[]; contactEmail?: string | null;
}): CancelEmailCopy {
  const club = (p.clubName ?? "").trim() || "Your club";
  const day = fmtDayLong(p.dateYmd);
  const time = p.endsAt ? `${fmtStampTime(p.startsAt)} – ${fmtStampTime(p.endsAt)}` : fmtStampTime(p.startsAt);
  const reason = (p.reason ?? "").trim();
  const names = (p.memberNames ?? []).map((n) => n.trim()).filter(Boolean);
  const hello = (p.recipientName ?? "").trim() ? `Hi ${(p.recipientName ?? "").trim().split(/\s+/)[0]},` : "Hello,";
  const subject = `Canceled: ${p.className} on ${day}`;
  const line = `${p.className} on ${day} at ${time} has been canceled.`;
  const who = names.length > 0 ? `This is for ${names.join(", ")}.` : "";
  const contact = p.contactEmail ? `Questions? Reply to this email or write to ${p.contactEmail}.` : "Questions? Reply to this email.";
  const text = [hello, "", line, reason ? `Reason: ${reason}` : "", who, "", "You do not need to do anything. Other class days are not affected.", contact, "", club].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const html = `
<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1917">
  <p style="margin:0 0 6px;color:#a8a29e;font-size:13px;font-weight:600">${esc(club)}</p>
  <h2 style="margin:0 0 14px;font-size:22px">Class canceled</h2>
  <p style="margin:0 0 12px;line-height:1.6">${esc(hello)}</p>
  <p style="margin:0 0 12px;line-height:1.6"><strong>${esc(p.className)}</strong> on <strong>${esc(day)}</strong> at <strong>${esc(time)}</strong> has been canceled.</p>
  ${reason ? `<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid #e7e5e4;color:#57534e">${esc(reason)}</blockquote>` : ""}
  ${who ? `<p style="margin:0 0 12px;color:#57534e;line-height:1.6">${esc(who)}</p>` : ""}
  <p style="margin:0 0 12px;color:#57534e;line-height:1.6">You do not need to do anything. Other class days are not affected.</p>
  <p style="margin:0 0 18px;color:#57534e;line-height:1.6">${esc(contact)}</p>
  <p style="color:#a8a29e;font-size:11px;line-height:1.6;margin:0">You are receiving this because you are booked into or have access to this class at ${esc(club)}.</p>
</div>`;
  return { subject, html, text };
}

export type CancelNoticeResult = {
  audience: CancelAudience;
  /** Distinct addresses the notice was for. */
  recipients: number;
  sent: number;
  /** Handed to the email worker (large audiences). */
  queued: number;
  /** Already told in this cancellation (a retry), no address, opted out of ALL email, or no provider. */
  skipped: number;
  failed: number;
  /** What was stored on the class day: sent + queued. */
  notifiedCount: number;
  /** Members with no usable address. */
  noAddress: number;
  coachesNotified: number;
};

/**
 * After a class day was cancelled: email the chosen audience (one email per
 * address — a guardian of two athletes gets one naming both), store how many
 * were told, and tell that day's coaches in-app. Works for any class day,
 * pre-switch included.
 */
export async function notifyClassCanceled(input: {
  clubId: string; sessionId: string; actorId: string; actorName?: string | null;
  audience: CancelAudience; reason?: string | null; canceledAt?: Date | null;
}): Promise<CancelNoticeResult> {
  const out: CancelNoticeResult = { audience: input.audience, recipients: 0, sent: 0, queued: 0, skipped: 0, failed: 0, notifiedCount: 0, noAddress: 0, coachesNotified: 0 };
  let s: { id: string; classId: string; date: Date; startsAt: Date; endsAt: Date; staffOverride: unknown; className: string; seriesStaffIds: string[]; rows: { userId: string; status: string }[] } | null = null;
  try {
    const row = await prisma.classSession.findFirst({
      where: { id: input.sessionId, clubId: input.clubId },
      select: {
        id: true, classId: true, date: true, startsAt: true, endsAt: true, staffOverride: true,
        recurringClass: { select: { name: true, assignedStaffIds: true } },
        staff: { select: { userId: true, status: true } },
      },
    });
    if (!row) return out;
    s = { id: row.id, classId: row.classId, date: row.date, startsAt: row.startsAt, endsAt: row.endsAt, staffOverride: row.staffOverride, className: row.recurringClass.name, seriesStaffIds: asIdList(row.recurringClass.assignedStaffIds), rows: row.staff };
  } catch (err) {
    console.error("[classStaffNotify] cancel notice: could not load the class day", err);
    return out;
  }
  const dateYmd = toYmd(s.date);
  const club = await clubInfo(input.clubId).catch(() => ({ name: null, timezone: null, contactEmail: null }));

  // 1. Members.
  try {
    if (input.audience !== "NONE") {
      const aud = await cancelAudienceMembers(input.clubId, input.sessionId, input.audience);
      out.recipients = aud.recipients.length;
      out.noAddress = aud.skipped.length;
      const batch = `class-cancel:${s.id}:${(input.canceledAt ?? new Date()).getTime()}`;
      const rows = aud.recipients.map((r) => {
        const copy = renderClassCancelEmail({
          clubName: club.name, className: s!.className, dateYmd, startsAt: s!.startsAt, endsAt: s!.endsAt, reason: input.reason,
          recipientName: r.displayName, memberNames: r.memberNames, contactEmail: club.contactEmail,
        });
        return {
          kind: "TRANSACTIONAL" as const, recipientEmail: r.email, recipientMemberId: r.memberIds[0] ?? null,
          subject: copy.subject, bodyHtml: copy.html, bodyText: copy.text, fromName: club.name, replyTo: club.contactEmail,
          sendBatchId: batch, dedupeKey: `class-cancel:${s!.id}:${r.email.trim().toLowerCase()}`, sentByUserId: input.actorId,
          personalization: { classSessionId: s!.id, classId: s!.classId, memberIds: r.memberIds, audience: input.audience },
        };
      });
      if (rows.length > INLINE_CANCEL_MAX) {
        const q = await enqueueEmailSendRows(input.clubId, rows);
        out.queued = q.enqueued;
        out.skipped = q.duplicate;
        out.failed = q.failed;
      } else {
        for (let i = 0; i < rows.length; i += 8) {
          const res = await Promise.allSettled(rows.slice(i, i + 8).map((r) => sendClubEmail({ clubId: input.clubId, ...r })));
          for (const r of res) {
            if (r.status === "rejected") out.failed++;
            else if (r.value.status === "SENT") out.sent++;
            else if (r.value.status === "FAILED") out.failed++;
            else out.skipped++;
          }
        }
      }
    }
    out.notifiedCount = out.sent + out.queued;
    await recordCancelNotified(prisma, { clubId: input.clubId, sessionId: input.sessionId, count: out.notifiedCount });
  } catch (err) {
    console.error("[classStaffNotify] cancel notice to members failed", err);
  }

  // 2. That day's coaches, in-app.
  try {
    const settings = await getScheduleSettings(input.clubId);
    const coachIds = isSwitchedOn(settings.assignmentsStartOn, dateYmd)
      ? Array.from(new Set(s.rows.filter((r) => r.status !== "REMOVED").map((r) => r.userId)))
      : effectiveClassStaff(s.seriesStaffIds, s.staffOverride).staffIds;
    const nameOf = await nameOfUser(input.clubId, [input.actorId]);
    const actor = (input.actorName ?? "").trim() || nameOf(input.actorId);
    const reason = (input.reason ?? "").trim();
    const body = `${s.className} on ${fmtDayLong(dateYmd)} at ${fmtStampTime(s.startsAt)} was canceled by ${actor}.${reason ? ` Reason: ${reason}${/[.!?]$/.test(reason) ? "" : "."}` : ""}`;
    const res = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: coachIds, message: body, subject: "", html: "", channels: ["IN_APP"] });
    out.coachesNotified = res.userIds.length;
  } catch (err) {
    console.error("[classStaffNotify] cancel notice to coaches failed", err);
  }
  return out;
}

/** A cancelled class day was put back on: tell that day's coaches in-app. (Members are NOT re-notified — see the API notes.) */
export async function notifyClassUncanceled(input: { clubId: string; sessionId: string; actorId: string; actorName?: string | null }): Promise<{ coachesNotified: number }> {
  try {
    const row = await prisma.classSession.findFirst({
      where: { id: input.sessionId, clubId: input.clubId },
      select: { date: true, startsAt: true, staffOverride: true, recurringClass: { select: { name: true, assignedStaffIds: true } }, staff: { select: { userId: true, status: true } } },
    });
    if (!row) return { coachesNotified: 0 };
    const dateYmd = toYmd(row.date);
    const settings = await getScheduleSettings(input.clubId);
    const coachIds = isSwitchedOn(settings.assignmentsStartOn, dateYmd)
      ? Array.from(new Set(row.staff.filter((r) => r.status !== "REMOVED").map((r) => r.userId)))
      : effectiveClassStaff(asIdList(row.recurringClass.assignedStaffIds), row.staffOverride).staffIds;
    const nameOf = await nameOfUser(input.clubId, [input.actorId]);
    const actor = (input.actorName ?? "").trim() || nameOf(input.actorId);
    const body = `${row.recurringClass.name} on ${fmtDayLong(dateYmd)} at ${fmtStampTime(row.startsAt)} is back on (un-canceled by ${actor}).`;
    const res = await tell({ clubId: input.clubId, senderId: input.actorId, toUserIds: coachIds, message: body, subject: "", html: "", channels: ["IN_APP"] });
    return { coachesNotified: res.userIds.length };
  } catch (err) {
    console.error("[classStaffNotify] un-cancel notice failed", err);
    return { coachesNotified: 0 };
  }
}
