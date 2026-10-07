import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { formatZodError } from "@/lib/zodErrors";
import { CANCEL_AUDIENCES, CLASS_STAFF_ROLES, type ScheduleSettings } from "@/lib/classStaff";
import { getScheduleSettings } from "@/lib/classStaffServer";
import { listScheduleStaff, validScheduleStaffIds } from "@/lib/staffAssignmentsServer";

/** Channels the app can deliver on today. PUSH is accepted and stored for later, and ignored when sending. */
const KNOWN_CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;
const ACTIVE_CHANNELS = ["IN_APP", "EMAIL"];

const putSchema = z.object({
  coverageNotifyOwners: z.boolean().optional(),
  coverageNotifyManagers: z.boolean().optional(),
  coverageNotifyClassStaff: z.boolean().optional(),
  coverageNotifyRoleNames: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  coverageNotifyUserIds: z.array(z.string().min(1)).max(200).optional(),
  coverageChannels: z.array(z.enum(KNOWN_CHANNELS)).min(1).optional(),
  classCancelNotifyDefault: z.enum(CANCEL_AUDIENCES).optional(),
}).strict();

function payload(s: ScheduleSettings, extra: Record<string, unknown> = {}) {
  return {
    coverageNotifyOwners: s.coverageNotifyOwners,
    coverageNotifyManagers: s.coverageNotifyManagers,
    coverageNotifyClassStaff: s.coverageNotifyClassStaff,
    coverageNotifyRoleNames: s.coverageNotifyRoleNames,
    coverageNotifyUserIds: s.coverageNotifyUserIds,
    coverageChannels: s.coverageChannels,
    classCancelNotifyDefault: s.classCancelNotifyDefault,
    /** Read-only: set by the switch-on script, never by this endpoint. null = not switched on. */
    assignmentsStartOn: s.assignmentsStartOn,
    switchedOn: !!s.assignmentsStartOn,
    /** Read-only here: set once by POST /api/settings/schedule/pay-ledger. null = no pay ledger yet. */
    payLedgerStartsOn: s.payLedgerStartsOn,
    ...extra,
  };
}

// GET /api/settings/schedule — the club's coverage + cancellation defaults.
// schedule:view (live). Also returns what the settings screen needs to offer:
// the standard role names, the channels, the audiences and the staff list.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "schedule", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const [settings, staff] = await Promise.all([getScheduleSettings(clubId), listScheduleStaff(clubId)]);
  return NextResponse.json(payload(settings, {
    options: {
      roles: CLASS_STAFF_ROLES,
      channels: KNOWN_CHANNELS.map((key) => ({ key, available: ACTIVE_CHANNELS.includes(key) })),
      cancelAudiences: CANCEL_AUDIENCES,
      staff: staff.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role })),
    },
  }));
}

// PUT /api/settings/schedule — OWNER only, verified against the database.
// Only the fields sent are changed. `assignmentsStartOn` and the pay-ledger
// date are NOT settable here (an unknown field is a 400). Named recipients
// must be current OWNER/STAFF of this club (400 INVALID_STAFF otherwise).
export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requireOwnerLive(session);
  if (denied) return denied;
  const clubId = session.user.clubId;

  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err), code: "BAD_INPUT" }, { status: 400 });
    return NextResponse.json({ error: "Invalid request body", code: "BAD_INPUT" }, { status: 400 });
  }

  let userIds: string[] | undefined;
  if (body.coverageNotifyUserIds !== undefined) {
    const asked = Array.from(new Set(body.coverageNotifyUserIds));
    userIds = await validScheduleStaffIds(clubId, asked);
    const bad = asked.filter((id) => !userIds!.includes(id));
    if (bad.length > 0) {
      return NextResponse.json({ error: "Some of those people are not current staff of this club.", code: "INVALID_STAFF", invalidUserIds: bad }, { status: 400 });
    }
  }
  const uniq = <T,>(list: T[]) => Array.from(new Set(list));
  const data = {
    ...(body.coverageNotifyOwners !== undefined ? { coverageNotifyOwners: body.coverageNotifyOwners } : {}),
    ...(body.coverageNotifyManagers !== undefined ? { coverageNotifyManagers: body.coverageNotifyManagers } : {}),
    ...(body.coverageNotifyClassStaff !== undefined ? { coverageNotifyClassStaff: body.coverageNotifyClassStaff } : {}),
    ...(body.coverageNotifyRoleNames !== undefined ? { coverageNotifyRoleNames: uniq(body.coverageNotifyRoleNames) } : {}),
    ...(userIds !== undefined ? { coverageNotifyUserIds: userIds } : {}),
    ...(body.coverageChannels !== undefined ? { coverageChannels: uniq(body.coverageChannels) } : {}),
    ...(body.classCancelNotifyDefault !== undefined ? { classCancelNotifyDefault: body.classCancelNotifyDefault } : {}),
    updatedByUserId: session.user.id,
  };
  await prisma.clubScheduleSettings.upsert({ where: { clubId }, update: data, create: { clubId, ...data } });
  return NextResponse.json({ ok: true, ...payload(await getScheduleSettings(clubId)) });
}
