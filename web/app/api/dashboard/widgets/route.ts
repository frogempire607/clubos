import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ALL_WIDGET_KEYS, resolvePrefs, WIDGET_CATALOG } from "@/lib/dashboardWidgets";

// GET /api/dashboard/widgets — current user's resolved widget preferences
// plus the full catalog so the customize UI can render every option.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { dashboardWidgets: true },
  });
  const prefs = resolvePrefs(user?.dashboardWidgets ?? null);

  return NextResponse.json({ prefs, catalog: WIDGET_CATALOG });
}

const putSchema = z.object({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
});

// PUT /api/dashboard/widgets — persist this user's widget layout.
export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const known = new Set(ALL_WIDGET_KEYS);
  const order = body.order.filter((k) => known.has(k));
  const hidden = body.hidden.filter((k) => known.has(k));

  await prisma.user.update({
    where: { id: session.user.id },
    data: { dashboardWidgets: { order, hidden } },
  });

  return NextResponse.json({ ok: true, prefs: resolvePrefs({ order, hidden }) });
}
