import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendStaffInviteEmail } from "@/lib/email";
import { resolvePermissions } from "@/lib/permissions";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const includeOwners = searchParams.get("includeOwners") === "true";
  const staff = await prisma.user.findMany({
    where: {
      clubId: session.user.clubId,
      role: includeOwners ? { in: ["OWNER" as const, "STAFF" as const] } : "STAFF",
      deletedAt: null,
    },
    include: { staffProfile: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(staff);
}

const permissionLevel = z.enum(["none", "view", "edit", "full", "send"]);

const inviteSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  title: z.string().optional(),
  // Accept any subset of permission keys; resolvePermissions normalizes and
  // fills defaults so the editor can evolve without schema churn.
  permissions: z.record(z.string(), permissionLevel).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = inviteSchema.parse(await req.json());

    const existing = await prisma.user.findUnique({
      where: { clubId_email: { clubId: session.user.clubId, email: data.email.toLowerCase() } },
    });
    if (existing) {
      return NextResponse.json({ error: "Email already registered in this club" }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const defaultPermissions = resolvePermissions(data.permissions ?? null);

    const user = await prisma.user.create({
      data: {
        clubId: session.user.clubId,
        email: data.email.toLowerCase(),
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        role: "STAFF",
        staffProfile: {
          create: {
            title: data.title || null,
            permissions: defaultPermissions,
          },
        },
      },
      include: { staffProfile: true },
    });

    // Fire-and-forget welcome email. Don't block on failure — invite is created either way.
    try {
      const club = await prisma.club.findUnique({
        where: { id: session.user.clubId },
        select: { name: true },
      });
      const inviter = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true },
      });
      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
      await sendStaffInviteEmail({
        to: user.email,
        firstName: user.firstName,
        clubName: club?.name ?? "your club",
        inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : "Your club owner",
        loginUrl: `${baseUrl}/login`,
        tempPassword: data.password,
      });
    } catch (emailErr) {
      console.error("Staff invite email failed:", emailErr);
    }

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
