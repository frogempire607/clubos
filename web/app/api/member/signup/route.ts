import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";

const schema = z.object({
  clubSlug: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  accountType: z.enum(["ADULT_ATHLETE", "MINOR_ATHLETE", "PARENT"]),
  dateOfBirth: z.string().optional(),
  // Guardian info (for MINOR_ATHLETE)
  guardianName: z.string().optional(),
  guardianEmail: z.string().email().optional().or(z.literal("")),
  guardianPhone: z.string().optional(),
  guardianRelationship: z.string().optional(),
  // Parent fields (for PARENT — link to child's member record)
  childEmail: z.string().email().optional().or(z.literal("")),
  relationship: z.string().optional(),
});

export async function POST(req: Request) {
  // 10 member signups per 10 minutes per IP. A family signing up
  // multiple kids in a row is realistic; bot-scripted account creation
  // gets blocked.
  const rl = rateLimit({ key: `auth:member-signup:${ipFromRequest(req)}`, limit: 10, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many signups from this device. Try again in a few minutes.");

  try {
    const data = schema.parse(await req.json());

    const club = await prisma.club.findUnique({ where: { slug: data.clubSlug } });
    if (!club) {
      return NextResponse.json({ error: "Club not found. Check the club URL and try again." }, { status: 404 });
    }

    // Check for existing user account in this club
    const existing = await prisma.user.findUnique({
      where: { clubId_email: { clubId: club.id, email: data.email.toLowerCase() } },
    });
    if (existing && !existing.deletedAt) {
      return NextResponse.json({ error: "An account with this email already exists. Try logging in." }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const isMinor = data.accountType === "MINOR_ATHLETE";

    // Find existing Member record by email (case-insensitive via stored lowercase) to link up
    const existingMember = await prisma.member.findFirst({
      where: { clubId: club.id, email: data.email.toLowerCase(), deletedAt: null },
    });

    // If that Member record is already claimed by a different User, block signup
    if (existingMember?.userId && existingMember.userId !== null) {
      const claimingUser = await prisma.user.findUnique({
        where: { id: existingMember.userId },
        select: { deletedAt: true },
      });
      if (claimingUser && !claimingUser.deletedAt) {
        return NextResponse.json(
          { error: "A portal account for this email is already active. Try logging in instead." },
          { status: 409 }
        );
      }
    }

    const user = await prisma.user.create({
      data: {
        clubId: club.id,
        email: data.email.toLowerCase(),
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        role: "MEMBER",
        ...(existingMember
          ? {
              memberProfile: { connect: { id: existingMember.id } },
            }
          : {
              memberProfile: {
                create: {
                  clubId: club.id,
                  firstName: data.firstName,
                  lastName: data.lastName,
                  email: data.email.toLowerCase(),
                  status: "ACTIVE",
                  isMinor,
                  dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
                  guardianName: data.guardianName || null,
                  guardianEmail: data.guardianEmail || null,
                  guardianPhone: data.guardianPhone || null,
                  guardianRelationship: data.guardianRelationship || null,
                },
              },
            }),
      },
      include: { memberProfile: true },
    });

    // If PARENT — link them as guardian of child member
    if (data.accountType === "PARENT" && data.childEmail) {
      const childMember = await prisma.member.findFirst({
        where: { clubId: club.id, email: data.childEmail.toLowerCase(), deletedAt: null },
      });
      if (childMember) {
        await prisma.memberGuardianUser.upsert({
          where: { userId_memberId: { userId: user.id, memberId: childMember.id } },
          update: { relationship: data.relationship || null },
          create: { userId: user.id, memberId: childMember.id, relationship: data.relationship || null },
        });

        // Also normalize a Guardian profile so this parent's family can hold siblings
        const guardianFullName = `${data.firstName} ${data.lastName}`.trim();
        const guardianEmail = data.email.toLowerCase();
        const guardianProfile = await prisma.guardian.upsert({
          where: { clubId_email: { clubId: club.id, email: guardianEmail } },
          update: {
            firstName: data.firstName,
            lastName: data.lastName,
            userId: user.id,
          },
          create: {
            clubId: club.id,
            firstName: data.firstName,
            lastName: data.lastName,
            email: guardianEmail,
            phone: childMember.guardianPhone || "",
            userId: user.id,
          },
        });
        await prisma.member.update({
          where: { id: childMember.id },
          data: {
            guardianId: guardianProfile.id,
            guardianName: childMember.guardianName || guardianFullName,
            guardianEmail: childMember.guardianEmail || guardianEmail,
          },
        });
      }
    }

    // Update existing member record with profile data if we linked it
    if (existingMember) {
      await prisma.member.update({
        where: { id: existingMember.id },
        data: {
          isMinor,
          guardianName: data.guardianName || existingMember.guardianName,
          guardianEmail: data.guardianEmail || existingMember.guardianEmail,
          guardianPhone: data.guardianPhone || existingMember.guardianPhone,
          guardianRelationship: data.guardianRelationship || existingMember.guardianRelationship,
        },
      });
    }

    return NextResponse.json({ ok: true, clubSlug: club.slug }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
