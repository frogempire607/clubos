import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Self-service member-portal profile for OWNER and STAFF.
//
// Why this exists (#10): the member portal already lists OWNER + STAFF who have
// a StaffProfile with showOnPortal=true (see /api/member/staff). Staff get a
// StaffProfile when the owner adds them, but an OWNER has no StaffProfile by
// default and the owner-managed /api/staff/[id] route only edits role=STAFF —
// so an owner could never publish their own bio. This endpoint upserts the
// CALLER's own StaffProfile portal fields, so owners (and staff) can opt
// themselves in. It only touches public portal fields — never pay/permissions.

const PORTAL_SELECT = {
  bio: true,
  publicEmail: true,
  publicPhone: true,
  photoUrl: true,
  showOnPortal: true,
} as const;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role === "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sp = await prisma.staffProfile.findUnique({
    where: { userId: session.user.id },
    select: PORTAL_SELECT,
  });
  return NextResponse.json(
    sp ?? { bio: null, publicEmail: null, publicPhone: null, photoUrl: null, showOnPortal: false },
  );
}

const schema = z.object({
  bio: z.string().max(2000).nullable().optional(),
  publicEmail: z.string().max(200).nullable().optional(),
  publicPhone: z.string().max(50).nullable().optional(),
  photoUrl: z.string().max(2000).nullable().optional(),
  showOnPortal: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role === "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = schema.parse(await req.json());
    const data = {
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      ...(body.publicEmail !== undefined ? { publicEmail: body.publicEmail } : {}),
      ...(body.publicPhone !== undefined ? { publicPhone: body.publicPhone } : {}),
      ...(body.photoUrl !== undefined ? { photoUrl: body.photoUrl } : {}),
      ...(body.showOnPortal !== undefined ? { showOnPortal: body.showOnPortal } : {}),
    };
    const sp = await prisma.staffProfile.upsert({
      where: { userId: session.user.id },
      create: { userId: session.user.id, ...data },
      update: data,
      select: PORTAL_SELECT,
    });
    return NextResponse.json(sp);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}
