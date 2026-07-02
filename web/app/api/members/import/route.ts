import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { upsertGuardianProfile, type GuardianInput } from "@/lib/guardian";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { normalizeImportedMemberContact, validateMemberContact } from "@/lib/memberValidation";
import {
  resolveName,
  parseFlexibleDate,
  normalizeFrequency,
  parseMoney,
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

// Imported members are NEVER auto-activated — activation happens through the
// onboarding/activation flow, and ACTIVE is reserved for members with an active
// subscription. We still honor a clearly inactive/paused signal from the old
// software (so dead accounts aren't pulled into the prospect funnel), but
// anything that would previously have been "active" — including a blank or
// unknown status — now starts as PROSPECT. (Requirement: imported members must
// default to Prospect regardless of their status in the previous software, and
// ACTIVE must not be assigned automatically during import.)
function normalizeStatus(raw: string | null | undefined): "PROSPECT" | "INACTIVE" | "PAUSED" {
  const s = (raw || "").toUpperCase().trim();
  if (s === "INACTIVE" || /cancel|inactive|expired|former|frozen/i.test(raw || "")) return "INACTIVE";
  if (s === "PAUSED" || /pause|hold|suspend/i.test(raw || "")) return "PAUSED";
  return "PROSPECT";
}

// Bulk import can do several writes per row. On a cold serverless function
// going through the connection pooler, a strictly sequential row-by-row loop
// could exceed the platform's default ~10s function limit even for a modest
// file — the client surfaced that hard timeout as a generic "Import failed".
// This raises the ceiling (the host clamps it to the plan max) while the
// batching below is the real fix.
export const maxDuration = 60;

// How many rows to process concurrently. Small enough to stay within the
// Prisma/pooler connection budget, large enough to collapse the wall-clock of
// an import from "N sequential round-trips" to "N / CONCURRENCY".
const IMPORT_CONCURRENCY = 5;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 5 imports per 10 minutes per session. Member import is heavy
  // (DB writes per row up to 2000) and a normal user does it rarely.
  const rl = rateLimit({ key: `import:members:${session.user.id}`, limit: 5, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many import attempts. Wait a few minutes between bulk imports.");

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

    // Prefetch every existing (non-deleted) member email for this club in ONE
    // query, so duplicate detection is a Set lookup instead of a per-row DB
    // round-trip. This alone removes N queries from the hot path.
    const existingMembers = await prisma.member.findMany({
      where: { clubId, deletedAt: null, email: { not: null } },
      select: { email: true },
    });
    const seenEmails = new Set<string>();
    for (const e of existingMembers) if (e.email) seenEmails.add(e.email.toLowerCase());

    // ── Pass 1 (no DB): validate + normalize every row, reserve emails so an
    // in-batch duplicate is also skipped, and collect the UNIQUE guardian
    // emails to resolve. ──
    type PreparedRow = {
      row: (typeof members)[number];
      firstName: string;
      lastName: string;
      display: string;
      email: string | null;
      phone: string | null;
      guardianEmail: string | null;
      guardianPhone: string | null;
      isMinor: boolean;
      migrationStatus: string | null;
    };
    const prepared: PreparedRow[] = [];
    const guardianInputs = new Map<string, GuardianInput>();

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

      const isMinor = m.isMinor ?? !!(m.guardianName || m.guardianEmail);

      // Most other gym/CRM exports keep ONE contact column and never separate
      // the parent from the child. For a minor, that single email/phone is
      // really the guardian's — so when no guardian-specific contact was given,
      // default the guardian contact from the member's contact, and DON'T also
      // keep it as the child's own (keeps logins + duplicate-detection clean,
      // and means we only ever require one email + one phone per member).
      const normalizedContact = normalizeImportedMemberContact({
        email: m.email,
        phone: m.phone,
        guardianEmail: m.guardianEmail,
        guardianPhone: m.guardianPhone,
        isMinor,
      });
      const { email, phone, guardianEmail, guardianPhone } = normalizedContact;

      // Never overwrite an existing member silently — skip duplicates (also
      // catches a second row carrying the same email within this import).
      if (email && seenEmails.has(email)) {
        results.skipped++;
        results.errors.push(`${display}: ${email} already exists — skipped (not overwritten)`);
        continue;
      }

      // Require contact on the right party: guardian name + email for a minor,
      // member email or phone for an adult. Migration NEVER hard-fails — it
      // flags NEEDS_REVIEW so nobody is lost in the switch.
      const contactError = validateMemberContact({
        isMinor,
        email,
        phone,
        guardianName: m.guardianName,
        guardianEmail,
      });
      let migrationStatus: string | null = migration ? MIGRATION_STATUS.IMPORTED : null;
      if (contactError) {
        if (migration) {
          migrationStatus = MIGRATION_STATUS.NEEDS_REVIEW;
          results.needsReview++;
        } else {
          results.failed++;
          results.errors.push(`${display}: ${contactError}`);
          continue;
        }
      }

      if (email) seenEmails.add(email);
      if (guardianEmail && !guardianInputs.has(guardianEmail)) {
        guardianInputs.set(guardianEmail, {
          guardianName: m.guardianName ?? null,
          guardianEmail,
          guardianPhone: guardianPhone ?? null,
        });
      }

      prepared.push({ row: m, firstName, lastName, display, email, phone, guardianEmail, guardianPhone, isMinor, migrationStatus });
    }

    // ── Pass 2: resolve each UNIQUE guardian once (deduped), in small
    // concurrent batches. Reuses upsertGuardianProfile so semantics are
    // unchanged — we just stop re-upserting the same guardian for every
    // sibling, which was a big chunk of the per-row cost. ──
    const guardianIdByEmail = new Map<string, string>();
    const guardianEntries = [...guardianInputs.entries()];
    for (let i = 0; i < guardianEntries.length; i += IMPORT_CONCURRENCY) {
      const slice = guardianEntries.slice(i, i + IMPORT_CONCURRENCY);
      await Promise.all(
        slice.map(async ([gemail, ginput]) => {
          try {
            const g = await upsertGuardianProfile(clubId, ginput);
            if (g) guardianIdByEmail.set(gemail, g.id);
          } catch {
            /* a guardian that can't be resolved just leaves the member's guardianId null */
          }
        }),
      );
    }

    // ── Pass 3: create members in small concurrent batches. Each row keeps the
    // original create shapes (member, then its migration event) but rows run in
    // parallel, so the wall-clock is N / IMPORT_CONCURRENCY round-trips instead
    // of N — what keeps the request under the function time limit. ──
    for (let i = 0; i < prepared.length; i += IMPORT_CONCURRENCY) {
      const slice = prepared.slice(i, i + IMPORT_CONCURRENCY);
      const outcomes = await Promise.all(
        slice.map(async (p): Promise<"ok" | string> => {
          const m = p.row;
          try {
            // Migration billing dates (display + Stripe anchor; never auto-charged).
            const membershipStartDate = parseFlexibleDate(m.membershipStartDate);
            const nextBillingDate = parseFlexibleDate(m.nextBillingDate);
            const commitmentEndDate = parseFlexibleDate(m.commitmentEndDate);
            const frequency = normalizeFrequency(m.billingFrequency);
            const billingAnchorDate = migration
              ? resolveBillingAnchor({ nextBillingDate, membershipStartDate, frequency, now })
              : null;
            const guardianId = p.guardianEmail ? guardianIdByEmail.get(p.guardianEmail) ?? null : null;

            const created = await prisma.member.create({
              data: {
                clubId,
                firstName: p.firstName,
                lastName: p.lastName,
                email: p.email,
                phone: p.phone,
                dateOfBirth: parseFlexibleDate(m.dateOfBirth),
                // Migrated members hold PROSPECT at the DB level only because the
                // MemberStatus enum has no dedicated value — they are NOT funnel
                // prospects. Their migrationStatus marks them as "Migrating" in the
                // members list, exempts them from prospect-TTL decay
                // (lib/memberStatus.ts), and drives the onboarding column
                // (Un-invited / Invited / Profile completed). They flip ACTIVE via
                // activation + approval. Non-migration import keeps its normalized
                // status.
                status: migration ? "PROSPECT" : normalizeStatus(m.status),
                tags: m.tags?.trim() || "",
                notes: m.notes?.trim() || null,
                streetAddress: m.streetAddress?.trim() || null,
                city: m.city?.trim() || null,
                state: m.state?.trim() || null,
                zipCode: m.zipCode?.trim() || null,
                gender: m.gender?.trim() || null,
                customFieldValues: JSON.stringify(m.customFieldValues || {}),
                isMinor: p.isMinor,
                guardianId,
                guardianName: m.guardianName?.trim() || null,
                guardianEmail: p.guardianEmail,
                guardianPhone: p.guardianPhone,
                guardianRelationship: m.guardianRelationship?.trim() || null,
                ...(migration
                  ? {
                      legacySource: legacySource?.trim() || null,
                      legacyMemberId: m.legacyMemberId?.trim() || null,
                      importedAt: now,
                      migrationStatus: p.migrationStatus,
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

            return "ok";
          } catch {
            return `${p.display}: failed to save`;
          }
        }),
      );
      for (const o of outcomes) {
        if (o === "ok") results.created++;
        else {
          results.failed++;
          results.errors.push(o);
        }
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
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
