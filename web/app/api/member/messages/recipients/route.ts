import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { memberCanMessage } from "@/lib/parentalControls";

// GET /api/member/messages/recipients
// Coaches/owners a member can start a conversation with. (Members can already
// DM staff/owners; this just gives the composer a list to pick from.)
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json({ recipients: [] });
  }

  const staff = await prisma.user.findMany({
    where: { clubId: session.user.clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      staffProfile: { select: { title: true } },
    },
    orderBy: [{ role: "asc" }, { firstName: "asc" }],
  });

  return NextResponse.json({
    recipients: staff.map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      role: s.role,
      title: s.staffProfile?.title ?? null,
    })),
  });
}
