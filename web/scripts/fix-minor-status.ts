/**
 * Set `Member.isMinor` to what the member's own date of birth says.
 *
 * DRY RUN BY DEFAULT. Acting requires BOTH `--apply` and an explicit
 * `--members <id|email>,…` allowlist. There is no all-mode.
 *
 *   npx tsx scripts/fix-minor-status.ts
 *   npx tsx scripts/fix-minor-status.ts --apply --members cmrzg3rlz0005n244b7u37cd1,cmskhzqxu00028nec0f59rbw0
 *
 * ── What this changes, and what it does NOT ────────────────────────────────
 *
 * Less than it looks like, because most gates already ignore this column.
 * `resolveIsMinor` lets a date of birth OUTRANK the stored flag, and the three
 * gates that matter already call it:
 *
 *   document signing   app/api/member/documents/[id]/sign  — already DOB-led.
 *                      Its comment names the exact four-year-old this script
 *                      is for: he could not sign his own waiver TODAY.
 *   consent gate       lib/parentalConsent.guardianActionBlocked — DOB-led,
 *                      and inert anyway while FEATURE_PARENTAL_CONSENT is off.
 *   login gate         lib/auth — DOB-led, same flag.
 *
 * The one gate that reads the RAW column is parental controls:
 *
 *   lib/parentalControls.applyParentalControls:137
 *     if (!member.isMinor) return { kind: "allow" };
 *
 * Its select does not even fetch `dateOfBirth`, so no DOB can outrank it. That
 * is the same bug shape as commitmentEndDate and membershipId — a stored field
 * answering a question that is derivable — and it is why a minor flagged adult
 * has NO parental controls available at all: every payment approval, spend
 * limit and messaging restriction short-circuits to "allow" before it reads the
 * controls JSON.
 *
 * So the honest summary: this script does not close a waiver hole (that one is
 * already closed). It makes parental controls possible for members who cannot
 * have them today.
 *
 * ── The trap this script will warn you about ──────────────────────────────
 *
 * `lib/memberValidation.validateMemberContact` REQUIRES a guardian name and a
 * guardian email once `isMinor` is true. Flipping a member who has neither
 * leaves a row that staff cannot save from the edit drawer until a guardian is
 * added. That is arguably the right pressure, but it should not be a surprise,
 * so it is reported per row before anything is written.
 *
 * This script only ever writes `isMinor`. It does not create guardians, move
 * logins, or touch signatures — those are Phase 7 shapes and belong to Phase 7.
 */
import { prisma } from "../lib/prisma";
import { ageFromDOB } from "../lib/age";
import { writeBillingAudit } from "../lib/billingAudit";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const allowRaw = (() => {
  const i = argv.indexOf("--members");
  return i >= 0 ? (argv[i + 1] ?? "") : "";
})();
const ALLOW = allowRaw.split(",").map((s) => s.trim()).filter(Boolean);

const line = (s = "") => console.log(s);
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

