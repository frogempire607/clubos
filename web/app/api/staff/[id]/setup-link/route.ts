import { NextResponse } from "next/server";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
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
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  }

  const staff = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: "STAFF" },
    include: { club: { select: { name: true, slug: true } } },
  });
  if (!staff) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: staff.id },
    data: {
      resetToken,
      resetExpires,
      // Reactivate if the account was soft-deleted; this is what the owner
      // wants when they regenerate a setup link.
      deletedAt: null,
    },
  });

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
