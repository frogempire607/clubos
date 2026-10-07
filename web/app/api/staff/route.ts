import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive, requireOwnerLive, hasPermissionLive, liveUser, invalidatePermissionCache } from "@/lib/apiGuard";
import { accessAboveOwn, accessAboveOwnMessage } from "@/lib/staffAccess";
import { prisma } from "@/lib/prisma";
import { SAFE_USER_SELECT, invitePending } from "@/lib/safeUser";
import { sendStaffInviteEmail } from "@/lib/email";
import { resolvePermissions } from "@/lib/permissions";
import { getAppBaseUrl } from "@/lib/baseUrl";

// Legacy pay columns on StaffProfile. Payroll never reads them, but they are
// still pay: they ride along only for someone who may see pay.
const PAY_FIELDS = ["hourlyRate", "salary", "perSessionRate", "appointmentPrice"] as const;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "staff", "view");
  if (denied) return denied;

  // What this viewer may see BEYOND the directory (name, title, portal bio):
  //   pay fields                      → finances:view
  //   permissions + private phone     → staff:full, or it is their own row
  // Before 2026-10-07 the whole StaffProfile row went to anyone with staff:view.
  const [canSeePay, canManageStaff] = await Promise.all([
    hasPermissionLive(session, "finances", "view"),
    hasPermissionLive(session, "staff", "full"),
  ]);

  const { searchParams } = new URL(req.url);
  const includeOwners = searchParams.get("includeOwners") === "true";
  const staff = await prisma.user.findMany({
    where: {
      clubId: session.user.clubId,
      role: includeOwners ? { in: ["OWNER" as const, "STAFF" as const] } : "STAFF",
      deletedAt: null,
    },
    // Explicit select: never passwordHash / resetToken (see lib/safeUser.ts).
    select: { ...SAFE_USER_SELECT, resetToken: true, staffProfile: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(
    staff.map(({ resetToken, staffProfile, ...u }) => {
      let profile: Record<string, unknown> | null = null;
      if (staffProfile) {
        const { permissions, phone, hourlyRate, salary, perSessionRate, appointmentPrice, ...directory } = staffProfile;
        const own = u.id === session.user.id;
        profile = {
          ...directory,
          ...(canSeePay ? { hourlyRate, salary, perSessionRate, appointmentPrice } : {}),
          ...(canManageStaff || own ? { permissions, phone } : {}),
        };
      }
      return {
        ...u,
        staffProfile: profile,
        invitePending: invitePending({ resetToken, lastLoginAt: u.lastLoginAt }),
      };
    }),
  );
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
  // Account type for the invited user. "OWNER" grants full access (bypasses the
  // permission grid and can reach settings/billing) — this is how a club adds a
  // second owner. Defaults to STAFF.
  accountRole: z.enum(["STAFF", "OWNER"]).optional().default("STAFF"),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "staff", "full");
  if (denied) return denied;

  try {
    const data = inviteSchema.parse(await req.json());
    if (!data.password && !data.sendSetupLink) {
      return NextResponse.json(
        { error: "Provide a password or set sendSetupLink to true." },
        { status: 400 },
      );
    }

    // Only an OWNER can make an OWNER — verified against the database, not the
    // token. Staff & contractors: full still invites STAFF. (Before 2026-10-07
    // any staff:full login could mint a second owner here.)
    if (data.accountRole === "OWNER") {
      const ownerDenied = await requireOwnerLive(session);
      if (ownerDenied) {
        return ownerDenied.status === 403
          ? NextResponse.json({ error: "Only an owner can add another owner.", code: "OWNER_REQUIRED" }, { status: 403 })
          : ownerDenied;
      }
    }
    // No privilege escalation: a non-owner cannot hand a new account more
    // access than they hold themselves (lib/staffAccess.accessAboveOwn).
    const actor = await liveUser(session.user.id);
    const actorIsOwner = !!actor && actor.role === "OWNER";
    if (!actorIsOwner && data.accountRole === "STAFF") {
      const refused = accessAboveOwn(actor?.perms ?? null, null, resolvePermissions(data.permissions ?? null), { newAccount: true });
      if (refused.length) {
        return NextResponse.json({ error: accessAboveOwnMessage(refused), code: "ACCESS_ABOVE_OWN" }, { status: 403 });
      }
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
    // Re-adding a removed STAFF account is a normal manager task. Bringing back
    // an account that was an OWNER (or a member's login) is not — owners only.
    if (existing && existing.role !== "STAFF" && !actorIsOwner) {
      return NextResponse.json(
        { error: "That email belongs to a removed account only an owner can restore.", code: "OWNER_REQUIRED" },
        { status: 403 },
      );
    }

    // Setup-link flow: bcrypt-hash a random, never-shared secret so the
    // account can't be logged into until the staff member sets their own
    // password via the emailed link. resetToken doubles as the invite token.
    const usingSetupLink = !!data.sendSetupLink;
    const effectivePassword = data.password ?? crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(effectivePassword, 12);
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
            role: data.accountRole,
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
            role: data.accountRole,
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

    // A restored account must not be served from a cached "removed" record.
    invalidatePermissionCache(user.id);

    // Email send is fire-and-forget — never block invite creation on it. We
    // also return the setupUrl in the response when applicable so the owner
    // can copy the link from the dashboard even if SMTP is unset or the
    // email lands in spam.
    const baseUrl = getAppBaseUrl();
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

    // The setup link itself is returned on purpose (the inviter can copy it);
    // the raw row's secrets are not.
    const { passwordHash: _ph, resetToken: _rt, resetExpires: _re, ...safeUser } = user as typeof user & {
      passwordHash?: string; resetToken?: string | null; resetExpires?: Date | null;
    };
    void _ph; void _rt; void _re;
    return NextResponse.json(
      { ...safeUser, setupUrl, emailed, emailError },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
