import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { upsertGuardianProfile } from "@/lib/guardian";
import { deleteOrphanedMemberLogins } from "@/lib/memberLink";
import { validateMemberContact } from "@/lib/memberValidation";
import { resolveIsMinor } from "@/lib/parentalConsent";

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  // Accept null/"" so a minor (or anyone) without their own email can be saved.
  // A bare z.string().email().optional() rejected null → "Expected string,
  // received null" when editing a minor with no email on file.
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().optional().nullable(),
  dateOfBirth: z.string().optional().nullable(),
  status: z.enum(["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"]).optional(),
  tags: z.string().optional(),
  notes: z.string().optional().nullable(),
  customFieldValues: z.record(z.string()).optional(),
  streetAddress: z.string().optional().nullable(),
  city:          z.string().optional().nullable(),
  state:         z.string().optional().nullable(),
  zipCode:       z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  isMinor: z.boolean().optional(),
  guardianName: z.string().optional().nullable(),
  guardianEmail: z.string().email().optional().nullable().or(z.literal("")),
  guardianPhone: z.string().optional().nullable(),
  guardianRelationship: z.string().optional().nullable(),
  profileImageUrl: z.string().optional().nullable(),
  // P4 correction — birthdayLocked + parentControls are NOT editable
  // from this owner endpoint. Guardian-only via
  // /api/member/family/[memberId]/controls. Stripped from the schema
  // so an owner client sending them just gets a Zod "unrecognized"
  // 400 instead of a silent override.
});

