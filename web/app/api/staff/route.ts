import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
  permissions: z.object({
    members: permissionLevel.default("view"),
    events: permissionLevel.default("view"),
    messages: permissionLevel.default("send"),
    finances: permissionLevel.default("none"),
    documents: permissionLevel.default("view"),
    staff: permissionLevel.default("none"),
  }).optional(),
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
    const defaultPermissions = {
      members: "view",
      events: "view",
      messages: "send",
      finances: "none",
      documents: "view",
      staff: "none",
      ...data.permissions,
    };

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

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
