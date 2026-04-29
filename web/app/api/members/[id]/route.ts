import { NextResponse } from "next/server";
import { z } from "zod";
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
});

async function requireMember(memberId: string, clubId: string) {
  return prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
  });
}

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      membership: true,
      subscriptions: { include: { membership: true } },
      transactions: { orderBy: { createdAt: "desc" }, take: 10 },
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
  return NextResponse.json(member);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
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

    const updated = await prisma.member.update({
      where: { id: params.id },
      data: {
        ...data,
        ...guardianIdUpdate,
        guardianEmail: data.guardianEmail !== undefined
          ? (data.guardianEmail ? data.guardianEmail.toLowerCase() : null)
          : undefined,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : data.dateOfBirth === null ? null : undefined,
        customFieldValues: data.customFieldValues ? JSON.stringify(data.customFieldValues) : undefined,
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
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
