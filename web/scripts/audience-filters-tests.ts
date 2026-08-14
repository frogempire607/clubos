// Integration tests for lib/audienceFilters.evaluateAudience.
//
// These hit a real database on purpose. The bug being pinned here was not in
// the parsing — it was in which branch the evaluator took, and only a real
// query proves which members come back.
//
// Local throwaway Postgres only:
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
//     npx tsx scripts/audience-filters-tests.ts

import { PrismaClient } from "@prisma/client";
import { evaluateAudience, parseAudienceFilter } from "../lib/audienceFilters";

const prisma = new PrismaClient();
const clubId = "club_local";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!process.env.DATABASE_URL?.includes("55432")) {
    throw new Error("Refusing to run outside the local throwaway Postgres (port 55432).");
  }

  const members = await prisma.member.findMany({
    where: { clubId, deletedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const total = members.length;
  if (total < 4) throw new Error(`Need at least 4 seeded members, found ${total}.`);
  const picked = members.slice(0, 3).map((m) => m.id);

  console.log(`\nclub has ${total} live members; hand-picking ${picked.length}\n`);

  // ── The regression this file exists for ────────────────────────────────
  //
  // A pure custom selection: no rules, just hand-picked people. This is what
  // "email these 77 members" serialises to. It must return exactly those
  // members — not the whole club.
  {
    const ids = await evaluateAudience(clubId, parseAudienceFilter({
      match: "ALL",
      rules: [],
      alwaysIncludeMemberIds: picked,
    }));
    check(
      "a hand-picked selection with no rules returns EXACTLY those members",
      ids.length === picked.length && picked.every((p) => ids.includes(p)),
      `got ${ids.length} of ${total}`,
    );
    check(
      "…and specifically does NOT fall through to the whole club",
      ids.length !== total,
      `got all ${total}`,
    );
  }

  // An empty filter still means nobody — the original, correct intent.
  {
    const ids = await evaluateAudience(clubId, parseAudienceFilter({ match: "ALL", rules: [] }));
    check("an empty filter matches nobody", ids.length === 0, `got ${ids.length}`);
  }

  // Exclusions beat inclusions, so a hand-picked member who has opted out of
  // this audience stays out.
  {
    const ids = await evaluateAudience(clubId, parseAudienceFilter({
      match: "ALL",
      rules: [],
      alwaysIncludeMemberIds: picked,
      alwaysExcludeMemberIds: [picked[0]],
    }));
    check(
      "alwaysExclude removes a hand-picked member",
      ids.length === picked.length - 1 && !ids.includes(picked[0]),
      `got ${ids.length}`,
    );
  }

  // Rules still work, and still narrow rather than match everyone.
  {
    const ids = await evaluateAudience(clubId, parseAudienceFilter({
      match: "ALL",
      rules: [{ field: "membershipStatus", op: "eq", value: "ACTIVE" }],
    }));
    check("a real rule still selects", ids.length > 0, `got ${ids.length}`);
    check("…and narrows rather than matching everyone", ids.length < total, `got ${ids.length} of ${total}`);
  }

  // A rule PLUS a hand-picked extra is a union, not a replacement.
  {
    const ruleOnly = await evaluateAudience(clubId, parseAudienceFilter({
      match: "ALL",
      rules: [{ field: "membershipStatus", op: "eq", value: "ACTIVE" }],
    }));
    const outsider = members.map((m) => m.id).find((id) => !ruleOnly.includes(id));
    if (!outsider) {
      check("skipped: every member matches the rule, no outsider to union", true);
    } else {
      const withExtra = await evaluateAudience(clubId, parseAudienceFilter({
        match: "ALL",
        rules: [{ field: "membershipStatus", op: "eq", value: "ACTIVE" }],
        alwaysIncludeMemberIds: [outsider],
      }));
      check(
        "a rule plus a hand-picked extra unions them",
        withExtra.length === ruleOnly.length + 1 && withExtra.includes(outsider),
        `${ruleOnly.length} → ${withExtra.length}`,
      );
    }
  }

  // Cross-tenant safety: a member id from another club can't be smuggled in.
  {
    const foreign = await prisma.member.findFirst({
      where: { clubId: { not: clubId } },
      select: { id: true },
    });
    if (!foreign) {
      check("skipped: no second club seeded to test tenant isolation", true);
    } else {
      const ids = await evaluateAudience(clubId, parseAudienceFilter({
        match: "ALL", rules: [], alwaysIncludeMemberIds: [foreign.id],
      }));
      check("a hand-picked id from another club is dropped", ids.length === 0, `got ${ids.length}`);
    }
  }

  console.log(`\n${"─".repeat(58)}`);
  if (failures.length) {
    console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
    failures.forEach((f) => console.log(`   ${f}`));
    process.exit(1);
  }
  console.log(`✓ ${pass}/${pass} passed`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
