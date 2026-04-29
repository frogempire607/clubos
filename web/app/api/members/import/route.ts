import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { upsertGuardianProfile } from "@/lib/guardian";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const memberSchema = z.object({
  firstName:     z.string().min(1),
  lastName:      z.string().min(1),
  // Lenient — accepts any string or blank; we validate the format ourselves below
  email:         z.string().optional().nullable(),
  dateOfBirth:   z.string().optional().nullable(),
  status:        z.enum(["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"]).default("ACTIVE"),
  phone:         z.string().optional().nullable(),
  streetAddress: z.string().optional().nullable(),
  city:          z.string().optional().nullable(),
  state:         z.string().optional().nullable(),
  zipCode:       z.string().optional().nullable(),
  gender:        z.string().optional().nullable(),
  tags:          z.string().optional().nullable(),
  notes:         z.string().optional().nullable(),
  isMinor:       z.boolean().default(false),
  guardianName:  z.string().optional().nullable(),
  guardianEmail: z.string().optional().nullable(),
  guardianPhone: z.string().optional().nullable(),
});

const importSchema = z.object({
  members: z.array(memberSchema).min(1).max(500),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { members } = importSchema.parse(body);

    const results = { created: 0, skipped: 0, failed: 0, errors: [] as string[] };

    for (const m of members) {
      try {
        // Sanitize email — discard if not a valid address
        const rawEmail = m.email?.trim() || "";
        const email = EMAIL_RE.test(rawEmail) ? rawEmail.toLowerCase() : null;

        // Skip duplicate emails within this club
        if (email) {
          const dupe = await prisma.member.findFirst({
            where: { clubId: session.user.clubId, email, deletedAt: null },
          });
          if (dupe) {
            results.skipped++;
            results.errors.push(`${m.firstName} ${m.lastName}: email ${email} already exists — skipped`);
            continue;
          }
        }

        const guardianEmail = m.guardianEmail?.trim().toLowerCase() || null;
        const guardian = guardianEmail
          ? await upsertGuardianProfile(session.user.clubId, {
              guardianName: m.guardianName ?? null,
              guardianEmail,
              guardianPhone: m.guardianPhone ?? null,
            })
          : null;

        await prisma.member.create({
          data: {
            clubId:        session.user.clubId,
            firstName:     m.firstName.trim(),
            lastName:      m.lastName.trim(),
            email:         email,
            phone:         m.phone?.trim() || null,
            dateOfBirth:   m.dateOfBirth ? new Date(m.dateOfBirth) : null,
            status:        m.status,
            tags:          m.tags?.trim() || "",
            notes:         m.notes?.trim() || null,
            streetAddress: m.streetAddress?.trim() || null,
            city:          m.city?.trim() || null,
            state:         m.state?.trim() || null,
            zipCode:       m.zipCode?.trim() || null,
            gender:        m.gender?.trim() || null,
            customFieldValues: "{}",
            isMinor:       m.isMinor,
            guardianId:    guardian?.id ?? null,
            guardianName:  m.guardianName?.trim() || null,
            guardianEmail,
            guardianPhone: m.guardianPhone?.trim() || null,
          },
        });
        results.created++;
      } catch {
        results.failed++;
        results.errors.push(`${m.firstName} ${m.lastName}: failed to save`);
      }
    }

    return NextResponse.json(results, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      // Convert ZodIssue objects to a readable string
      const msg = err.errors
        .map((e) => {
          const field = e.path.length ? `[${e.path.join(".")}] ` : "";
          return `${field}${e.message}`;
        })
        .slice(0, 5)
        .join(" · ");
      return NextResponse.json({ error: `Validation error: ${msg}` }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
