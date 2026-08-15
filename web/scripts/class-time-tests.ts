// Pure tests for the class-start predicate in lib/datetime.ts.
//   npx tsx scripts/class-time-tests.ts
//
// The bug these pin (live, 2026-08-14): a 7:00 PM class in a UTC-4 club became
// unbookable at 3:00 PM, because a wall-clock-UTC stamp was compared straight
// to a true instant. Parents were told "Class has already started" four hours
// early and could not sign their kids up.

import { classHasStarted, wallClockUTCToInstant, wallClockNowUTC } from "../lib/datetime";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const NY = "America/New_York"; // UTC-4 in August (EDT)

// A 7:00 PM class on 2026-08-13 is STORED as 19:00Z (wall clock pinned to UTC).
const SEVEN_PM = new Date("2026-08-13T19:00:00Z");

// ── The exact live report ────────────────────────────────────────────────────
{
  // 6:00 PM club-local = 22:00Z. The class starts at 7 PM — an hour away.
  const sixPmLocal = new Date("2026-08-13T22:00:00Z");
  check(
    "a 7pm class has NOT started at 6pm club-local (the live report)",
    !classHasStarted(SEVEN_PM, NY, sixPmLocal),
  );
  // The old code did `startsAt < now`: 19:00Z < 22:00Z → "already started".
  check("...and the raw comparison it replaces gets this wrong", SEVEN_PM < sixPmLocal);
}

// ── The full window that was broken ──────────────────────────────────────────
{
  // The raw comparison started refusing at 19:00Z = 3:00 PM club-local.
  const threePmLocal = new Date("2026-08-13T19:00:00Z");
  check("not started at 3pm club-local", !classHasStarted(SEVEN_PM, NY, threePmLocal));
  const sixFiftyNine = new Date("2026-08-13T22:59:00Z");
  check("not started one minute before start", !classHasStarted(SEVEN_PM, NY, sixFiftyNine));
}

// ── It must still say YES once the class really is running ───────────────────
{
  const sevenPmLocal = new Date("2026-08-13T23:00:00Z"); // exactly 7 PM local
  check("started exactly at 7pm club-local", classHasStarted(SEVEN_PM, NY, sevenPmLocal));
  const eightPmLocal = new Date("2026-08-14T00:00:00Z");
  check("started at 8pm club-local", classHasStarted(SEVEN_PM, NY, eightPmLocal));
  const nextDay = new Date("2026-08-14T18:00:00Z");
  check("a yesterday class reads as started", classHasStarted(SEVEN_PM, NY, nextDay));
}

// ── Timezone west of the club, and no timezone at all ────────────────────────
{
  const LA = "America/Los_Angeles"; // UTC-7 in August
  // 7 PM Pacific = 02:00Z next day.
  const sixPmPacific = new Date("2026-08-14T01:00:00Z");
  check("UTC-7 club: not started at 6pm local", !classHasStarted(SEVEN_PM, LA, sixPmPacific));
  check("UTC-7 club: started at 7pm local", classHasStarted(SEVEN_PM, LA, new Date("2026-08-14T02:00:00Z")));

  // No timezone set = passthrough (the documented pre-timezone behavior).
  // Still offset-wrong, but unchanged from before — and Settings → Club fixes it.
  check(
    "no club timezone falls back to the stamp itself",
    classHasStarted(SEVEN_PM, null, new Date("2026-08-13T19:00:01Z")),
  );
  check(
    "an invalid timezone degrades instead of throwing",
    classHasStarted(SEVEN_PM, "Not/AZone", new Date("2026-08-13T19:00:01Z")),
  );
}

// ── DST: the offset must come from the class date, not from today ────────────
{
  // January in New York is UTC-5, not UTC-4.
  const janSevenPm = new Date("2026-01-14T19:00:00Z");
  check(
    "winter class resolves at UTC-5 (not the summer offset)",
    wallClockUTCToInstant(janSevenPm, NY).toISOString() === "2026-01-15T00:00:00.000Z",
  );
  check(
    "summer class resolves at UTC-4",
    wallClockUTCToInstant(SEVEN_PM, NY).toISOString() === "2026-08-13T23:00:00.000Z",
  );
}

// ── Agreement with the feed filter — the two must never disagree again ───────
{
  // /api/member/schedule keeps a session visible while wallClockNow < startsAt.
  // The booking cutoff must not refuse anything the feed still offers.
  const probes = [
    "2026-08-13T17:00:00Z", // 1 PM local
    "2026-08-13T19:00:00Z", // 3 PM local — where the old cutoff broke
    "2026-08-13T22:00:00Z", // 6 PM local — the live report
    "2026-08-13T22:59:00Z", // 6:59 PM local
  ];
  let agree = true;
  for (const iso of probes) {
    const at = new Date(iso);
    const feedShowsAsUpcoming = SEVEN_PM > wallClockNowUTC(NY, at);
    const bookable = !classHasStarted(SEVEN_PM, NY, at);
    if (feedShowsAsUpcoming !== bookable) agree = false;
  }
  check("the booking cutoff agrees with the schedule feed at every probe", agree);
}

console.log(`\n${"─".repeat(58)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.log(`   ${f}`));
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} passed`);
