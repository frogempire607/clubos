import { NextResponse } from "next/server";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive, requireOwnerLive, isOwnerLive, liveUser, invalidatePermissionCache } from "@/lib/apiGuard";
import { accessAboveOwn } from "@/lib/staffAccess";
import { prisma } from "@/lib/prisma";
import { sendStaffInviteEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

// POST /api/staff/[id]/setup-link — owner regenerates a one-time setup link
// for a staff member. Useful when:
//   - The original invite email never arrived (SMTP unset, spam, typo).
//   - The link expired (14 days) and the staff member never finished setup.
//   - The owner forgot the temp password and wants to reset cleanly.
//
// Response always includes the absolute setupUrl so the owner can copy it
// out of the dashboard and hand it over manually, even when email is broken.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "staff", "full");
  if (denied) return denied;

  const staff = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: { in: ["STAFF", "OWNER"] } },
    include: { club: { select: { name: true, slug: true } }, staffProfile: { select: { permissions: true } } },
  });
  if (!staff) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A setup link IS the account: whoever holds it chooses the password. So the
  // caller must be allowed to hold that account's access (2026-10-07):
  //   - an OWNER's link            → only an owner, verified live. Never returned
  //                                  or emailed on a non-owner's request.
  //   - a REMOVED account          → only an owner may bring it back. A non-owner
  //                                  is refused and the account stays removed
  //                                  (this route used to un-delete as a side effect).
  //   - a STAFF account with MORE access than the caller → only an owner
  //                                  (otherwise the link is a privilege escalation).
  const callerIsOwner = await isOwnerLive(session);
  if (staff.role === "OWNER") {
    const ownerDenied = await requireOwnerLive(session);
    if (ownerDenied) {
      return ownerDenied.status === 403
        ? NextResponse.json({ error: "Only an owner can create a setup link for an owner.", code: "OWNER_REQUIRED" }, { status: 403 })
        : ownerDenied;
    }
  } else if (!callerIsOwner) {
    if (staff.deletedAt) {
      return NextResponse.json(
        { error: "This person was removed from staff. Only an owner can restore the account.", code: "OWNER_REQUIRED" },
        { status: 403 },
      );
    }
    const me = await liveUser(session.user.id);
    const above = accessAboveOwn(me?.perms ?? null, null, (staff.staffProfile?.permissions ?? null) as Record<string, unknown> | null, { newAccount: true });
    if (above.length) {
      return NextResponse.json(
        { error: "This person has more access than you do, so only an owner can create their setup link.", code: "OWNER_REQUIRED" },
        { status: 403 },
      );
    }
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: staff.id },
    data: {
      resetToken,
      resetExpires,
      // Reactivate a soft-deleted account — OWNER callers only (checked above);
      // for anyone else the account was not deleted, so this is a no-op.
      ...(callerIsOwner ? { deletedAt: null } : {}),
    },
  });
  invalidatePermissionCache(staff.id);

  const baseUrl = getAppBaseUrl();
  const setupUrl = `${baseUrl}/setup?token=${resetToken}&club=${encodeURIComponent(staff.club.slug)}`;

  // Try to email it too. Failure is non-fatal — the owner has the URL.
  let emailed = false;
  let emailError: string | null = null;
  try {
    const inviter = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { firstName: true, lastName: true },
    });
    await sendStaffInviteEmail({
      to: staff.email,
      firstName: staff.firstName,
      clubName: staff.club.name,
      inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : "Your club owner",
      loginUrl: `${baseUrl}/login`,
      setupUrl,
    });
    emailed = true;
  } catch (err) {
    emailError = err instanceof Error ? err.message : String(err);
    console.error("Resend staff setup email failed:", err);
  }

  return NextResponse.json({
    ok: true,
    setupUrl,
    expiresAt: resetExpires.toISOString(),
    emailed,
    emailError,
  });
}
