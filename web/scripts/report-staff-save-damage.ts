/**
 * What the Edit Staff modal's save bug may have left behind.
 *
 * REPORT ONLY. No --apply, and there should not be one: every row here needs a
 * human to say what they INTENDED, and the database does not record intent.
 *
 *   npx tsx scripts/report-staff-save-damage.ts
 *   npx tsx scripts/report-staff-save-damage.ts --club <clubId>
 *
 * ── The two bugs this is looking for the wreckage of ────────────────────────
 *
 * Until 2026-09-25, EditStaffModal had four write boundaries in one scroll:
 * identity/permissions on the footer "Save changes" button, the compensation
 * plan on its own "Save compensation plan" button, lesson types written
 * IMMEDIATELY on every toggle, and documents written on upload.
 *
 *   BUG 1 — COMPENSATION DISCARDED. Fill in a compensation plan, press the
 *   footer "Save changes", and the plan is thrown away. The footer button never
 *   sent it. The modal closes cleanly, so the owner believes it saved. Payroll
 *   then computes from the OLD plan, or from no plan at all.
 *
 *   BUG 2 — LESSON TYPES KEPT THROUGH CANCEL. Toggle a lesson type, change your
 *   mind, press Cancel: the toggle was already PATCHed the moment you clicked
 *   it. Cancel discarded the identity edits and kept the lesson types.
 *
 * ── What is detectable, and what is not ─────────────────────────────────────
 *
 * There is no audit log on StaffProfile, StaffCompensation or
 * PrivateLessonType, so neither bug leaves a signature that proves itself.
 * What the timestamps CAN do is narrow the list of records worth eyeballing:
 *
 *   PROFILE NEWER THAN PLAN   StaffProfile.updatedAt > StaffCompensation
 *                             .updatedAt means the profile was saved after the
 *                             plan was last written. That is the exact shape
 *                             BUG 1 leaves — though it is also what you get by
 *                             legitimately editing only a title later, so it is
 *                             a shortlist, not a verdict.
 *
 *   NO PLAN AT ALL            Staff with no StaffCompensation row. Payroll pays
 *                             them nothing and says so quietly. If you remember
 *                             setting a plan for one of these, BUG 1 ate it.
 *
 *   ZERO BASE                 baseAmount = 0. The old save() did
 *                             `parseFloat(baseAmount) || 0`, so pressing "Save
 *                             compensation plan" with the amount field empty
 *                             stored a 0 base without complaining.
 *
 *   PRICE-OPTION-ONLY COACH   A coach eligible for a lesson type only through
 *                             one of its price options. The old checkbox
 *                             rendered these as ticked while only ever editing
 *                             eligibleCoachIds, so unticking appeared to do
 *                             nothing.
 *
 * Lesson-type eligibility is printed in full rather than flagged, because
 * nothing distinguishes a toggle you meant from one you cancelled. Read it
 * against what you remember setting.
 */

import { prisma } from "../lib/prisma";

const clubArg = process.argv.indexOf("--club");
const clubFilter = clubArg > -1 ? process.argv[clubArg + 1] : null;

const money = (n: unknown) => `$${Number(n ?? 0).toFixed(2)}`;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");
const rule = (label = "") =>
  console.log(`\n${label ? `── ${label} ` : ""}${"─".repeat(Math.max(0, 74 - label.length))}`);

