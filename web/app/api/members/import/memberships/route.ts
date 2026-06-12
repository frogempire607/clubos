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

      try {
        // ── Match cascade ────────────────────────────────────────────────
        let matches: { id: string }[] = [];
        const legacyId = r.legacyMemberId?.trim();
        const email = r.email?.trim().toLowerCase();

        if (legacyId) {
          matches = await prisma.member.findMany({
            where: { clubId, deletedAt: null, legacyMemberId: legacyId },
            select: { id: true },
            take: 2,
          });
        }
        if (matches.length !== 1 && email) {
          matches = await prisma.member.findMany({
            where: { clubId, deletedAt: null, email },
            select: { id: true },
            take: 2,
          });
        }
        if (matches.length !== 1 && (firstName || lastName) && display) {
          matches = await prisma.member.findMany({
            where: {
              clubId,
              deletedAt: null,
              firstName: { equals: firstName, mode: "insensitive" },
              lastName: { equals: lastName, mode: "insensitive" },
            },
            select: { id: true },
            take: 2,
          });
        }

        if (matches.length === 0) {
          results.unmatched++;
          results.errors.push(`${label}: no matching member found — skipped`);
          continue;
        }
        if (matches.length > 1) {
          results.unmatched++;
          results.errors.push(`${label}: multiple members match — skipped (add a Legacy ID or email column to disambiguate)`);
          continue;
        }

        // ── Apply billing data ───────────────────────────────────────────
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

        const existing = await prisma.member.findUnique({
          where: { id: matches[0].id },
          select: {
            migrationStatus: true,
            paymentSetupStatus: true,
            importedAt: true,
            legacyMembershipName: true,
            legacyMembershipPrice: true,
            legacyMemberId: true,
          },
        });
        if (!existing) {
          results.failed++;
          results.errors.push(`${label}: member disappeared mid-import`);
          continue;
        }

        await prisma.member.update({
          where: { id: matches[0].id },
          data: {
            legacyMembershipName: r.membershipName?.trim() || null,
            legacyMembershipPrice: price,
            legacyBillingFrequency: frequency,
            membershipStartDate,
            nextBillingDate,
            commitmentEndDate,
            billingAnchorDate,
            legacyMemberId: existing.legacyMemberId ?? legacyId ?? null,
            // Pull into the migration pipeline without clobbering progress:
            // keep an existing status, otherwise mark IMPORTED; never reset a
            // COMPLETE payment setup back to REQUIRED.
            migrationStatus: existing.migrationStatus ?? MIGRATION_STATUS.IMPORTED,
            importedAt: existing.importedAt ?? now,
            paymentSetupStatus:
              existing.paymentSetupStatus === PAYMENT_SETUP.COMPLETE
                ? PAYMENT_SETUP.COMPLETE
                : PAYMENT_SETUP.REQUIRED,
          },
        });

        const overwrote = existing.legacyMembershipName || existing.legacyMembershipPrice != null;
        await prisma.memberMigrationEvent.create({
          data: {
            clubId,
            memberId: matches[0].id,
            type: "BILLING_IMPORTED",
            message: `Membership CSV: ${r.membershipName?.trim() || "—"}${
              price != null ? ` · $${price}` : ""
            }${frequency ? ` · ${frequency}` : ""}${
              billingAnchorDate ? ` · next bill ${billingAnchorDate.toISOString().slice(0, 10)}` : ""
            }${overwrote ? " (overwrote previous billing info)" : ""}`,
            actorUserId: session.user.id,
          },
        });

        results.updated++;
      } catch {
        results.failed++;
        results.errors.push(`${label}: failed to save`);
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
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
