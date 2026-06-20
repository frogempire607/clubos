import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import {
  resolveName,
  parseFlexibleDate,
  normalizeFrequency,
  parseMoney,
  resolveBillingAnchor,
  MIGRATION_STATUS,
  PAYMENT_SETUP,
} from "@/lib/migration";

// Second-pass migration import: attach membership/billing data to EXISTING
// members. Many legacy platforms export people and billing as separate
// reports, and clubs with thousands of stale profiles only carry memberships
// for their active members — so this matches rows to members instead of
// creating anyone.
//
// Match cascade (most → least reliable): legacyMemberId → email → full name
// (only when exactly one member matches). Ambiguous or unmatched rows are
// reported back, never guessed. Matched members are pulled into the migration
// pipeline (IMPORTED + payment setup required) so Stripe activation can use
// the billing anchor. Existing billing values are overwritten and the change
// is logged on the member's migration timeline. Nothing is ever auto-charged.

// Bulk import can do several writes per row. A strictly sequential row-by-row
// loop through the cold serverless→pooler path could exceed the platform's
// default ~10s function limit even for ~90 rows — surfaced to the user as a
// generic "Import failed". Raise the ceiling (host clamps to the plan max) and
// pair it with the prefetch + batching below, which is the real fix.
export const maxDuration = 60;

// How many member updates to run concurrently. Small enough to stay within the
// Prisma/pooler connection budget, large enough to collapse the wall-clock from
// "N sequential round-trips" to "N / CONCURRENCY".
const IMPORT_CONCURRENCY = 10;

const rowSchema = z.object({
  legacyMemberId:      z.string().optional().nullable(),
  email:               z.string().optional().nullable(),
  athleteName:         z.string().optional().nullable(),
  firstName:           z.string().optional().nullable(),
  lastName:            z.string().optional().nullable(),
  membershipName:      z.string().optional().nullable(),
  membershipPrice:     z.string().optional().nullable(),
  billingFrequency:    z.string().optional().nullable(),
  nextBillingDate:     z.string().optional().nullable(),
  membershipStartDate: z.string().optional().nullable(),
  commitmentEndDate:   z.string().optional().nullable(),
});

const importSchema = z.object({
  rows: z.array(rowSchema).min(1).max(2000),
});

type MemberLite = {
  id: string;
  email: string | null;
  legacyMemberId: string | null;
  firstName: string;
  lastName: string;
  status: string;
  migrationStatus: string | null;
  paymentSetupStatus: string | null;
  importedAt: Date | null;
  legacyMembershipName: string | null;
  legacyMembershipPrice: unknown;
};

