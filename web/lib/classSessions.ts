// Shared helpers for recurring-class session generation. Lives in lib/ (not a
// route.ts) because Next.js 15 forbids non-handler exports from route files.

export type DayOverride = {
  dayOfWeek: number;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
};

// Materialize ClassSession rows for a recurring class between [start, end].
// Days listed in `overrides` use their own times; all other scheduled days use
// defaultStartTime/defaultEndTime.
export function buildSessions(
  classId: string,
  clubId: string,
  daysOfWeek: number[],
  defaultStartTime: string,
  defaultEndTime: string,
  overrides: DayOverride[],
  start: Date,
  end: Date | null
) {
  const ceiling = end ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const overridesByDay = new Map<number, DayOverride>(overrides.map((o) => [o.dayOfWeek, o]));

  const rows: {
    classId: string;
    clubId: string;
    date: Date;
    startsAt: Date;
    endsAt: Date;
    canceled: boolean;
  }[] = [];

  const cur = new Date(start);
  cur.setUTCHours(0, 0, 0, 0);

  while (cur <= ceiling) {
    const dow = cur.getUTCDay();
    if (daysOfWeek.includes(dow)) {
      const o = overridesByDay.get(dow);
      const startTime = o?.startTime ?? defaultStartTime;
      const endTime = o?.endTime ?? defaultEndTime;
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      const startsAt = new Date(cur);
      startsAt.setUTCHours(sh, sm, 0, 0);
      const endsAt = new Date(cur);
      endsAt.setUTCHours(eh, em, 0, 0);
      rows.push({ classId, clubId, date: new Date(cur), startsAt, endsAt, canceled: false });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return rows;
}
