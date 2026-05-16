import { NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";
import { DEFAULT_PERMISSIONS } from "@/lib/permissions";
import { sendStaffInviteEmail } from "@/lib/email";

// POST /api/contractors/[id]/invite
// Convert a contractor into a full staff account. Creates the User +
// StaffProfile, links convertedUserId, emails a temp password. Idempotent:
// once converted it returns the existing link.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const clubId = session!.user.clubId;
  const contractor = await prisma.contractor.findFirst({
    where: { id, clubId, deletedAt: null },
  });
  if (!contractor) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (contractor.convertedUserId) {
    return NextResponse.json({ error: "This contractor is already a staff member." }, { status: 409 });
  }
  if (!contractor.email) {
    return NextResponse.json(
      { error: "Add an email to this contractor before converting them to staff." },
      { status: 400 },
    );
  }

  const email = contractor.email.toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { clubId_email: { clubId, email } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A user with this email already exists in your club." },
      { status: 409 },
    );
  }

  const [firstName, ...rest] = contractor.name.trim().split(/\s+/);
  const lastName = rest.join(" ") || "—";
  const tempPassword = crypto.randomBytes(6).toString("base64url");
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const user = await prisma.user.create({
    data: {
      clubId,
      email,
      passwordHash,
      firstName: firstName || contractor.name,
      lastName,
      role: "STAFF",
      staffProfile: {
        create: {
          title: contractor.role || "Contractor",
          permissions: { ...DEFAULT_PERMISSIONS },
        },
      },
    },
  });

  await prisma.contractor.update({
    where: { id },
    data: { convertedUserId: user.id, active: false },
  });

  try {
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
    const inviter = await prisma.user.findUnique({
      where: { id: session!.user.id },
      select: { firstName: true, lastName: true },
    });
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
    await sendStaffInviteEmail({
      to: user.email,
      firstName: user.firstName,
      clubName: club?.name ?? "your club",
      inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : "Your club owner",
      loginUrl: `${baseUrl}/login`,
      tempPassword,
    });
  } catch (e) {
    console.error("Contractor→staff invite email failed:", e);
  }

  return NextResponse.json({ ok: true, userId: user.id });
}
