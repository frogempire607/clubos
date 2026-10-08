import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermissionLive, isOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";
import { ensureFeed, feedStatus, regenerateFeed, revokeFeed, setFeedChoices, staffFeedUrls, validChoices } from "@/lib/staffCalendarFeed";

export const dynamic = "force-dynamic";

// A coach's personal calendar link ("Subscribe to my schedule").
//   The coach themself  → sees the link, can create it, replace it, turn it off.
//   Owner / staff:full  → sees WHETHER a link exists and when it was last
//                         used, and can replace or turn it off — but is never
//                         shown the link itself (it opens that coach's
//                         schedule to whoever holds it).
//   Anyone else         → 403.
// What the link carries (classes / private lessons / events) is the coach's
// own choice — only they can change it (PATCH); admins see it read-only.
type Access = { self: boolean; admin: boolean };
async function accessTo(session: Parameters<typeof hasPermissionLive>[0], targetId: string): Promise<Access> {
  const self = session?.user?.id === targetId;
  const admin = (await isOwnerLive(session)) || (await hasPermissionLive(session, "staff", "full"));
  return { self, admin };
}
async function targetUser(clubId: string, id: string) {
  return prisma.user.findFirst({ where: { id, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null }, select: { id: true, firstName: true } });
}

// GET /api/staff/[id]/calendar-feed
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  const access = await accessTo(session, id);
  if (!access.self && !access.admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const clubId = session.user.clubId;
  if (!(await targetUser(clubId, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const st = await feedStatus(clubId, id);
  return NextResponse.json({
    enabled: st.enabled,
    createdAt: st.createdAt,
    rotatedAt: st.rotatedAt,
    lastAccessedAt: st.lastAccessedAt,
    choices: st.choices,
    // Only the coach is ever given the link.
    urls: access.self && st.token ? staffFeedUrls(st.token) : null,
    viewer: { isSelf: access.self, canManage: access.self || access.admin },
  });
}

const choicesSchema = z.object({ classes: z.boolean(), privates: z.boolean(), events: z.boolean() }).strict();
const schema = z.object({ action: z.enum(["create", "regenerate"]), choices: choicesSchema.optional() }).strict();
const NONE_CHOSEN = "Choose at least one thing to sync — or turn the link off.";

// POST /api/staff/[id]/calendar-feed  { action: "create" | "regenerate" }
//   create      the coach only — returns their link, making it the first time
//   regenerate  the coach, or an owner / staff:full — a NEW link; the old one
//               stops working at once
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  const access = await accessTo(session, id);
  if (!access.self && !access.admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  const clubId = session.user.clubId;
  if (!(await targetUser(clubId, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (body.action === "create") {
    if (!access.self) return NextResponse.json({ error: "Only the staff member can set up their own calendar link." }, { status: 403 });
    if (body.choices && !validChoices(body.choices)) return NextResponse.json({ error: NONE_CHOSEN, code: "BAD_INPUT" }, { status: 400 });
    const token = await ensureFeed(clubId, id, body.choices);
    return NextResponse.json({ ok: true, enabled: true, urls: staffFeedUrls(token) });
  }
  const token = await regenerateFeed(clubId, id, session.user.id ?? null);
  await recordStaffActivity({
    clubId, staffUserId: id, ...actorFrom(session), kind: "ACCOUNT",
    summary: "Replaced the personal calendar link — the old link no longer works",
  });
  return NextResponse.json({ ok: true, enabled: true, urls: access.self ? staffFeedUrls(token) : null });
}

// PATCH /api/staff/[id]/calendar-feed  { classes, privates, events } — the coach only.
// Takes effect the next time their calendar app checks the link (same link).
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  if (session.user.id !== id) return NextResponse.json({ error: "Only the staff member chooses what goes on their own calendar." }, { status: 403 });
  let c: z.infer<typeof choicesSchema>;
  try {
    c = choicesSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }
  if (!validChoices(c)) return NextResponse.json({ error: NONE_CHOSEN, code: "BAD_INPUT" }, { status: 400 });
  const clubId = session.user.clubId;
  if (!(await targetUser(clubId, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await setFeedChoices(clubId, id, c))) return NextResponse.json({ error: "Set up your calendar link first.", code: "NO_LINK" }, { status: 409 });
  return NextResponse.json({ ok: true, choices: c });
}

// DELETE /api/staff/[id]/calendar-feed — turn the link off (the coach, or an owner / staff:full).
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notStaff = await requirePermissionLive(session, "schedule", "none");
  if (notStaff) return notStaff;
  const access = await accessTo(session, id);
  if (!access.self && !access.admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const clubId = session.user.clubId;
  const had = await revokeFeed(clubId, id);
  if (had) {
    await recordStaffActivity({ clubId, staffUserId: id, ...actorFrom(session), kind: "ACCOUNT", summary: "Turned off the personal calendar link" });
  }
  return NextResponse.json({ ok: true, enabled: false });
}
