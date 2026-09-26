// B21 — write one line to a staff member's Recent activity.
//
// Best-effort by design: a failed activity write must never fail the change
// it describes (the change has already committed when this runs). Callers
// pass a transaction client when they want the line inside the same commit.
import { prisma } from "@/lib/prisma";

export type StaffActivityKind =
  | "ACCESS" | "PAY" | "HOURS" | "TIME_OFF" | "PERSONAL"
  | "PORTAL" | "LESSONS" | "DOCUMENTS" | "ASSIGNMENT" | "ACCOUNT";

type Db = Pick<typeof prisma, "staffActivity">;

export async function recordStaffActivity(
  input: {
    clubId: string;
    staffUserId: string;
    actorUserId?: string | null;
    actorName?: string | null;
    kind: StaffActivityKind;
    summary: string;
  },
  db: Db = prisma,
): Promise<void> {
  try {
    await db.staffActivity.create({
      data: {
        clubId: input.clubId,
        staffUserId: input.staffUserId,
        actorUserId: input.actorUserId ?? null,
        actorName: input.actorName ?? null,
        kind: input.kind,
        summary: input.summary.slice(0, 500),
        selfMade: !!input.actorUserId && input.actorUserId === input.staffUserId,
      },
    });
  } catch (err) {
    console.error("[staffActivity] write failed", err);
  }
}

/** Convenience: actor fields from a NextAuth session. */
export function actorFrom(session: { user?: { id?: string; name?: string | null } } | null | undefined) {
  return { actorUserId: session?.user?.id ?? null, actorName: session?.user?.name ?? null };
}
