import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { parseDeviceRegistration } from "@/lib/push";

// POST   /api/push/devices  { token, platform: "IOS" | "ANDROID", appId }
//   The app calls this after the person allowed notifications. One row per
//   (appId, token). A phone handed to someone else, or a second account
//   signing in on the same phone, MOVES the row to whoever is signed in now:
//   a push must never reach the previous person's lock screen. A token that
//   had been switched off (reported dead, or removed at sign-out) is switched
//   back on, because the phone has just proved it is alive.
//
// DELETE /api/push/devices  { token, appId }
//   Sign-out. Switches the row off; it is never deleted.
//
// Both act only on the signed-in person's own devices.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `push:devices:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const reg = parseDeviceRegistration(await req.json().catch(() => null));
  if (!reg) return NextResponse.json({ error: "A token, a platform (IOS or ANDROID) and an app id are required." }, { status: 400 });

  const now = new Date();
  await prisma.deviceToken.upsert({
    where: { appId_token: { appId: reg.appId, token: reg.token } },
    create: { clubId: session.user.clubId, userId: session.user.id, platform: reg.platform, appId: reg.appId, token: reg.token, lastSeenAt: now },
    update: { clubId: session.user.clubId, userId: session.user.id, platform: reg.platform, lastSeenAt: now, disabledAt: null, disabledReason: null },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `push:devices:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = (await req.json().catch(() => null)) as { token?: unknown; appId?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const appId = typeof body?.appId === "string" ? body.appId.trim() : "";
  if (!token) return NextResponse.json({ error: "A token is required." }, { status: 400 });

  const res = await prisma.deviceToken.updateMany({
    where: { userId: session.user.id, token, ...(appId ? { appId } : {}), disabledAt: null },
    data: { disabledAt: new Date(), disabledReason: "SIGNED_OUT" },
  });
  return NextResponse.json({ ok: true, removed: res.count });
}
