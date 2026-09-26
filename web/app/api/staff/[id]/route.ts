import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission, requirePermissionLive, invalidatePermissionCache } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import { SAFE_USER_SELECT, invitePending } from "@/lib/safeUser";
import { resolvePermissions, MESSAGES_SUBSCOPES, BILLING_SUBSCOPES, type MessagesSubScope, type BillingSubScope } from "@/lib/permissions";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";
import { describeAccessChanges, accessStateFromJson } from "@/lib/staffAccess";

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
  // B21: private phone, never shown in the member portal.
  phone: z.string().max(50).optional().nullable(),
  photoUrl: z.string().optional().nullable(),
  showOnPortal: z.boolean().optional(),
  permissions: permissionsSchema,
});

// Split the loose permissions blob into (canonical levels, messages
// sub-scope map). Both fold back together for storage; the split is
// only here so `resolvePermissions` continues to see the per-key
// enum shape it expects.
function splitPermissions(raw: unknown): {
  base: Record<string, unknown>;
  subScopes: Record<MessagesSubScope, boolean> | null;
  billingSubScopes: Record<BillingSubScope, boolean> | null;
} {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base: Record<string, unknown> = {};
  let subScopes: Record<MessagesSubScope, boolean> | null = null;
  // B21 fix: billing_subScopes (transfer_subscription) used to be dropped
  // here, so the Edit Staff "move a membership" switch never saved.
  let billingSubScopes: Record<BillingSubScope, boolean> | null = null;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "messages_subScopes" && v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out = {} as Record<MessagesSubScope, boolean>;
      for (const s of MESSAGES_SUBSCOPES) {
        out[s] = src[s] === true;
      }
      subScopes = out;
    } else if (k === "billing_subScopes" && v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out = {} as Record<BillingSubScope, boolean>;
      for (const s of BILLING_SUBSCOPES) out[s] = src[s] === true;
      billingSubScopes = out;
    } else if (typeof v === "string" && ["none", "view", "edit", "full", "send"].includes(v)) {
      base[k] = v;
    }
  }
  return { base, subScopes, billingSubScopes };
}
function foldPermissions(raw: unknown): Record<string, unknown> {
  const { base, subScopes, billingSubScopes } = splitPermissions(raw);
  const resolved = resolvePermissions(base) as unknown as Record<string, unknown>;
  return {
    ...resolved,
    ...(subScopes && { messages_subScopes: subScopes }),
    ...(billingSubScopes && { billing_subScopes: billingSubScopes }),
  };
}

