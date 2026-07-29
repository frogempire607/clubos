import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { ALERT_KINDS } from "@/lib/reportsAlerts";

// PUT /api/reports/alerts/settings
// Body: { settings: [{ kind, threshold?, enabled }] }
//
// Owner + finances:full. Upserts one row per (clubId, kind).

const schema = z.object({
  settings: z.array(
    z.object({
      kind: z.enum(ALERT_KINDS),
      threshold: z.number().nullable().optional(),
      enabled: z.boolean(),
    }),
  ),
});

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  await prisma.$transaction(
    parsed.data.settings.map((s) =>
      prisma.reportAlertSetting.upsert({
        where: { clubId_kind: { clubId: session.user.clubId, kind: s.kind } },
        create: {
          clubId: session.user.clubId,
          kind: s.kind,
          threshold: s.threshold ?? null,
          enabled: s.enabled,
          updatedById: session.user.id,
        },
        update: {
          threshold: s.threshold ?? null,
          enabled: s.enabled,
          updatedById: session.user.id,
        },
      }),
    ),
  );

  return NextResponse.json({ ok: true });
}