async function requireMember(memberId: string, clubId: string) {
  return prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
  });
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      membership: true,
      subscriptions: {
        include: { membership: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
      transactions: { orderBy: { createdAt: "desc" }, take: 25 },
      bookings: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          event: { select: { id: true, name: true, type: true, startsAt: true, endsAt: true } },
        },
      },
      attendanceRecords: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          classSession: {
            select: {
              startsAt: true,
              recurringClass: { select: { name: true } },
            },
          },
        },
      },
      eventRegistrations: {
        orderBy: { createdAt: "desc" },
        take: 25,
        include: { event: { select: { id: true, name: true, startsAt: true } } },
      },
      relationshipsFrom: {
        include: { related: { select: { id: true, firstName: true, lastName: true, status: true } } },
      },
      relationshipsTo: {
        include: { member: { select: { id: true, firstName: true, lastName: true, status: true } } },
      },
      guardian: {
        include: {
          members: {
            where: { deletedAt: null, NOT: { id: params.id } },
            select: { id: true, firstName: true, lastName: true, isMinor: true, status: true },
          },
        },
      },
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Flatten relationships into one directionless list for the UI. Types are
  // stored from the `member` side; invert the asymmetric ones when this member
  // is on the `related` side so the label reads correctly.
  const invert: Record<string, string> = { PARENT: "CHILD", CHILD: "PARENT" };
  const relationships = [
    ...member.relationshipsFrom.map((r) => ({ id: r.id, type: r.type, note: r.note, other: r.related })),
    ...member.relationshipsTo.map((r) => ({ id: r.id, type: invert[r.type] ?? r.type, note: r.note, other: r.member })),
  ];
  const { relationshipsFrom: _f, relationshipsTo: _t, ...rest } = member;
  void _f; void _t;
  return NextResponse.json({ ...rest, relationships });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await requireMember(params.id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const data = updateSchema.parse(body);

    // P4 — owner cannot edit DOB on a parent-locked member.
    // The lock is set by the guardian from /member/family/[memberId];
    // owners only see the status on the edit modal. If the owner ever
    // genuinely needs to override (legal name correction, etc.) the
    // guardian has to unlock first OR a separate explicit admin
    // override flow with audit trail handles it — not this surface.
    if (data.dateOfBirth !== undefined && member.birthdayLockedAt) {
      const incoming = data.dateOfBirth ? new Date(data.dateOfBirth).getTime() : null;
      const current = member.dateOfBirth ? member.dateOfBirth.getTime() : null;
      if (incoming !== current) {
        return NextResponse.json(
          {
            error:
              "Parent-confirmed DOB is locked for athlete safety and eligibility integrity. The guardian must unlock from their family controls first.",
            code: "BIRTHDAY_LOCKED",
          },
          { status: 403 },
        );
      }
    }

    // (P4 — owners no longer set the lock from here; the schema
    // already excludes birthdayLocked/parentControls so any stray field
    // from an old client just gets stripped by Zod's default behavior.)

    // If marking as a minor, validate required guardian fields per spec.
    // If marking as an adult, require at least one direct contact method.
    // COPPA: date of birth is authoritative. If the effective DOB is under 18,
    // the member IS a minor no matter what isMinor was set to — an owner can't
    // clear the flag on a real child to dodge the parental-consent gate.
    const effectiveDob = data.dateOfBirth !== undefined ? data.dateOfBirth : member.dateOfBirth;
    const willBeMinor = resolveIsMinor({ isMinor: data.isMinor ?? member.isMinor, dateOfBirth: effectiveDob });
    const contactError = validateMemberContact({
      isMinor: willBeMinor,
      email: data.email ?? member.email,
      phone: data.phone ?? member.phone,
      guardianName: data.guardianName ?? member.guardianName,
      guardianEmail: data.guardianEmail ?? member.guardianEmail,
    });
    if (contactError) {
      return NextResponse.json({ error: contactError }, { status: 400 });
    }

    // Upsert/relink guardian profile when guardian fields change
    let guardianIdUpdate: { guardianId?: string | null } = {};
    if (data.guardianName !== undefined || data.guardianEmail !== undefined || data.guardianPhone !== undefined || data.isMinor !== undefined) {
      const effectiveEmail = data.guardianEmail ?? member.guardianEmail;
      if (effectiveEmail) {
        const guardian = await upsertGuardianProfile(session.user.clubId, {
          guardianName: data.guardianName ?? member.guardianName,
          guardianEmail: effectiveEmail,
          guardianPhone: data.guardianPhone ?? member.guardianPhone,
        });
        guardianIdUpdate = { guardianId: guardian?.id ?? null };
      } else {
        guardianIdUpdate = { guardianId: null };
      }
    }

    // Only allow ACTIVE if the member has at least one active subscription.
    // Otherwise coerce to PROSPECT so status stays consistent with billing.
    let nextStatus = data.status;
    if (nextStatus === "ACTIVE") {
      const activeSub = await prisma.memberSubscription.count({
        where: { memberId: params.id, status: "active" },
      });
      if (activeSub === 0) nextStatus = "PROSPECT";
    }

    // Use UncheckedUpdateInput so we can write the FK column `guardianId`
    // directly via guardianIdUpdate (the relations-checked variant would
    // demand `guardian: { connect: ... }`).
    const updateData: Prisma.MemberUncheckedUpdateInput = {
      ...data,
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
      ...guardianIdUpdate,
      // Persist the DOB-authoritative minor status (see willBeMinor above).
      isMinor: willBeMinor,
      email: data.email !== undefined
        ? (data.email ? data.email.toLowerCase() : null)
        : undefined,
      guardianEmail: data.guardianEmail !== undefined
        ? (data.guardianEmail ? data.guardianEmail.toLowerCase() : null)
        : undefined,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : data.dateOfBirth === null ? null : undefined,
      customFieldValues: data.customFieldValues ? JSON.stringify(data.customFieldValues) : undefined,
    };

    const updated = await prisma.member.update({
      where: { id: params.id },
      data: updateData,
    });

    // Owner-vouched guardian link (same as the create path): when a minor has a
    // guardian email matching an existing portal account, link them so the child
    // shows in that guardian's portal immediately.
    if (updated.isMinor && updated.guardianEmail) {
      const guardianUser = await prisma.user.findFirst({
        where: { clubId: session.user.clubId, email: updated.guardianEmail, deletedAt: null },
        select: { id: true },
      });
      if (guardianUser) {
        await prisma.memberGuardianUser.upsert({
          where: { userId_memberId: { userId: guardianUser.id, memberId: updated.id } },
          update: {},
          create: {
            userId: guardianUser.id,
            memberId: updated.id,
            relationship: updated.guardianRelationship || null,
          },
        });
      }
    }

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.flatten() }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Members access can delete — not owner-only.
  const denied = requirePermission(session, "members", "full");
  if (denied) return denied;

  const member = await requireMember(params.id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Release the unique members_userId slot on delete (the index is global and
  // ignores deletedAt) so the same person can be re-imported / re-activated
  // later without colliding with this dead row.
  await prisma.member.update({
    where: { id: params.id },
    data: { deletedAt: new Date(), userId: null },
  });

  // Also remove this member's own login so they can no longer sign in — unless
  // that account is shared (a guardian of another live member) or is owner/staff.
  await deleteOrphanedMemberLogins([member.userId], session.user.clubId);

  return NextResponse.json({ ok: true });
}
