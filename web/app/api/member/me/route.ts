import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/me — current user + member profile
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      memberProfile: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
          streetAddress: true,
          city: true,
          state: true,
          zipCode: true,
          isMinor: true,
          guardianName: true,
          guardianEmail: true,
          guardianPhone: true,
          guardianRelationship: true,
          profileImageUrl: true,
          status: true,
          stripeCustomerId: true,
          // Parental controls (P4). UI uses these to disable the DOB
          // input when locked, and to render the per-control summary on
          // the member profile when a guardian has set restrictions.
          birthdayLockedAt: true,
          parentControls: true,
        },
      },
    },
  });

  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(user);
}

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName:  z.string().min(1).optional(),
  email:     z.string().email().optional().or(z.literal("")),
  phone:     z.string().optional().nullable(),
  dateOfBirth: z.string().optional().nullable(),
  gender:    z.string().optional().nullable(),
  streetAddress: z.string().optional().nullable(),
  city:          z.string().optional().nullable(),
  state:         z.string().optional().nullable(),
  zipCode:       z.string().optional().nullable(),
  profileImageUrl: z.string().optional().nullable(),
});

// PATCH /api/member/me — edit own profile (member-only fields, no role/status changes)
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = updateSchema.parse(await req.json());

    // Update both User and Member sides where applicable
    const userUpdates: Record<string, unknown> = {};
    if (data.firstName !== undefined) userUpdates.firstName = data.firstName;
    if (data.lastName  !== undefined) userUpdates.lastName  = data.lastName;
    if (data.email     !== undefined && data.email !== "") userUpdates.email = data.email.toLowerCase();

    if (Object.keys(userUpdates).length > 0) {
      await prisma.user.update({ where: { id: session.user.id }, data: userUpdates });
    }

    const member = await prisma.member.findFirst({
      where: { userId: session.user.id, clubId: session.user.clubId, deletedAt: null },
    });
    if (member) {
      // Parental control: when birthdayLockedAt is set, the member can't
      // change their own DOB. Only owner/staff (via /api/members/[id])
      // can update it, and they clear the lock as part of that flow.
      // Allow a no-op DOB (same value) to pass through so unrelated edits
      // don't accidentally trip this check.
      if (data.dateOfBirth !== undefined && member.birthdayLockedAt) {
        const incoming = data.dateOfBirth ? new Date(data.dateOfBirth).getTime() : null;
        const current  = member.dateOfBirth ? member.dateOfBirth.getTime() : null;
        if (incoming !== current) {
          return NextResponse.json(
            {
              error:
                "Your date of birth is locked by your guardian. Ask them to update it for you.",
              code: "BIRTHDAY_LOCKED",
            },
            { status: 403 },
          );
        }
      }
      await prisma.member.update({
        where: { id: member.id },
        data: {
          ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
          ...(data.lastName  !== undefined ? { lastName:  data.lastName  } : {}),
          ...(data.email     !== undefined ? { email: data.email ? data.email.toLowerCase() : null } : {}),
          ...(data.phone     !== undefined ? { phone: data.phone || null } : {}),
          ...(data.dateOfBirth !== undefined ? { dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null } : {}),
          ...(data.gender    !== undefined ? { gender: data.gender || null } : {}),
          ...(data.streetAddress !== undefined ? { streetAddress: data.streetAddress || null } : {}),
          ...(data.city          !== undefined ? { city:          data.city          || null } : {}),
          ...(data.state         !== undefined ? { state:         data.state         || null } : {}),
          ...(data.zipCode       !== undefined ? { zipCode:       data.zipCode       || null } : {}),
          ...(data.profileImageUrl !== undefined ? { profileImageUrl: data.profileImageUrl || null } : {}),
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.flatten() }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/member/me — soft-delete the user + member profile
export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: session.user.id }, data: { deletedAt: now } });
    await tx.member.updateMany({
      where: { userId: session.user.id, deletedAt: null },
      data:  { deletedAt: now },
    });
  });

  return NextResponse.json({ ok: true });
}
