import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { StaffDocError, deleteStaffDocument, updateStaffDocument } from "@/lib/staffDocumentsServer";

export const dynamic = "force-dynamic";

const assignmentSchema = z
  .object({
    scope: z.enum(["ALL", "ROLE", "STAFF"]),
    staffUserId: z.string().min(1).nullable().optional(),
    role: z.string().trim().max(100).nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(200_000).nullable().optional(),
    type: z.string().trim().max(40).optional(),
    assignments: z.array(assignmentSchema).min(1).max(200).optional(),
  })
  .strict();

// PATCH /api/staff-documents/[id] — edit. documents:edit.
//
// Changing the TITLE or the BODY publishes a new version, and everyone who had
// signed is asked again — those are what they signed. Changing an assignment
// or a due date does not, because it would ask the whole team to re-sign
// because a date moved.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "documents", "edit");
  if (denied) return denied;

  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    const result = await updateStaffDocument(
      session.user.clubId,
      params.id,
      {
        title: parsed.data.title,
        body: parsed.data.body,
        type: parsed.data.type,
        assignments: parsed.data.assignments,
      },
      session.user.id ?? null,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof StaffDocError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

// DELETE /api/staff-documents/[id] — soft delete. documents:edit.
//
// Signatures are KEPT. Deleting the evidence that somebody signed a
// non-compete would be the opposite of what this feature is for.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "documents", "edit");
  if (denied) return denied;

  try {
    await deleteStaffDocument(session.user.clubId, params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof StaffDocError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
