import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
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
  // Either provide a temp password (legacy flow) OR set sendSetupLink=true
  // and we'll email a setup link the staff member uses to choose their
  // own password. At least one of the two is required at runtime.
  password: z.string().min(8).optional(),
  sendSetupLink: z.boolean().optional(),
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
    if (!data.password && !data.sendSetupLink) {
      return NextResponse.json(
        { error: "Provide a password or set sendSetupLink to true." },
        { status: 400 },
      );
    }

    // Soft-deleted accounts keep the (clubId, email) row in place because of
    // the unique index. If the owner deletes a coach and then tries to re-add
    // them, we want to RESURRECT the existing user instead of failing with
    // "Email already registered." Active duplicates still 409.
    const existing = await prisma.user.findUnique({
      where: { clubId_email: { clubId: session.user.clubId, email: data.email.toLowerCase() } },
      include: { staffProfile: true },
    });
    if (existing && !existing.deletedAt) {
      return NextResponse.json({ error: "Email already registered in this club" }, { status: 409 });
    }

    // Setup-link flow: bcrypt-hash a random, never-shared secret so the
    // account can't be logged into until the staff member sets their own
    // password via the emailed link. resetToken doubles as the invite token.
    const usingSetupLink = !!data.sendSetupLink;
    const effectivePassword = data.password ?? crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(effectivePassword, 10);
    const resetToken = usingSetupLink ? crypto.randomBytes(32).toString("hex") : null;
    const resetExpires = usingSetupLink
      ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 14 days
      : null;
    const defaultPermissions = resolvePermissions(data.permissions ?? null);

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            deletedAt: null,
            firstName: data.firstName,
            lastName: data.lastName,
            role: "STAFF",
            passwordHash,
            resetToken,
            resetExpires,
            staffProfile: existing.staffProfile
              ? {
                  update: {
                    title: data.title || null,
                    permissions: defaultPermissions,
                  },
                }
              : {
                  create: {
                    title: data.title || null,
                    permissions: defaultPermissions,
                  },
                },
          },
          include: { staffProfile: true },
        })
      : await prisma.user.create({
          data: {
            clubId: session.user.clubId,
            email: data.email.toLowerCase(),
            passwordHash,
            firstName: data.firstName,
            lastName: data.lastName,
            role: "STAFF",
            resetToken,
            resetExpires,
            staffProfile: {
              create: {
                title: data.title || null,
                permissions: defaultPermissions,
              },
            },
          },
          include: { staffProfile: true },
        });

    // Email send is fire-and-forget — never block invite creation on it. We
    // also return the setupUrl in the response when applicable so the owner
    // can copy the link from the dashboard even if SMTP is unset or the
    // email lands in spam.
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { name: true, slug: true },
    });
    const setupUrl = usingSetupLink && resetToken
      ? `${baseUrl}/setup?token=${resetToken}&club=${encodeURIComponent(club?.slug ?? "")}`
      : null;
    let emailed = false;
    let emailError: string | null = null;
    try {
      const inviter = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true },
      });
      await sendStaffInviteEmail({
        to: user.email,
        firstName: user.firstName,
        clubName: club?.name ?? "your club",
        inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : "Your club owner",
        loginUrl: `${baseUrl}/login`,
        tempPassword: usingSetupLink ? undefined : data.password,
        setupUrl: setupUrl ?? undefined,
      });
      emailed = true;
    } catch (emailErr) {
      emailError = emailErr instanceof Error ? emailErr.message : String(emailErr);
      console.error("Staff invite email failed:", emailErr);
    }

    return NextResponse.json(
      { ...user, setupUrl, emailed, emailError },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