function pushTo(map: Map<string, string[]>, key: string, value: string) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = rateLimit({
    key: `import:memberships:${session.user.id}`,
    limit: 5,
    windowMs: 10 * 60_000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many import attempts. Wait a few minutes between bulk imports.");

  try {
    const { rows } = importSchema.parse(await req.json());
    const clubId = session.user.clubId;
    const now = new Date();

    const results = {
      updated: 0,
      unmatched: 0,
      failed: 0,
      errors: [] as string[],
    };

    // ── Prefetch every non-deleted member for the club ONCE, then match in
    // memory. This removes the ~3 match queries + findUnique that previously ran
    // per row (the sequential round-trips that timed the function out). ──
    const allMembers = (await prisma.member.findMany({
      where: { clubId, deletedAt: null },
      select: {
        id: true, email: true, legacyMemberId: true, firstName: true, lastName: true,
        status: true, migrationStatus: true, paymentSetupStatus: true, importedAt: true,
        legacyMembershipName: true, legacyMembershipPrice: true,
      },
    })) as MemberLite[];

    const byLegacy = new Map<string, string[]>();
    const byEmail = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const memberById = new Map<string, MemberLite>();
    for (const m of allMembers) {
      memberById.set(m.id, m);
      if (m.legacyMemberId) pushTo(byLegacy, m.legacyMemberId.trim(), m.id);
      if (m.email) pushTo(byEmail, m.email.toLowerCase(), m.id);
      const nameKey = `${m.firstName.toLowerCase().trim()}|${m.lastName.toLowerCase().trim()}`;
      if (nameKey !== "|") pushTo(byName, nameKey, m.id);
    }

    // Members with a live subscription — used to avoid demoting them to PROSPECT.
    const activeSubMemberIds = new Set(
      (
        await prisma.memberSubscription.findMany({
          where: { status: "active", member: { clubId } },
          select: { memberId: true },
        })
      ).map((s) => s.memberId),
    );

    // ── Pass 1 (no DB writes): match rows in memory + build the update list. ──
    type UpdateTask = {
      memberId: string;
      label: string;
      data: Record<string, unknown>;
      message: string;
    };
    const tasks: UpdateTask[] = [];

    for (const r of rows) {
      const { firstName, lastName, display } = resolveName({
        athleteName: r.athleteName,
        firstName: r.firstName,
        lastName: r.lastName,
      });
      const label =
        display ||
        r.email?.trim() ||
        (r.legacyMemberId ? `Legacy #${r.legacyMemberId.trim()}` : "A row");

      const legacyId = r.legacyMemberId?.trim();
      const email = r.email?.trim().toLowerCase();

      let ids: string[] = [];
      if (legacyId) ids = byLegacy.get(legacyId) ?? [];
      if (ids.length !== 1 && email) ids = byEmail.get(email) ?? [];
      if (ids.length !== 1 && display && (firstName || lastName)) {
        ids = byName.get(`${firstName.toLowerCase()}|${lastName.toLowerCase()}`) ?? [];
      }

      if (ids.length === 0) {
        results.unmatched++;
        results.errors.push(`${label}: no matching member found — skipped`);
        continue;
      }
      if (ids.length > 1) {
        results.unmatched++;
        results.errors.push(`${label}: multiple members match — skipped (add a Legacy ID or email column to disambiguate)`);
        continue;
      }

      const memberId = ids[0];
      const existing = memberById.get(memberId);
      if (!existing) {
        results.failed++;
        results.errors.push(`${label}: member disappeared mid-import`);
        continue;
      }

      const membershipStartDate = parseFlexibleDate(r.membershipStartDate);
      const nextBillingDate = parseFlexibleDate(r.nextBillingDate);
      const commitmentEndDate = parseFlexibleDate(r.commitmentEndDate);
      const frequency = normalizeFrequency(r.billingFrequency);
      const price = parseMoney(r.membershipPrice);
      const billingAnchorDate = resolveBillingAnchor({
        nextBillingDate,
        membershipStartDate,
        frequency,
        now,
      });

      // Migrated members must start as PROSPECT until they complete activation.
      // Only demote a currently-ACTIVE member with NO live sub that hasn't
      // already activated/completed — never someone mid/post-onboarding.
      const downgradeToProspect =
        existing.status === "ACTIVE" &&
        !activeSubMemberIds.has(memberId) &&
        existing.migrationStatus !== MIGRATION_STATUS.ACTIVATED &&
        existing.migrationStatus !== MIGRATION_STATUS.COMPLETED;

      const overwrote = !!existing.legacyMembershipName || existing.legacyMembershipPrice != null;

      tasks.push({
        memberId,
        label,
        data: {
          legacyMembershipName: r.membershipName?.trim() || null,
          legacyMembershipPrice: price,
          legacyBillingFrequency: frequency,
          membershipStartDate,
          nextBillingDate,
          commitmentEndDate,
          billingAnchorDate,
          legacyMemberId: existing.legacyMemberId ?? legacyId ?? null,
          migrationStatus: existing.migrationStatus ?? MIGRATION_STATUS.IMPORTED,
          importedAt: existing.importedAt ?? now,
          paymentSetupStatus:
            existing.paymentSetupStatus === PAYMENT_SETUP.COMPLETE
              ? PAYMENT_SETUP.COMPLETE
              : PAYMENT_SETUP.REQUIRED,
          ...(downgradeToProspect ? { status: "PROSPECT" } : {}),
        },
        message: `Membership CSV: ${r.membershipName?.trim() || "—"}${
          price != null ? ` · $${price}` : ""
        }${frequency ? ` · ${frequency}` : ""}${
          billingAnchorDate ? ` · next bill ${billingAnchorDate.toISOString().slice(0, 10)}` : ""
        }${overwrote ? " (overwrote previous billing info)" : ""}`,
      });
    }

    // ── Pass 2: apply updates in small concurrent batches so the wall-clock is
    // N / IMPORT_CONCURRENCY round-trips instead of N. ──
    for (let i = 0; i < tasks.length; i += IMPORT_CONCURRENCY) {
      const slice = tasks.slice(i, i + IMPORT_CONCURRENCY);
      const outcomes = await Promise.all(
        slice.map(async (t): Promise<"ok" | string> => {
          try {
            await prisma.member.update({ where: { id: t.memberId }, data: t.data });
            await prisma.memberMigrationEvent.create({
              data: {
                clubId,
                memberId: t.memberId,
                type: "BILLING_IMPORTED",
                message: t.message,
                actorUserId: session.user.id,
              },
            });
            return "ok";
          } catch {
            return `${t.label}: failed to save`;
          }
        }),
      );
      for (const o of outcomes) {
        if (o === "ok") results.updated++;
        else {
          results.failed++;
          results.errors.push(o);
        }
      }
    }

    return NextResponse.json(results, { status: 200 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.errors
        .map((e) => `${e.path.length ? `[${e.path.join(".")}] ` : ""}${e.message}`)
        .slice(0, 5)
        .join(" · ");
      return NextResponse.json({ error: `Validation error: ${msg}` }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
