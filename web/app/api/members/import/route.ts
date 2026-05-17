import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { upsertGuardianProfile } from "@/lib/guardian";
import {
  resolveName,
  parseFlexibleDate,
  normalizeFrequency,
  parseMoney,
  isValidEmail,
  resolveBillingAnchor,
  MIGRATION_STATUS,
  PAYMENT_SETUP,
} from "@/lib/migration";

// Flexible row: only a name (athleteName OR first/last) is truly required.
const memberSchema = z.object({
  athleteName:   z.string().optional().nullable(),
  firstName:     z.string().optional().nullable(),
  lastName:      z.string().optional().nullable(),
  email:         z.string().optional().nullable(),
  dateOfBirth:   z.string().optional().nullable(),
  status:        z.string().optional().nullable(),
  phone:         z.string().optional().nullable(),
  streetAddress: z.string().optional().nullable(),
  city:          z.string().optional().nullable(),
  state:         z.string().optional().nullable(),
  zipCode:       z.string().optional().nullable(),
  gender:        z.string().optional().nullable(),
  tags:          z.string().optional().nullable(),
  notes:         z.string().optional().nullable(),
  isMinor:       z.boolean().optional(),
  guardianName:  z.string().optional().nullable(),
  guardianEmail: z.string().optional().nullable(),
  guardianPhone: z.string().optional().nullable(),
  guardianRelationship: z.string().optional().nullable(),
  customFieldValues: z.record(z.string()).optional(),
  // Migration-only optional fields
  membershipName:        z.string().optional().nullable(),
  membershipPrice:       z.string().optional().nullable(),
  billingFrequency:      z.string().optional().nullable(),
  nextBillingDate:       z.string().optional().nullable(),
  membershipStartDate:   z.string().optional().nullable(),
  commitmentEndDate:     z.string().optional().nullable(),
  legacyMemberId:        z.string().optional().nullable(),
});

const importSchema = z.object({
  members: z.array(memberSchema).min(1).max(2000),
  // When true, rows enter the migration lifecycle (no Stripe, ever).
  migration: z.boolean().optional().default(false),
  legacySource: z.string().optional().nullable(),
});

function normalizeStatus(raw: string | null | undefined): "ACTIVE" | "PROSPECT" | "INACTIVE" | "PAUSED" {
  const s = (raw || "").toUpperCase().trim();
  if (["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"].includes(s)) return s as any;
  if (/cancel|inactive|expired|former|frozen/i.test(raw || "")) return "INACTIVE";
  if (/pause|hold|suspend/i.test(raw || "")) return "PAUSED";
  if (/lead|prospect|trial|pending/i.test(raw || "")) return "PROSPECT";
  return "ACTIVE";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { members, migration, legacySource } = importSchema.parse(body);
    const clubId = session.user.clubId;
    const now = new Date();

    const results = {
      created: 0,
      skipped: 0,
      failed: 0,
      needsReview: 0,
      errors: [] as string[],
    };

    for (const m of members) {
      const { firstName, lastName, display } = resolveName({
        athleteName: m.athleteName,
        firstName: m.firstName,
        lastName: m.lastName,
      });

      if (!firstName && !display) {
        results.failed++;
        results.errors.push("A row had no name and was skipped.");
        continue;
      }

      try {
        const rawEmail = m.email?.trim() || "";
        const email = isValidEmail(rawEmail) ? rawEmail.toLowerCase() : null;

        // Never overwrite an existing member silently — skip duplicates.
        if (email) {
          const dupe = await prisma.member.findFirst({
            where: { clubId, email, deletedAt: null },
            select: { id: true },
          });
          if (dupe) {
            results.skipped++;
            results.errors.push(`${display}: ${email} already exists — skipped (not overwritten)`);
            continue;
          }
        }

        const guardianEmail = m.guardianEmail?.trim().toLowerCase() || null;
        const isMinor = m.isMinor ?? !!(m.guardianName || guardianEmail);

        // For migration we DO NOT hard-fail minors missing guardian details —
        // we import and flag for review so no member is lost in the switch.
        let migrationStatus: string | null = migration ? MIGRATION_STATUS.IMPORTED : null;
        if (migration && isMinor && (!m.guardianName?.trim() || !guardianEmail)) {
          migrationStatus = MIGRATION_STATUS.NEEDS_REVIEW;
          results.needsReview++;
        } else if (!migration && isMinor && (!m.guardianName?.trim() || !guardianEmail || !m.guardianPhone?.trim())) {
          results.failed++;
          results.errors.push(`${display}: minors require guardian name, email, and phone`);
          continue;
        }

        const guardian = guardianEmail
          ? await upsertGuardianProfile(clubId, {
              guardianName: m.guardianName ?? null,
              guardianEmail,
              guardianPhone: m.guardianPhone ?? null,
            })
          : null;

        // Migration billing dates (display + Stripe anchor; never auto-charged).
        const membershipStartDate = parseFlexibleDate(m.membershipStartDate);
        const nextBillingDate = parseFlexibleDate(m.nextBillingDate);
        const commitmentEndDate = parseFlexibleDate(m.commitmentEndDate);
        const frequency = normalizeFrequency(m.billingFrequency);
        const billingAnchorDate = migration
          ? resolveBillingAnchor({ nextBillingDate, membershipStartDate, frequency, now })
          : null;

        const created = await prisma.member.create({
          data: {
            clubId,
            firstName,
            lastName,
            email,
            phone: m.phone?.trim() || null,
            dateOfBirth: parseFlexibleDate(m.dateOfBirth),
            // Migrated members are Pending Activation → PROSPECT until they
            // activate; non-migration import keeps its normalized status.
            status: migration ? "PROSPECT" : normalizeStatus(m.status),
            tags: m.tags?.trim() || "",
            notes: m.notes?.trim() || null,
            streetAddress: m.streetAddress?.trim() || null,
            city: m.city?.trim() || null,
            state: m.state?.trim() || null,
            zipCode: m.zipCode?.trim() || null,
            gender: m.gender?.trim() || null,
            customFieldValues: JSON.stringify(m.customFieldValues || {}),
            isMinor,
            guardianId: guardian?.id ?? null,
            guardianName: m.guardianName?.trim() || null,
            guardianEmail,
            guardianPhone: m.guardianPhone?.trim() || null,
            guardianRelationship: m.guardianRelationship?.trim() || null,
            ...(migration
              ? {
                  legacySource: legacySource?.trim() || null,
                  legacyMemberId: m.legacyMemberId?.trim() || null,
                  importedAt: now,
                  migrationStatus,
                  paymentSetupStatus: PAYMENT_SETUP.REQUIRED,
                  legacyMembershipName: m.membershipName?.trim() || null,
                  legacyMembershipPrice: parseMoney(m.membershipPrice),
                  legacyBillingFrequency: frequency,
                  membershipStartDate,
                  nextBillingDate,
                  billingAnchorDate,
                  commitmentEndDate,
                }
              : {}),
          },
          select: { id: true },
        });

        if (migration) {
          await prisma.memberMigrationEvent.create({
            data: {
              clubId,
              memberId: created.id,
              type: "IMPORTED",
              message: `Imported${legacySource ? ` from ${legacySource}` : ""}${
                m.membershipName ? ` · ${m.membershipName}` : ""
              }${billingAnchorDate ? ` · next bill ${billingAnchorDate.toISOString().slice(0, 10)}` : ""}`,
              actorUserId: session.user.id,
            },
          });
        }

        results.created++;
      } catch {
        results.failed++;
        results.errors.push(`${display}: failed to save`);
      }
    }

    return NextResponse.json(results, { status: 201 });
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