// GET — B21 staff profile payload. Readable by the owner, by staff with
// Staff & contractors: view, and by the staff member themself (My profile).
// `viewer` says what the signed-in person may change; the write routes
// enforce the same rules server-side (lib/staffSelf.ts).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const self = session.user.id === params.id;
  const viewerIsOwner = session.user.role === "OWNER";
  if (!self && !viewerIsOwner) {
    const denied = await requirePermissionLive(session, "staff", "view");
    if (denied) return denied;
  }

  const user = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: { in: ["STAFF", "OWNER"] }, deletedAt: null },
    select: { ...SAFE_USER_SELECT, resetToken: true, staffProfile: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const can = async (key: Parameters<typeof requirePermissionLive>[1], level: Parameters<typeof requirePermissionLive>[2]) =>
    viewerIsOwner ? true : (await requirePermissionLive(session, key, level)) === null;

  const targetIsOwner = user.role === "OWNER";
  const [staffFull, financesView, financesFull, scheduleEdit, classesEdit, eventsEdit] = await Promise.all([
    can("staff", "full"), can("finances", "view"), can("finances", "full"), can("schedule", "edit"),
    can("classes", "edit"), can("events", "edit"),
  ]);
  const viewer = {
    isSelf: self,
    isOwner: viewerIsOwner,
    targetIsOwner,
    // Manager edits: never on yourself (lib/staffSelf.ts), never on an owner.
    canEditRecord: !self && !targetIsOwner && staffFull,
    canEditAccess: !self && !targetIsOwner && staffFull,
    canViewPay: self || financesView,
    canEditPay: !self && financesFull,
    // The assign routes check classes:edit / events:edit (not schedule), so
    // the button follows what the server will actually accept.
    canAssign: classesEdit || eventsEdit,
    canEditHours: self || scheduleEdit,
    canEditOwnInfo: self,
    canRemove: !self && !targetIsOwner && staffFull,
  };

  const raw = (user.staffProfile?.permissions ?? null) as Record<string, unknown> | null;
  const [lessonTypes, docs, activity] = await Promise.all([
    prisma.privateLessonType.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, eligibleCoachIds: true },
    }).catch(() => [] as { id: string; eligibleCoachIds: unknown }[]),
    prisma.staffDocument.findMany({
      where: {
        clubId: session.user.clubId, userId: user.id, deletedAt: null,
        // Staff see only documents shared with them (same rule as /api/me/staff-documents).
        ...(self && !viewerIsOwner && !staffFull ? { sharedWithStaff: true } : {}),
      },
      select: { id: true, kind: true },
    }),
    prisma.staffActivity.findMany({
      where: { clubId: session.user.clubId, staffUserId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, kind: true, summary: true, actorName: true, selfMade: true, createdAt: true },
    }),
  ]);
  const lessonCount = lessonTypes.filter((t) =>
    Array.isArray(t.eligibleCoachIds) && (t.eligibleCoachIds as unknown[]).includes(user.id)).length;

  const { resetToken, staffProfile, ...rest } = user;
  return NextResponse.json({
    staff: {
      ...rest,
      invitePending: invitePending({ resetToken, lastLoginAt: user.lastLoginAt }),
      title: staffProfile?.title ?? null,
      phone: staffProfile?.phone ?? null,
      bio: staffProfile?.bio ?? null,
      publicEmail: staffProfile?.publicEmail ?? null,
      publicPhone: staffProfile?.publicPhone ?? null,
      photoUrl: staffProfile?.photoUrl ?? null,
      showOnPortal: staffProfile?.showOnPortal ?? false,
      permissions: resolvePermissions(raw),
      messagesSubScopes: (raw?.messages_subScopes as Record<string, boolean> | undefined) ?? null,
      billingSubScopes: (raw?.billing_subScopes as Record<string, boolean> | undefined) ?? null,
    },
    viewer,
    counts: {
      lessons: lessonCount,
      documents: docs.length,
      // Julian 2026-09-26: a staff member with no W-9 on file counts as missing a required document.
      w9Missing: !targetIsOwner && !docs.some((d) => d.kind === "W9"),
    },
    activity,
  });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // B21: this is the MANAGER route. Staff change their own details from
  // My profile (/api/me/*); nobody changes their own access or record here.
  if (selfRule(session.user.role, session.user.id, params.id, "edit_record") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_access }, { status: 403 });
  }
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
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.permissions && { permissions: foldPermissions(data.permissions) as unknown as object }),
    };

    // User-level fields owners can edit (anything except password).
    const userPatch: Record<string, unknown> = {};
    if (data.firstName !== undefined) userPatch.firstName = data.firstName;
    if (data.lastName !== undefined) userPatch.lastName = data.lastName;
    if (data.email !== undefined) userPatch.email = data.email.toLowerCase();

    // One save means one save, on the server too. This used to write the
    // StaffProfile first and the User second, so an owner who changed a
    // permission AND mistyped the email into one already in use got a 409 with
    // the permission change already applied: the modal showed an error, stayed
    // open, and the grant was live. Both writes now share a transaction, so a
    // rejected email leaves the permissions exactly as they were.
    try {
      await prisma.$transaction(async (tx) => {
        if (user.staffProfile) {
          await tx.staffProfile.update({ where: { userId: user.id }, data: profileData });
        } else {
          await tx.staffProfile.create({
            data: {
              userId: user.id,
              ...profileData,
              permissions: foldPermissions(data.permissions ?? null) as unknown as object,
            },
          });
        }
        if (Object.keys(userPatch).length > 0) {
          await tx.user.update({ where: { id: user.id }, data: userPatch });
        }
      });
    } catch {
      // Most common cause: the chosen email is already in use in this club.
      // Nothing was written — the transaction rolled back.
      return NextResponse.json(
        { error: "That email is already in use for another account in this club." },
        { status: 409 },
      );
    }

    // After the commit, never before: the guards cache resolved permissions for
    // 20s, and busting the cache for a change that then rolled back would serve
    // a re-read of the OLD row as if it were new.
    invalidatePermissionCache(user.id);

    // B21 — Recent activity, after the commit.
    {
      const actor = actorFrom(session);
      const base = { clubId: session.user.clubId, staffUserId: user.id, ...actor };
      if (data.permissions) {
        const beforeRaw = user.staffProfile?.permissions ?? null;
        const afterRaw = foldPermissions(data.permissions);
        const changes = describeAccessChanges(
          user.firstName,
          accessStateFromJson(beforeRaw, resolvePermissions(beforeRaw)),
          accessStateFromJson(afterRaw, resolvePermissions(afterRaw)),
        );
        for (const c of changes) await recordStaffActivity({ ...base, kind: "ACCESS", summary: c.logLine });
      }
      if (data.email !== undefined && data.email.toLowerCase() !== user.email.toLowerCase()) {
        await recordStaffActivity({ ...base, kind: "ACCOUNT", summary: `Changed the sign-in email to ${data.email.toLowerCase()}` });
      }
      const personal: string[] = [];
      if (data.firstName !== undefined && data.firstName !== user.firstName) personal.push("first name");
      if (data.lastName !== undefined && data.lastName !== user.lastName) personal.push("last name");
      if (data.title !== undefined && (data.title ?? null) !== (user.staffProfile?.title ?? null)) personal.push("title");
      if (data.phone !== undefined && (data.phone ?? null) !== (user.staffProfile?.phone ?? null)) personal.push("phone");
      if (personal.length) await recordStaffActivity({ ...base, kind: "PERSONAL", summary: `Updated ${personal.join(", ")}` });
      const portal = ["bio", "publicEmail", "publicPhone", "photoUrl", "showOnPortal"].filter(
        (k) => (data as Record<string, unknown>)[k] !== undefined
          && (data as Record<string, unknown>)[k] !== (user.staffProfile as Record<string, unknown> | null)?.[k],
      );
      if (portal.length) await recordStaffActivity({ ...base, kind: "PORTAL", summary: "Updated the member-portal profile" });
    }

    const updated = await prisma.user.findUnique({
      where: { id: user.id },
      select: { ...SAFE_USER_SELECT, staffProfile: true },
    });
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
  if (selfRule(session.user.role, session.user.id, params.id, "remove") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.remove }, { status: 403 });
  }
  const denied = requirePermission(session, "staff", "full");
  if (denied) return denied;

  const user = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: "STAFF" },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.user.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
