import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";
import { upsertGuardianProfile } from "@/lib/guardian";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const guardianEmail = url.searchParams.get("guardianEmail");

  const members = await prisma.member.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      ...(guardianEmail
        ? {
            OR: [
              { guardianEmail: guardianEmail.toLowerCase() },
              { guardian: { email: guardianEmail.toLowerCase() } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      membership: { select: { name: true } },
      subscriptions: {
        where: { status: { in: ["active", "past_due"] } },
        include: { membership: { select: { name: true } } },
      },
      guardian: true,
    },
  });

  return NextResponse.json(members);
}

const createSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().optional().nullable(),
  dateOfBirth: z.string().optional(),
  status: z.enum(["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"]).default("PROSPECT"),
  tags: z.string().optional(),
  notes: z.string().optional(),
  streetAddress: z.string().optional().nullable(),
  city:          z.string().optional().nullable(),
  state:         z.string().optional().nullable(),
  zipCode:       z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  customFieldValues: z.record(z.string()).optional(),
  isMinor: z.boolean().default(false),
  guardianName: z.string().optional(),
  guardianEmail: z.string().email().optional().or(z.literal("")),
  guardianPhone: z.string().optional(),
  guardianRelationship: z.string().optional(),
  profileImageUrl: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    // ── Tier gating: Starter plan caps at 150 members ──────────────────────
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { tier: true },
    });
    const features = getTierFeatures(club?.tier ?? "starter");
    if (features.maxMembers !== null) {
      const count = await prisma.member.count({
        where: { clubId: session.user.clubId, deletedAt: null },
      });
      if (count >= features.maxMembers) {
        return NextResponse.json(
          {
            error: `Your Starter plan allows up to ${features.maxMembers} members. Upgrade to Growth for unlimited members.`,
            code: "MEMBER_LIMIT_REACHED",
            upgradeRequired: "growth",
          },
          { status: 403 }
        );
      }
    }

    // Prevent duplicate Member records with the same email in the same club
    if (data.email) {
      const emailConflict = await prisma.member.findFirst({
        where: {
          clubId: session.user.clubId,
          email: data.email.toLowerCase(),
          deletedAt: null,
        },
      });
      if (emailConflict) {
        return NextResponse.json(
          { error: `A member with email ${data.email} already exists in this club.` },
          { status: 409 }
        );
      }
    }

    // Validate minor required fields per spec
    if (data.isMinor) {
      if (!data.guardianName?.trim()) {
        return NextResponse.json({ error: "Guardian name is required for minors." }, { status: 400 });
      }
      if (!data.guardianEmail?.trim()) {
        return NextResponse.json({ error: "Guardian email is required for minors." }, { status: 400 });
      }
      if (!data.guardianPhone?.trim()) {
        return NextResponse.json({ error: "Guardian phone is required for minors." }, { status: 400 });
      }
    }

    // Upsert Guardian profile when guardian info is provided (always for minors,
    // optional for adults). Siblings sharing the same guardian email link to the
    // same Guardian profile.
    const guardian = await upsertGuardianProfile(session.user.clubId, {
      guardianName: data.guardianName,
      guardianEmail: data.guardianEmail,
      guardianPhone: data.guardianPhone,
    });

    // A brand-new member can't yet have an active subscription, so we never
    // create them as ACTIVE. They become ACTIVE later via the Stripe webhook
    // (or manual subscription assignment) once a subscription kicks in.
    const initialStatus = data.status === "ACTIVE" ? "PROSPECT" : data.status;

    const member = await prisma.member.create({
      data: {
        clubId: session.user.clubId,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email ? data.email.toLowerCase() : null,
        phone: data.phone || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        status: initialStatus,
        tags: data.tags || "",
        notes: data.notes || null,
        streetAddress: data.streetAddress || null,
        city:          data.city || null,
        state:         data.state || null,
        zipCode:       data.zipCode || null,
        gender: data.gender || null,
        customFieldValues: JSON.stringify(data.customFieldValues || {}),
        isMinor: data.isMinor,
        guardianId: guardian?.id ?? null,
        guardianName: data.guardianName || null,
        guardianEmail: data.guardianEmail ? data.guardianEmail.toLowerCase() : null,
        guardianPhone: data.guardianPhone || null,
        guardianRelationship: data.guardianRelationship || null,
        profileImageUrl: data.profileImageUrl || null,
      },
    });

    return NextResponse.json(member, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.flatten() }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
