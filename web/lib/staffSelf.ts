// B21 — what a staff member may do to THEIR OWN record.
//
// Julian, 2026-09-26: "staff members can easily see their profile and edit
// what is allowed for them. They can never touch their own compensation."
//
// The rule is enforced on the server (these helpers are called from the API
// routes), not just by hiding buttons. A staff member acting on their own
// record:
//   - CAN edit: their weekly hours, their time off, their name / private
//     phone (via /api/me/profile), their member-portal profile
//     (via /api/me/portal-profile).
//   - CAN see (read-only): their own pay plan, their own access.
//   - can NEVER change: their own pay plan or pay rates, their own access
//     level or role, or delete themselves — whatever permissions they hold.
// Owners are exempt: an owner has no manager above them.
//
// Pure — no Prisma, no Next — so scripts/staff-self-tests.ts covers it.

export type SelfAction =
  | "edit_pay"        // compensation plan / pay rates
  | "edit_access"     // permissions, sub-scopes, role
  | "edit_record"     // the manager-side PATCH on /api/staff/[id]
  | "remove"          // DELETE /api/staff/[id]
  | "view_pay"        // read own pay plan
  | "view_profile"    // open own profile page
  | "edit_hours"      // weekly availability
  | "edit_time_off";  // date exceptions

const NEVER_ON_SELF: ReadonlySet<SelfAction> = new Set(["edit_pay", "edit_access", "edit_record", "remove"]);

export function isSelf(actorId: string | null | undefined, targetId: string | null | undefined): boolean {
  return !!actorId && !!targetId && actorId === targetId;
}

/**
 * null  = the self rule has nothing to say (fall through to the normal
 *         permission check).
 * "deny" = refuse regardless of permissions.
 * "allow" = allow regardless of permissions (self-service).
 */
export function selfRule(
  role: string | null | undefined,
  actorId: string | null | undefined,
  targetId: string | null | undefined,
  action: SelfAction,
): "deny" | "allow" | null {
  if (role === "OWNER") return null;
  if (!isSelf(actorId, targetId)) return null;
  if (NEVER_ON_SELF.has(action)) return "deny";
  return "allow"; // view_pay, view_profile, edit_hours, edit_time_off
}

export const SELF_DENY_MESSAGE: Record<"edit_pay" | "edit_access" | "edit_record" | "remove", string> = {
  edit_pay: "You can't change your own pay. Ask the owner.",
  edit_access: "You can't change your own access. Ask the owner.",
  edit_record: "Change your own details from My profile.",
  remove: "You can't remove yourself from the staff.",
};

// ── Assignments: who may put whom on a class or an event (2026-10-07) ───────
//
// Julian: "Coaches cannot assign themselves to paid classes/occurrences. Only
// users with schedule-management permission can create or change staff
// assignments. They may only remove themselves from a class [and that] sends
// a notification to all other coaches."
//
// The rule, enforced on the server by every route that writes
// RecurringClass.assignedStaffIds, ClassSession.staffOverride or
// EventStaffAssignment (lib/staffAssignments.ts lists them):
//
//   - `schedule:edit` (read LIVE) or OWNER  → a schedule manager. May add,
//     remove or replace anyone, themself included — managers create the
//     assignments, so there is nobody else to ask.
//   - everyone else                          → may make exactly ONE change:
//     take THEMSELF off (the whole series, one occurrence, or an event). The
//     other coaches of that class/event and the schedule managers are told.
//     They can never add themself, add or remove anyone else, or swap.
//
// `classes:edit` / `events:edit` no longer carry assignment rights on their
// own: they cover the class or event's details, not who is paid to work it.
//
// Pure — scripts/staff-authz-tests.ts covers it.

export type AssignmentVerdict =
  | "none"         // the list does not change
  | "manage"       // allowed: the caller is a schedule manager
  | "self_remove"  // allowed: the only change is the caller coming off
  | "deny";

export function assignmentVerdict(input: {
  /** OWNER, or STAFF with schedule:edit — resolved live by the caller. */
  canManage: boolean;
  actorId: string | null | undefined;
  before: readonly string[];
  after: readonly string[];
}): AssignmentVerdict {
  const before = new Set(input.before);
  const after = new Set(input.after);
  const added = Array.from(after).filter((id) => !before.has(id));
  const removed = Array.from(before).filter((id) => !after.has(id));
  if (added.length === 0 && removed.length === 0) return "none";
  if (input.canManage) return "manage";
  if (added.length === 0 && removed.length === 1 && !!input.actorId && removed[0] === input.actorId) {
    return "self_remove";
  }
  return "deny";
}

export const ASSIGNMENT_DENY_MESSAGE =
  "Only someone with schedule-management access can change who coaches this. You can take yourself off; ask a schedule manager for anything else.";