async function main() {
  const members = await prisma.member.findMany({
    where: { deletedAt: null, dateOfBirth: { not: null } },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, email: true,
      dateOfBirth: true, isMinor: true, guardianName: true, guardianEmail: true,
      userId: true, status: true,
      guardianLinks: { select: { userId: true } },
    },
  });

  type Row = (typeof members)[number] & { age: number; shouldBe: boolean };
  const wrong: Row[] = [];
  for (const m of members) {
    const age = ageFromDOB(m.dateOfBirth);
    if (age === null) continue;
    const shouldBe = age < 18;
    if (shouldBe !== m.isMinor) wrong.push({ ...m, age, shouldBe });
  }

  const minorsFlaggedAdult = wrong.filter((r) => r.shouldBe);
  const adultsFlaggedMinor = wrong.filter((r) => !r.shouldBe);

  line(`\n${"━".repeat(78)}`);
  line("MINOR STATUS — stored flag vs the member's own date of birth");
  line("━".repeat(78));
  line(`\n${members.length} member(s) with a DOB · ${wrong.length} disagree with it\n`);

  line(`✗ MINORS FLAGGED AS ADULTS — ${minorsFlaggedAdult.length}`);
  line("  No parental controls are available for these members: applyParentalControls");
  line("  short-circuits to \"allow\" on the raw flag before it reads any controls.\n");
  for (const r of minorsFlaggedAdult) {
    const hasGuardianContact = !!(r.guardianName?.trim() && r.guardianEmail?.trim());
    line(`   ${pad(`${r.firstName} ${r.lastName}`, 22)} age ${String(r.age).padStart(2)}  ` +
         `DOB ${r.dateOfBirth!.toISOString().slice(0, 10)}  ${r.status}`);
    line(`   ${" ".repeat(22)} ${r.id}`);
    line(`   ${" ".repeat(22)} guardian on record: ${hasGuardianContact ? `${r.guardianName} <${r.guardianEmail}>` : "NONE"}` +
         `   guardian links: ${r.guardianLinks.length}`);
    if (!hasGuardianContact) {
      line(`   ${" ".repeat(22)} ⚠ setting isMinor=true makes guardian name + email REQUIRED.`);
      line(`   ${" ".repeat(22)}   Staff will not be able to save this row from the edit drawer`);
      line(`   ${" ".repeat(22)}   until a guardian is added. Flip it knowing that.`);
    }
    if (r.userId) {
      line(`   ${" ".repeat(22)} ⚠ holds their OWN login. If FEATURE_PARENTAL_CONSENT is ever`);
      line(`   ${" ".repeat(22)}   switched on, lib/auth blocks a minor's own sign-in — this`);
      line(`   ${" ".repeat(22)}   account stops working. The login shape is Phase 7 work, not`);
      line(`   ${" ".repeat(22)}   this script's.`);
    }
    line("");
  }

  line(`· FLAGGED MINOR, DOB SAYS ADULT — ${adultsFlaggedMinor.length}`);
  line("  Nothing recomputes isMinor on a birthday, so this is mostly just aging out.");
  line("  Clearing the flag removes any parental controls those members still carry,");
  line("  which is why they are NOT in the default allowlist — decide per person.\n");
  for (const r of adultsFlaggedMinor) {
    line(`   ${pad(`${r.firstName} ${r.lastName}`, 22)} age ${String(r.age).padStart(2)}  ${r.id}`);
  }

  // ── Act ──────────────────────────────────────────────────────────────────
  line(`\n${"─".repeat(78)}`);
  if (!APPLY) {
    line("DRY RUN — nothing was written.");
    line("");
    line("To act, pass BOTH --apply and an explicit --members allowlist:");
    line("  npx tsx scripts/fix-minor-status.ts --apply --members <id>,<id>");
    line("");
    line("There is no all-mode. Each of these is a decision about a real family.");
    return;
  }
  if (!ALLOW.length) {
    line("✗ --apply requires --members <id|email>,… — refusing to act on everybody.");
    process.exitCode = 1;
    return;
  }

  const targets = wrong.filter((r) => ALLOW.includes(r.id) || (r.email && ALLOW.includes(r.email)));
  const unmatched = ALLOW.filter(
    (a) => !wrong.some((r) => r.id === a || r.email === a),
  );
  if (unmatched.length) {
    line(`✗ not found, or already correct: ${unmatched.join(", ")}`);
    line("  Refusing to run a partially-understood allowlist. Nothing was written.");
    process.exitCode = 1;
    return;
  }

  for (const r of targets) {
    await prisma.member.update({ where: { id: r.id }, data: { isMinor: r.shouldBe } });
    await writeBillingAudit({
      clubId: r.clubId,
      memberId: r.id,
      actorUserId: null,
      action: "MINOR_STATUS_CORRECTED",
      before: { isMinor: r.isMinor },
      after: { isMinor: r.shouldBe },
      note:
        `scripts/fix-minor-status.ts — DOB ${r.dateOfBirth!.toISOString().slice(0, 10)} ` +
        `makes them ${r.age}, so isMinor should be ${r.shouldBe}. ` +
        `Only this column was written; guardians, logins and signatures untouched.`,
    });
    line(`   ✓ ${r.firstName} ${r.lastName} — isMinor ${r.isMinor} → ${r.shouldBe}`);
  }
  line(`\n${targets.length} member(s) corrected. One audit row each.`);
  line("Parental controls are now AVAILABLE for them — none are configured by this");
  line("script. Set them per child at /member/family/<memberId> or leave them off.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
