import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { upsertGuardianProfile } from "@/lib/guardian";

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
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
  // Parental controls (P4). Boolean convenience for the lock: true =>
  // birthdayLockedAt set to now, false/null => cleared. parentControls
  // is the JSON toggle bag stored on Member as-is (null clears).
  birthdayLocked: z.boolean().optional(),
  parentControls: z
    .object({
      requirePaymentApproval: z.boolean().optional(),
      monitoredMessaging:     z.boolean().optional(),
      allowPackagePurchase:   z.boolean().optional(),
      dailySpendLimit:        z.number().nonnegative().optional(),
    })
    .nullable()
    .optional(),
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

    // If marking as a minor, validate required guardian fields per spec
    const willBeMinor = data.isMinor ?? member.isMinor;
    if (willBeMinor && (data.isMinor !== undefined || data.guardianName !== undefined || data.guardianEmail !== undefined || data.guardianPhone !== undefined)) {
      const guardianName = data.guardianName ?? member.guardianName;
      const guardianEmail = data.guardianEmail ?? member.guardianEmail;
      const guardianPhone = data.guardianPhone ?? member.guardianPhone;
      if (!guardianName?.trim()) {
        return NextResponse.json({ error: "Guardian name is required for minors." }, { status: 400 });
      }
      if (!guardianEmail?.trim()) {
        return NextResponse.json({ error: "Guardian email is required for minors." }, { status: 400 });
      }
      if (!guardianPhone?.trim()) {
        return NextResponse.json({ error: "Guardian phone is required for minors." }, { status: 400 });
      }
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

    // Strip the parental-control fields from the generic spread — we
    // translate them into prisma-shaped values below. Keeps the spread
    // safe from accidentally writing `birthdayLocked` (the bool) as a
    // column (which doesn't exist).
    const { birthdayLocked, parentControls, ...rest } = data;

    // Use UncheckedUpdateInput so we can write the FK column `guardianId`
    // directly via guardianIdUpdate (the relations-checked variant would
    // demand `guardian: { connect: ... }`). This was implicit before;
    // making it explicit silences the TS overload pick error introduced
    // by adding the JSON `parentControls` field.
    const updateData: Prisma.MemberUncheckedUpdateInput = {
      ...rest,
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
      ...guardianIdUpdate,
      guardianEmail: data.guardianEmail !== undefined
        ? (data.guardianEmail ? data.guardianEmail.toLowerCase() : null)
        : undefined,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : data.dateOfBirth === null ? null : undefined,
      customFieldValues: data.customFieldValues ? JSON.stringify(data.customFieldValues) : undefined,
      // P4 parental controls. Owner sets/clears the lock; parentControls
      // is stored as JSON so future toggles don't need a migration.
      // Prisma.JsonNull is the literal-null sentinel for JSONB fields.
      ...(birthdayLocked !== undefined
        ? { birthdayLockedAt: birthdayLocked ? new Date() : null }
        : {}),
      ...(parentControls !== undefined
        ? {
            parentControls:
              parentControls === null ? Prisma.JsonNull : (parentControls as Prisma.InputJsonValue),
          }
        : {}),
    };

    const updated = await prisma.member.update({
      where: { id: params.id },
      data: updateData,
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.flatten() }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await requireMember(params.id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.member.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
