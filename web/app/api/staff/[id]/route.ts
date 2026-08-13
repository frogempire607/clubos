import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission, invalidatePermissionCache } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import { resolvePermissions, MESSAGES_SUBSCOPES, type MessagesSubScope } from "@/lib/permissions";

const permissionLevel = z.enum(["none", "view", "edit", "full", "send"]);

// The permissions blob has two shapes today: canonical per-key levels
// (strings) + `messages_subScopes` (a nested boolean map, added session 2).
// z.record(string, level) rejected the nested object outright; a passthrough
// with permissive types lets both survive validation. Server-side we split
// the sub-scope map back out and preserve it on the StaffProfile.permissions
// JSON blob so hasMessagesSubScope() reads it back.
const permissionsSchema = z.record(z.string(), z.unknown()).optional();

const updateSchema = z.object({
  // Owner can edit any User-level field except the password (passwords are
  // reset via the forgot-password flow, not directly editable from here).
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  title: z.string().optional().nullable(),
  hourlyRate: z.number().nullable().optional(),
  salary: z.number().nullable().optional(),
  appointmentPrice: z.number().nullable().optional(),
  perSessionRate: z.number().nullable().optional(),
  bio: z.string().max(2000).optional().nullable(),
  publicEmail: z.string().optional().nullable(),
  publicPhone: z.string().optional().nullable(),
  photoUrl: z.string().optional().nullable(),
  showOnPortal: z.boolean().optional(),
  permissions: permissionsSchema,
});

// Split the loose permissions blob into (canonical levels, messages
// sub-scope map). Both fold back together for storage; the split is
// only here so `resolvePermissions` continues to see the per-key
// enum shape it expects.
function splitPermissions(raw: unknown): { base: Record<string, unknown>; subScopes: Record<MessagesSubScope, boolean> | null } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base: Record<string, unknown> = {};
  let subScopes: Record<MessagesSubScope, boolean> | null = null;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "messages_subScopes" && v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out = {} as Record<MessagesSubScope, boolean>;
      for (const s of MESSAGES_SUBSCOPES) {
        out[s] = src[s] === true;
      }
      subScopes = out;
    } else if (typeof v === "string" && ["none", "view", "edit", "full", "send"].includes(v)) {
      base[k] = v;
    }
  }
  return { base, subScopes };
}
function foldPermissions(raw: unknown): Record<string, unknown> {
  const { base, subScopes } = splitPermissions(raw);
  const resolved = resolvePermissions(base) as unknown as Record<string, unknown>;
  return subScopes ? { ...resolved, messages_subScopes: subScopes } : resolved;
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "staff", "full");
  if (denied) return denied;

  const user = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: "STAFF" },
    include: { staffProfile: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = updateSchema.parse(await req.json());

    const profileData = {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.hourlyRate !== undefined && { hourlyRate: data.hourlyRate }),
      ...(data.salary !== undefined && { salary: data.salary }),
      ...(data.appointmentPrice !== undefined && { appointmentPrice: data.appointmentPrice }),
      ...(data.perSessionRate !== undefined && { perSessionRate: data.perSessionRate }),
      ...(data.bio !== undefined && { bio: data.bio }),
      ...(data.publicEmail !== undefined && { publicEmail: data.publicEmail }),
      ...(data.publicPhone !== undefined && { publicPhone: data.publicPhone }),
      ...(data.photoUrl !== undefined && { photoUrl: data.photoUrl }),
      ...(data.showOnPortal !== undefined && { showOnPortal: data.showOnPortal }),
      ...(data.permissions && { permissions: foldPermissions(data.permissions) as unknown as object }),
    };

    if (user.staffProfile) {
      await prisma.staffProfile.update({ where: { userId: user.id }, data: profileData });
      // The guards cache resolved permissions for 20s; a grant or revocation
      // the owner just made should take effect on their very next click.
      invalidatePermissionCache(user.id);
    } else {
      await prisma.staffProfile.create({
        data: {
          userId: user.id,
          ...profileData,
          permissions: foldPermissions(data.permissions ?? null) as unknown as object,
        },
      });
      invalidatePermissionCache(user.id);
    }

    // User-level fields owners can edit (anything except password).
    const userPatch: Record<string, unknown> = {};
    if (data.firstName !== undefined) userPatch.firstName = data.firstName;
    if (data.lastName !== undefined) userPatch.lastName = data.lastName;
    if (data.email !== undefined) userPatch.email = data.email.toLowerCase();
    if (Object.keys(userPatch).length > 0) {
      try {
        await prisma.user.update({ where: { id: user.id }, data: userPatch });
      } catch (err) {
        // Most common cause: the chosen email is already in use in this club.
        return NextResponse.json(
          { error: "That email is already in use for another account in this club." },
          { status: 409 },
        );
      }
    }

    const updated = await prisma.user.findUnique({ where: { id: user.id }, include: { staffProfile: true } });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "staff", "full");
  if (denied) return denied;

  const user = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: "STAFF" },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.user.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
