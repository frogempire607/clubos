import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// GET /api/reports/imports/[id]/errors.csv
// Original errored rows verbatim + an appended `error` column.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const batch = await prisma.importBatch.findFirst({ where: { id, clubId: session.user.clubId } });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.importRow.findMany({
    where: { batchId: id, outcome: "EXCLUDED" },
    orderBy: { rowNumber: "asc" },
  });
  if (rows.length === 0) {
    return new NextResponse("row,error\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="import-${id}-errors.csv"`,
      },
    });
  }
  const rawHeaders = Object.keys(rows[0].rawData as Record<string, unknown>);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push([...rawHeaders, "error"].map(esc).join(","));
  for (const r of rows) {
    const raw = r.rawData as Record<string, unknown>;
    const errs = (r.errors as Array<{ message: string }> | null) ?? [];
    const msg = errs.map((e) => e.message).join(" · ") || r.reason || "";
    lines.push([...rawHeaders.map((h) => raw[h]), msg].map(esc).join(","));
  }
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="import-${id}-errors.csv"`,
    },
  });
}
