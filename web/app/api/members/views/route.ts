// Phase 4.5.2 §1e — saved member views.
//
//   GET    /api/members/views?scope=MEMBERS   → this user's views
//   POST   /api/members/views                 → save (or overwrite) one
//   DELETE /api/members/views?id=…            → remove one
//
// `saved_member_views` shipped with 20260804000000_members_experience and the
// roster has rendered a "Save as view" control since session 2, with nothing
// behind it. This is that nothing.
//
// ── Two decisions worth stating ──────────────────────────────────────────────
//
// 1. PER USER, not per club. The handoff says "Saved views persist per user",
//    and the schema's unique key is (userId, scope, name). A view is somebody's
//    working set — "my never-invited follow-ups" — not a club-wide artefact
//    that a second staffer can silently redefine.
//
// 2. The filter is stored as the URL carries it, verbatim. That is what makes a
//    view survive new filters being added later without a migration, and it is
//    why applying a view is just pushing its query string. Storage is
//    ALLOWLISTED to the keys the roster's own parser understands, so a saved
//    view can never smuggle an arbitrary parameter back into a later request.

import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

/**
 * Exactly the keys `parseMemberFilters` reads. Anything else is dropped rather
 * than stored — a saved view is replayed into a URL, so it must not be able to
 * carry a key the list parser never validated.
 */
const FILTER_KEYS = [
  "search", "personType", "setupState", "membership",
  "tag", "gender", "queue", "sort", "pageSize",
] as const;

const SCOPES = ["MEMBERS", "MIGRATION"] as const;

const postSchema = z.object({
  name: z.string().trim().min(1, "Give the view a name.").max(60),
  scope: z.enum(SCOPES).default("MEMBERS"),
  filters: z.record(z.string()).default({}),
  sort: z.string().max(40).nullable().optional(),
});

function cleanFilters(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    const v = input[k];
    // "page" is deliberately absent from FILTER_KEYS: a view is a filter, not a
    // scroll position, and reopening one on page 4 would look like data loss.
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim().slice(0, 200);
  }
  return out;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const scopeParam = new URL(req.url).searchParams.get("scope");
  const scope = (SCOPES as readonly string[]).includes(scopeParam ?? "") ? scopeParam! : "MEMBERS";

  const views = await prisma.savedMemberView.findMany({
    where: { userId: session.user.id, clubId: session.user.clubId, scope },
    orderBy: { name: "asc" },
    select: { id: true, name: true, filters: true, sort: true, scope: true, createdAt: true },
  });
  return NextResponse.json({ views });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const filters = cleanFilters(body.filters);

  // Saving under a name you already used overwrites it. The alternative — a
  // uniqueness error on the club's most common action ("update my view") — is
  // the worse surprise, and the unique key exists to make this an upsert rather
  // than to forbid it.
  const view = await prisma.savedMemberView.upsert({
    where: { userId_scope_name: { userId: session.user.id, scope: body.scope, name: body.name } },
    create: {
      clubId: session.user.clubId,
      userId: session.user.id,
      scope: body.scope,
      name: body.name,
      filters,
      sort: body.sort ?? null,
    },
    update: { filters, sort: body.sort ?? null },
    select: { id: true, name: true, filters: true, sort: true, scope: true, createdAt: true },
  });

  return NextResponse.json({ view });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  // Scoped to the caller: a view belongs to the person who saved it, so this
  // deletes nothing if the id belongs to a colleague.
  const { count } = await prisma.savedMemberView.deleteMany({
    where: { id, userId: session.user.id, clubId: session.user.clubId },
  });
  if (count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
