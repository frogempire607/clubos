import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { MIGRATION_STATUS } from "@/lib/migration";

// GET /api/members/migration/families
// Same-email family detection for the migration tool. Groups imported minors by
// guardian email so the owner can review the grouping and send ONE onboarding
// invite per family. Returns only guardians with 2+ children (real families) by
// default; ?all=1 returns every guardian-managed group.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const includeSingles = new URL(req.url).searchParams.get("all") === "1";

  const members = await prisma.member.findMany({
    where: {
      clubId,
      deletedAt: null,
      isMinor: true,
      guardianEmail: { not: null },
      migrationStatus: { not: null },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      guardianEmail: true,
      guardianName: true,
      migrationStatus: true,
      approvalStatus: true,
      activationEmailSendCount: true,
      legacyMembershipName: true,
      legacyMembershipPrice: true,
      legacyBillingFrequency: true,
    },
    orderBy: [{ guardianEmail: "asc" }, { firstName: "asc" }],
  });

  type Child = (typeof members)[number];
  const groups = new Map<string, { guardianEmail: string; guardianName: string | null; children: Child[] }>();
  for (const m of members) {
    const key = (m.guardianEmail || "").toLowerCase();
    if (!key) continue;
    const g = groups.get(key) ?? { guardianEmail: m.guardianEmail!, guardianName: m.guardianName, children: [] };
    if (!g.guardianName && m.guardianName) g.guardianName = m.guardianName;
    g.children.push(m);
    groups.set(key, g);
  }

  const families = [...groups.values()]
    .filter((g) => includeSingles || g.children.length > 1)
    .map((g) => {
      const pending = g.children.filter(
        (c) => c.migrationStatus !== MIGRATION_STATUS.COMPLETED,
      ).length;
      const completed = g.children.length - pending;
      return {
        guardianEmail: g.guardianEmail,
        guardianName: g.guardianName,
        childCount: g.children.length,
        pendingCount: pending,
        completedCount: completed,
        children: g.children.map((c) => ({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          migrationStatus: c.migrationStatus,
          approvalStatus: c.approvalStatus,
          emailsSent: c.activationEmailSendCount,
          membership: c.legacyMembershipName,
          price: c.legacyMembershipPrice != null ? Number(c.legacyMembershipPrice) : null,
          frequency: c.legacyBillingFrequency,
        })),
      };
    })
    .sort((a, b) => b.childCount - a.childCount);

  return NextResponse.json({
    families,
    familyCount: families.length,
    groupedMembers: families.reduce((a, f) => a + f.childCount, 0),
  });
}
