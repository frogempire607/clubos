import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { audienceForRole, isPushKind, kindLabel, receivableKinds } from "@/lib/push";

// GET /api/me/notifications
//   The switches this person has: one per kind of push they can receive.
//   Owner and staff see the kinds their permissions allow; a family sees
//   Messages and Membership payment reminders. No row = on.
//
// PUT /api/me/notifications  { type, enabled }
//   Turn one kind on or off for yourself. A kind you cannot receive is refused.
//
// Role and permissions are read from the database on every call, not from the
// session token, so a permission removed a minute ago is already reflected.

export const dynamic = "force-dynamic";

async function whoAmI(userId: string, clubId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, clubId, deletedAt: null },
    select: { id: true, role: true, staffProfile: { select: { permissions: true } } },
  });
  if (!user) return null;
  const raw = user.staffProfile?.permissions;
  const perms = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  return { id: user.id, role: user.role as string, perms };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await whoAmI(session.user.id, session.user.clubId);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kinds = receivableKinds(me.role, me.perms);
  const off = new Set(
    (
      await prisma.notificationPreference.findMany({
        where: { userId: me.id, enabled: false },
        select: { type: true },
      })
    ).map((p) => p.type),
  );
  const audience = audienceForRole(me.role);
  return NextResponse.json(
    { kinds: kinds.map((type) => ({ type, ...kindLabel(type, audience), enabled: !off.has(type) })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `me:notifications:${session.user.id}`, limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = (await req.json().catch(() => null)) as { type?: unknown; enabled?: unknown } | null;
  if (!isPushKind(body?.type) || typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Choose a kind of notification and whether it is on." }, { status: 400 });
  }
  const me = await whoAmI(session.user.id, session.user.clubId);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!receivableKinds(me.role, me.perms).includes(body.type)) {
    return NextResponse.json({ error: "That notification is not available on this account." }, { status: 403 });
  }

  await prisma.notificationPreference.upsert({
    where: { userId_type: { userId: me.id, type: body.type } },
    create: { clubId: session.user.clubId, userId: me.id, type: body.type, enabled: body.enabled },
    update: { enabled: body.enabled, clubId: session.user.clubId },
  });
  return NextResponse.json({ ok: true, type: body.type, enabled: body.enabled });
}
