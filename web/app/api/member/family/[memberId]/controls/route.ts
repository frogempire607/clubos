import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Parent-controls API. Scoped to GUARDIAN sessions only — the parent
// opens it for one of their linked minor children. We never let a
// minor edit their own controls (that would defeat the point).
//
// Guardian check: load the signed-in user's `guardianOf` relation
// (MemberGuardianUser rows) and confirm the requested memberId is
// among them. Mirrors the same pattern /api/member/documents uses.

async function loadGuardianChild(userId: string, memberId: string, clubId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      guardianOf: {
        select: {
          member: {
            select: {
              id: true,
              clubId: true,
              firstName: true,
              lastName: true,
              isMinor: true,
              birthdayLockedAt: true,
              parentControls: true,
              dateOfBirth: true,
            },
          },
        },
      },
    },
  });
  if (!viewer) return null;
  const link = viewer.guardianOf.find((g) => g.member.id === memberId);
  if (!link) return null;
  if (link.member.clubId !== clubId) return null;
  return link.member;
}

// GET /api/member/family/[memberId]/controls
//   Returns the child's parental-control state for the parent to render.
export async function GET(_req: Request, context: { params: Promise<{ memberId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const child = await loadGuardianChild(session.user.id, params.memberId, session.user.clubId);
  if (!child) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  return NextResponse.json({
    member: {
      id: child.id,
      firstName: child.firstName,
      lastName: child.lastName,
      isMinor: child.isMinor,
      dateOfBirth: child.dateOfBirth,
    },
    birthdayLockedAt: child.birthdayLockedAt,
    parentControls: child.parentControls ?? null,
  });
}

const patchSchema = z.object({
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

// PATCH /api/member/family/[memberId]/controls
//   Update the child's parental-control state. Same guardian gate as GET.
export async function PATCH(req: Request, context: { params: Promise<{ memberId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const child = await loadGuardianChild(session.user.id, params.memberId, session.user.clubId);
  if (!child) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  try {
    const data = patchSchema.parse(await req.json());

    const update: Prisma.MemberUncheckedUpdateInput = {};
    if (data.birthdayLocked !== undefined) {
      update.birthdayLockedAt = data.birthdayLocked ? new Date() : null;
    }
    if (data.parentControls !== undefined) {
      update.parentControls =
        data.parentControls === null
          ? Prisma.JsonNull
          : (data.parentControls as Prisma.InputJsonValue);
    }

    await prisma.member.update({
      where: { id: child.id },
      data: update,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
