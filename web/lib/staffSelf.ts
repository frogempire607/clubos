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
