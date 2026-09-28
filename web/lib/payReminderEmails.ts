// The morning payday email — one digest per club, to the club owner(s).
// Called by /api/cron/pay-reminders (daily, 12:00 UTC).
//
// A reminder is emailed when its payday is TODAY (club's calendar day), or it
// is overdue and was never emailed (e.g. the schedule was set up after the
// payday, or a run was missed). StaffPaySchedule.lastEmailedFor holds the
// latest payday already emailed; it is claimed with a conditional update
// BEFORE sending, so two overlapping runs can't both send, and rolled back if
// every send fails so tomorrow's run tries again.
import { prisma } from "@/lib/prisma";
import { isEmailConfigured, sendPayReminderDigestEmail } from "@/lib/email";
import { getEmailBaseUrl } from "@/lib/baseUrl";
import { clubTodayYmd, formatUsdShort, loadClubReminders, type ReminderView } from "@/lib/payReminders";
import { dateFromYmd, formatPayday, formatPeriod, statusLabel } from "@/lib/paySchedule";

export type PayReminderEmailResult = {
  clubId: string;
  outcome: "sent" | "nothing_due" | "no_owner_email" | "email_not_configured" | "already_claimed" | "send_failed" | "error";
  reminders?: number;
  recipients?: number;
  error?: string;
};

/** Which of today's reminders belong in the email. Pure. */
export function remindersToEmail(
  reminders: Pick<ReminderView, "userId" | "payday" | "status">[],
  lastEmailedFor: ReadonlyMap<string, string | null>,
) {
  return reminders.filter((r) => {
    if (r.status === "upcoming") return false;
    const last = lastEmailedFor.get(r.userId) ?? null;
    return !last || last < r.payday;
  });
}

export function reminderEmailLine(r: ReminderView): { heading: string; detail: string } {
  const amount =
    r.estimate !== null && r.estimate > 0
      ? `about ${formatUsdShort(Math.round(r.estimate))}`
      : r.hasPlan
        ? "nothing calculated for this period"
        : "no pay plan set";
  const when = r.status === "due_today" ? "Due today" : statusLabel(r).replace(/^./, (c) => c.toUpperCase());
  return {
    heading: `${r.name} — ${amount}`,
    detail: `${when} (${formatPayday(r.payday)}) · for ${formatPeriod(r.periodStart, r.periodEnd)}`,
  };
}

export async function runPayReminderEmails(now: Date = new Date()): Promise<PayReminderEmailResult[]> {
  const clubRows = await prisma.staffPaySchedule.findMany({
    where: { active: true },
    select: { clubId: true },
    distinct: ["clubId"],
  });
  const results: PayReminderEmailResult[] = [];
  const configured = isEmailConfigured();
  const payrollUrl = `${getEmailBaseUrl()}/dashboard/staff/payroll`;

  for (const { clubId } of clubRows) {
    try {
      const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true } });
      if (!club) continue;
      const today = clubTodayYmd(club.timezone, now);
      const data = await loadClubReminders(clubId, { today });
      const last = new Map(data.schedules.map((s) => [s.userId, s.lastEmailedFor]));
      const due = remindersToEmail(data.reminders, last) as ReminderView[];
      if (due.length === 0) {
        results.push({ clubId, outcome: "nothing_due" });
        continue;
      }
      if (!configured) {
        results.push({ clubId, outcome: "email_not_configured", reminders: due.length });
        continue;
      }
      const owners = await prisma.user.findMany({
        where: { clubId, role: "OWNER", deletedAt: null },
        select: { email: true },
      });
      const to = Array.from(new Set(owners.map((o) => o.email.trim()).filter(Boolean)));
      if (to.length === 0) {
        results.push({ clubId, outcome: "no_owner_email", reminders: due.length });
        continue;
      }

      // Claim: advance lastEmailedFor to the latest payday being emailed, only
      // if it's still behind. A schedule whose claim loses is dropped.
      const latest = new Map<string, string>();
      for (const r of due) if (!latest.has(r.userId) || latest.get(r.userId)! < r.payday) latest.set(r.userId, r.payday);
      const claimed: { scheduleId: string; userId: string; previous: string | null }[] = [];
      for (const [userId, payday] of Array.from(latest.entries())) {
        const sch = data.schedules.find((s) => s.userId === userId)!;
        const res = await prisma.staffPaySchedule.updateMany({
          where: {
            id: sch.scheduleId,
            OR: [{ lastEmailedFor: null }, { lastEmailedFor: { lt: dateFromYmd(payday) } }],
          },
          data: { lastEmailedFor: dateFromYmd(payday) },
        });
        if (res.count > 0) claimed.push({ scheduleId: sch.scheduleId, userId, previous: sch.lastEmailedFor });
      }
      const claimedIds = new Set(claimed.map((c) => c.userId));
      const lines = due.filter((r) => claimedIds.has(r.userId)).map(reminderEmailLine);
      if (lines.length === 0) {
        results.push({ clubId, outcome: "already_claimed" });
        continue;
      }

      let sent = 0;
      for (const addr of to) {
        try {
          await sendPayReminderDigestEmail({ to: addr, clubName: club.name, lines, payrollUrl });
          sent++;
        } catch (err) {
          console.error("[payReminders] send failed", clubId, err);
        }
      }
      if (sent === 0) {
        // Give the payday back so the next run retries.
        for (const c of claimed) {
          await prisma.staffPaySchedule
            .update({
              where: { id: c.scheduleId },
              data: { lastEmailedFor: c.previous ? dateFromYmd(c.previous) : null },
            })
            .catch(() => undefined);
        }
        results.push({ clubId, outcome: "send_failed", reminders: lines.length });
        continue;
      }
      results.push({ clubId, outcome: "sent", reminders: lines.length, recipients: sent });
    } catch (err) {
      console.error("[payReminders] club failed", clubId, err);
      results.push({ clubId, outcome: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
