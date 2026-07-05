import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { exportResponse, parseExportFormat, isAdvancedExport } from "@/lib/exporters";
import { getTierFeatures } from "@/lib/tier";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const format = parseExportFormat(url);
  const ids = url.searchParams.get("ids")?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];

  if (isAdvancedExport(format)) {
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { tier: true },
    });
    const features = getTierFeatures(club?.tier ?? "growth");
    if (!features.advancedAnalytics) {
      return new Response(
        "Excel and PDF exports are available on Pro and Enterprise plans. Use CSV instead, or upgrade.",
        { status: 403 },
      );
    }
  }

  const members = await prisma.member.findMany({
    where: { clubId: session.user.clubId, deletedAt: null, ...(ids.length ? { id: { in: ids } } : {}) },
    include: {
      membership: { select: { name: true } },
      subscriptions: { where: { status: "active" }, select: { optionLabel: true } },
      guardian: { select: { firstName: true, lastName: true, email: true, phone: true } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const headers = [
    "First Name", "Last Name", "Email", "Phone", "Status", "Membership",
    "Date of Birth", "Gender", "Street Address", "City", "State", "Zip Code",
    "Tags", "Is Minor", "Guardian Name", "Guardian Email", "Guardian Phone",
    "Guardian Relationship", "Joined At", "Notes",
  ];

  const rows = members.map((m) => {
    const guardianFullName =
      m.guardian ? `${m.guardian.firstName} ${m.guardian.lastName}`.trim() : "";
    return [
      m.firstName,
      m.lastName,
      m.email ?? "",
      m.phone ?? "",
      m.status,
      m.membership?.name ?? "",
      m.dateOfBirth ? m.dateOfBirth.toISOString().split("T")[0] : "",
      m.gender ?? "",
      m.streetAddress ?? "",
      m.city ?? "",
      m.state ?? "",
      m.zipCode ?? "",
      m.tags,
      m.isMinor ? "Yes" : "No",
      m.guardianName ?? guardianFullName,
      m.guardianEmail ?? m.guardian?.email ?? "",
      m.guardianPhone ?? m.guardian?.phone ?? "",
      m.guardianRelationship ?? "",
      m.joinedAt.toISOString().split("T")[0],
      m.notes ?? "",
    ];
  });

  return await exportResponse(
    format,
    "members-export",
    headers,
    rows,
    "Members Export",
    "Members",
  );
}