async function main() {
  const clubs = await prisma.club.findMany({
    where: clubFilter ? { id: clubFilter } : {},
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  if (clubs.length === 0) {
    console.log("No clubs matched.");
    return;
  }

  for (const club of clubs) {
    console.log(`\n\n═══ ${club.name} (${club.id}) ═══`);

    // Owners are included: the modal edits them too, and Payroll pays them.
    const staff = await prisma.user.findMany({
      where: { clubId: club.id, role: { in: ["STAFF", "OWNER"] }, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        staffProfile: { select: { updatedAt: true, title: true } },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });

    if (staff.length === 0) {
      console.log("  No staff.");
      continue;
    }

    const comps = await prisma.staffCompensation.findMany({
      where: { clubId: club.id },
      include: { bonuses: { select: { bonusType: true, amount: true } } },
    });
    const compByUser = new Map(comps.map((c) => [c.userId, c]));

    rule("COMPENSATION");
    console.log(
      "  " +
        "Staff".padEnd(24) +
        "Base".padEnd(22) +
        "Bonuses".padEnd(9) +
        "Plan saved".padEnd(18) +
        "Profile saved",
    );

    const noPlan: string[] = [];
    const profileNewer: string[] = [];
    const zeroBase: string[] = [];

    for (const s of staff) {
      const name = `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.email || s.id;
      const c = compByUser.get(s.id);
      const profileAt = s.staffProfile?.updatedAt ?? null;

      if (!c) {
        noPlan.push(name);
        console.log(
          "  " + name.padEnd(24) + "(no plan)".padEnd(22) + "—".padEnd(9) + "—".padEnd(18) + day(profileAt),
        );
        continue;
      }

      const base = `${c.baseType} ${money(c.baseAmount)}`;
      if (Number(c.baseAmount) === 0) zeroBase.push(name);
      if (profileAt && profileAt.getTime() > c.updatedAt.getTime() + 2000) profileNewer.push(name);

      console.log(
        "  " +
          name.padEnd(24) +
          base.padEnd(22) +
          String(c.bonuses.length).padEnd(9) +
          day(c.updatedAt).padEnd(18) +
          day(profileAt),
      );
    }

    if (profileNewer.length) {
      console.log(
        `\n  ⚠ PROFILE NEWER THAN PLAN (${profileNewer.length}) — the shape BUG 1 leaves.` +
          `\n    Check the base and bonuses above against what you meant to set:` +
          `\n    ${profileNewer.join(", ")}`,
      );
    }
    if (noPlan.length) {
      console.log(
        `\n  ⚠ NO COMPENSATION PLAN (${noPlan.length}) — Payroll computes nothing for these:` +
          `\n    ${noPlan.join(", ")}`,
      );
    }
    if (zeroBase.length) {
      console.log(
        `\n  ⚠ ZERO BASE AMOUNT (${zeroBase.length}) — an empty amount field used to save as 0:` +
          `\n    ${zeroBase.join(", ")}`,
      );
    }
    if (!profileNewer.length && !noPlan.length && !zeroBase.length) {
      console.log("\n  ✓ Nothing to chase on compensation.");
    }

    rule("LESSON-TYPE ELIGIBILITY");
    const types = await prisma.privateLessonType.findMany({
      where: { clubId: club.id },
      select: {
        id: true,
        title: true,
        active: true,
        eligibleCoachIds: true,
        priceOptions: true,
        updatedAt: true,
      },
      orderBy: { title: "asc" },
    });

    if (types.length === 0) {
      console.log("  No lesson types.");
    } else {
      const nameOf = new Map(
        staff.map((s) => [s.id, `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.email || s.id]),
      );
      const optionOnly: string[] = [];

      for (const t of types) {
        const eligible = (Array.isArray(t.eligibleCoachIds) ? t.eligibleCoachIds : []) as string[];
        const opts = (Array.isArray(t.priceOptions) ? t.priceOptions : []) as {
          label?: string;
          coachIds?: string[];
        }[];
        const viaOption = new Set<string>();
        for (const o of opts) for (const c of o.coachIds ?? []) if (!eligible.includes(c)) viaOption.add(c);

        console.log(
          `\n  ${t.title}${t.active ? "" : "  (inactive)"}   last changed ${day(t.updatedAt)}`,
        );
        console.log(
          `    eligibleCoachIds: ${
            eligible.length ? eligible.map((id) => nameOf.get(id) ?? id).join(", ") : "(anyone)"
          }`,
        );
        if (viaOption.size) {
          const names = Array.from(viaOption).map((id) => nameOf.get(id) ?? id);
          console.log(`    via price option only: ${names.join(", ")}`);
          optionOnly.push(`${t.title} → ${names.join(", ")}`);
        }
      }

      if (optionOnly.length) {
        console.log(
          `\n  ⚠ PRICE-OPTION-ONLY COACHES (${optionOnly.length}) — the old checkbox showed these as` +
            `\n    ticked but could not untick them:\n    ${optionOnly.join("\n    ")}`,
        );
      }
    }

    rule("HOW TO READ THIS");
    console.log(
      "  Compensation: the ⚠ lists are the records worth opening. A plan that is\n" +
        "  right needs no action; a plan that is missing or stale is BUG 1, and\n" +
        "  re-saving it in the fixed modal is the whole fix.\n\n" +
        "  Lesson types: no flag can tell a toggle you meant from one you\n" +
        "  cancelled, so read the eligibility lists against your own intent. A\n" +
        "  coach listed who should not be is a leftover from BUG 2 — untick and\n" +
        "  save.\n\n" +
        "  Nothing here writes. Fix by editing the staff member in the app.",
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
