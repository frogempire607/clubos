import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { StaffDocError, clubStaff, createStaffDocument, listStaffDocuments } from "@/lib/staffDocumentsServer";

export const dynamic = "force-dynamic";

// GET /api/staff-documents — every staff document with who has signed.
// documents:view plus staff:view — it lists both the documents AND the staff
// who owe them, so it needs to be allowed to see both.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = (await requirePermissionLive(session, "documents", "view")) ?? (await requirePermissionLive(session, "staff", "view"));
  if (denied) return denied;

  const [documents, staff] = await Promise.all([
    listStaffDocuments(session.user.clubId),
    clubStaff(session.user.clubId),
  ]);
  // Roles come from the titles staff actually have, so a ROLE assignment can
  // only be made against something real.
  const roles = [...new Set(staff.map((s) => s.title).filter((t): t is string => !!t?.trim()))].sort();
  return NextResponse.json({ documents, staff, roles });
}

const assignmentSchema = z
  .object({
    scope: z.enum(["ALL", "ROLE", "STAFF"]),
    staffUserId: z.string().min(1).nullable().optional(),
    role: z.string().trim().max(100).nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(200_000).nullable().optional(),
    type: z.string().trim().max(40).optional(),
    assignments: z.array(assignmentSchema).min(1).max(200),
  })
  .strict();

// POST /api/staff-documents — create one and assign it. documents:edit.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "documents", "edit");
  if (denied) return denied;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    const id = await createStaffDocument(
      session.user.clubId,
      {
        title: parsed.data.title,
        body: parsed.data.body ?? null,
        type: parsed.data.type,
        assignments: parsed.data.assignments,
      },
      session.user.id ?? null,
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof StaffDocError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
