import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { exportResponse, parseExportFormat, isAdvancedExport } from "@/lib/exporters";
import { getTierFeatures } from "@/lib/tier";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const format = parseExportFormat(url);

  if (isAdvancedExport(format)) {
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { tier: true },
    });
    const features = getTierFeatures(club?.tier ?? "starter");
    if (!features.reports) {
      return new Response(
        "Excel and PDF exports require a Growth plan or higher. Use CSV instead, or upgrade.",
        { status: 403 },
      );
    }
  }

  const records = await prisma.attendanceRecord.findMany({
    where: {
      clubId: session.user.clubId,
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    include: {
      member: { select: { firstName: true, lastName: true } },
      classSession: {
        include: {
          recurringClass: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const headers = [
    "Date", "Class / Event", "Member First Name", "Member Last Name",
    "Status", "Checked In At", "Notes",
  ];

  const rows = records.map((r) => [
    r.createdAt.toISOString().split("T")[0],
    r.classSession?.recurringClass?.name ?? (r.eventId ? "Event" : ""),
    r.member.firstName,
    r.member.lastName,
    r.status,
    r.checkedInAt ? r.checkedInAt.toISOString().replace("T", " ").slice(0, 16) : "",
    r.notes ?? "",
  ]);

  return exportResponse(
    format,
    "attendance-export",
    headers,
    rows,
    "Attendance Export",
    "Attendance",
  );
}
