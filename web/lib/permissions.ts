// Canonical staff permission model. One source of truth for the keys, the
// level ordering, sensible defaults, the nav→permission map, and the
// server-side guard. Owners always bypass every check.
//
// Sub-scope model (plan §3L, added session 2):
//   The `messages` key can carry a nested object of feature-flag booleans
//   under `messages.subScopes` so staff can have (say) messages:send but
//   not messages.bulk. Storage: JSON blob on StaffProfile.permissions —
//   backward compatible with the old string-only shape.
//
//   Example StaffProfile.permissions value:
//     {
//       "members": "view", "attendance": "full", ...,
//       "messages": "send",                            // legacy string still honored
//       "messages_subScopes": {                        // NEW
//         "bulk": false, "marketing": false,
//         "templates": true, "images": true,
//         "unsubscribe": false, "analytics": false,
//         "approve": false, "audience_all_club": false
//       }
//     }
//
//   `hasSubScope(perms, "bulk")` is the caller — level-check is separate.
//   A coach with `messages:send` + `bulk:false` can DM one member but
//   cannot use the Members-page bulk composer.

export type PermissionLevel = "none" | "view" | "send" | "edit" | "full";

// Rank used for "at least" comparisons. `send` and `edit` are the same tier
// (a capability beyond read, below full control) just named per domain.
const RANK: Record<PermissionLevel, number> = {
  none: 0,
  view: 1,
  send: 2,
  edit: 2,
  full: 3,
};

export type PermissionKey =
  | "members"
  | "attendance"
  | "classes"
  | "events"
  | "schedule"
  | "messages"
  | "documents"
  | "finances"
  | "billing"
  | "reports"
  | "staff";

// label + the levels that make sense for this domain (drives the editor UI).
export const PERMISSION_CATALOG: {
  key: PermissionKey;
  label: string;
  description: string;
  levels: PermissionLevel[];
}[] = [
  { key: "members", label: "Members", description: "View / edit member profiles", levels: ["none", "view", "edit", "full"] },
  { key: "attendance", label: "Attendance", description: "Take and edit attendance", levels: ["none", "edit", "full"] },
  { key: "classes", label: "Classes", description: "Manage recurring classes", levels: ["none", "view", "edit", "full"] },
  { key: "events", label: "Events & purchase options", description: "Manage events, memberships, products", levels: ["none", "view", "edit", "full"] },
  { key: "schedule", label: "Staff schedule", description: "View / edit the staff schedule & availability", levels: ["none", "view", "edit"] },
  { key: "messages", label: "Messaging", description: "Message members & post announcements", levels: ["none", "view", "send", "full"] },
  { key: "documents", label: "Documents", description: "View / edit waivers & forms", levels: ["none", "view", "edit", "full"] },
  { key: "finances", label: "Financials & payroll", description: "Revenue, transactions, payouts", levels: ["none", "view", "full"] },
  // Explicit, opt-in financial control over MEMBER billing: membership plans/
  // prices/dates, payment-method management, and reactivation offers. Distinct
  // from `finances` (reporting/payroll) so a coach with day-to-day access never
  // silently gains the power to change what a client is charged.
  { key: "billing", label: "Billing management", description: "Member billing setup, payment methods, reactivation", levels: ["none", "view", "full"] },
  { key: "reports", label: "Reports", description: "View club reports", levels: ["none", "view"] },
  { key: "staff", label: "Staff & contractors", description: "Manage staff and contractors", levels: ["none", "view", "full"] },
];

export const PERMISSION_KEYS: PermissionKey[] = PERMISSION_CATALOG.map((p) => p.key);

// Default for a brand-new staff invite: can run day-to-day floor operations,
// no money / staff / reports visibility.
export const DEFAULT_PERMISSIONS: Record<PermissionKey, PermissionLevel> = {
  members: "view",
  attendance: "full",
  classes: "view",
  events: "view",
  schedule: "view",
  messages: "send",
  documents: "view",
  finances: "none",
  billing: "none",
  reports: "none",
  staff: "none",
};

// Backward-compatible: older profiles only stored
// {members,events,messages,finances,documents,staff}. Fill any missing key
// from defaults; coerce unknown values to "none".
export function resolvePermissions(raw: unknown): Record<PermissionKey, PermissionLevel> {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as Record<PermissionKey, PermissionLevel>;
  for (const key of PERMISSION_KEYS) {
    const v = obj[key];
    out[key] =
      v === "none" || v === "view" || v === "send" || v === "edit" || v === "full"
        ? (v as PermissionLevel)
        : DEFAULT_PERMISSIONS[key];
  }
  return out;
}

export function hasPermission(
  perms: Record<string, unknown> | null | undefined,
  key: PermissionKey,
  minLevel: PermissionLevel,
): boolean {
  const resolved = resolvePermissions(perms);
  return RANK[resolved[key]] >= RANK[minLevel];
}

// ── Messaging sub-scopes (plan §3L) ─────────────────────────────────────
//
// Sub-scope IDs the codebase reads. Owners always have every sub-scope.
// Staff sub-scope defaults align with DEFAULT_MESSAGES_SUBSCOPES below —
// a coach with `messages:send` gets DMs + templates + images by default,
// and MUST be opted-in to bulk/marketing/unsubscribe/analytics/approve.
export type MessagesSubScope =
  | "bulk"           // Send bulk email from Members page (plan §3A)
  | "marketing"      // Manage audiences + marketing campaigns (plan §3D)
  | "templates"      // Edit templates (plan §3C)
  | "images"         // Upload images for email (plan §3J)
  | "unsubscribe"    // Manage the club's opt-out list (plan §3I)
  | "analytics"      // View campaign results + history (plan §3G)
  | "approve"        // Approve pending campaigns for send (plan §3H)
  | "audience_all_club"; // Send to any member (unset = "coach audience only",
                          // enforced by lib/coachAudience.ts)

export const MESSAGES_SUBSCOPES: MessagesSubScope[] = [
  "bulk", "marketing", "templates", "images",
  "unsubscribe", "analytics", "approve", "audience_all_club",
];

// Defaults for a new staff invite when they have messages != "none". The
// principle: day-to-day DMs + templates + images are safe; anything with
// blast-radius (bulk, marketing, approve) or PII surface (unsubscribe,
// analytics) needs explicit opt-in. `audience_all_club` off = coach can
// only email members enrolled in classes they teach (plan §3L example:
// "a coach may email athletes assigned to their program without seeing
// the entire club's member list or financial information").
export const DEFAULT_MESSAGES_SUBSCOPES: Record<MessagesSubScope, boolean> = {
  bulk: false,
  marketing: false,
  templates: true,
  images: true,
  unsubscribe: false,
  analytics: false,
  approve: false,
  audience_all_club: false,
};

// True when the staff user has the messages sub-scope enabled. OWNER
// bypass happens at the call site (see hasMessagesSubScope() below —
// this pure predicate only inspects the permission blob).
export function hasMessagesSubScope(
  perms: Record<string, unknown> | null | undefined,
  scope: MessagesSubScope,
): boolean {
  const obj = (perms && typeof perms === "object" ? perms : {}) as Record<string, unknown>;
  const raw = obj["messages_subScopes"];
  const sub = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const v = sub[scope];
  if (typeof v === "boolean") return v;
  return DEFAULT_MESSAGES_SUBSCOPES[scope];
}

// Resolve every sub-scope to a boolean map (for the staff editor UI).
export function resolveMessagesSubScopes(
  perms: Record<string, unknown> | null | undefined,
): Record<MessagesSubScope, boolean> {
  const out = {} as Record<MessagesSubScope, boolean>;
  for (const s of MESSAGES_SUBSCOPES) out[s] = hasMessagesSubScope(perms, s);
  return out;
}

// ── Billing sub-scopes (Phase 4A) ───────────────────────────────────────
//
// Same nested-JSON pattern as messages_subScopes above — no migration.
//
// `transfer_subscription` is the "assign this membership to another family
// member" power. It is deliberately NOT folded into billing:full: moving a
// membership between athletes is a narrow, high-trust correction (a parent
// bought under their own profile by mistake) that a front-desk lead may need
// without also getting the ability to change prices, cards, and plans. Off by
// default — an owner grants it explicitly.
export type BillingSubScope = "transfer_subscription";

export const BILLING_SUBSCOPES: BillingSubScope[] = ["transfer_subscription"];

export const DEFAULT_BILLING_SUBSCOPES: Record<BillingSubScope, boolean> = {
  transfer_subscription: false,
};

// Pure predicate over the permission blob. OWNER bypass happens at the call
// site, exactly like hasMessagesSubScope.
export function hasBillingSubScope(
  perms: Record<string, unknown> | null | undefined,
  scope: BillingSubScope,
): boolean {
  const obj = (perms && typeof perms === "object" ? perms : {}) as Record<string, unknown>;
  const raw = obj["billing_subScopes"];
  const sub = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const v = sub[scope];
  if (typeof v === "boolean") return v;
  return DEFAULT_BILLING_SUBSCOPES[scope];
}

export function resolveBillingSubScopes(
  perms: Record<string, unknown> | null | undefined,
): Record<BillingSubScope, boolean> {
  const out = {} as Record<BillingSubScope, boolean>;
  for (const s of BILLING_SUBSCOPES) out[s] = hasBillingSubScope(perms, s);
  return out;
}

// Nav / route path → required permission. ownerOnly entries are hidden from
// staff entirely. Order matters: longest prefix wins (checked by caller).
export type NavRule = { key: PermissionKey; level: PermissionLevel } | { ownerOnly: true };

export const PATH_PERMISSIONS: { prefix: string; rule: NavRule }[] = [
  { prefix: "/dashboard/settings", rule: { ownerOnly: true } },
  { prefix: "/dashboard/staff/payroll", rule: { key: "finances", level: "view" } },
  { prefix: "/dashboard/staff/payouts", rule: { key: "finances", level: "view" } },
  { prefix: "/dashboard/staff/schedule", rule: { key: "schedule", level: "view" } },
  { prefix: "/dashboard/staff/availability", rule: { key: "schedule", level: "view" } },
  { prefix: "/dashboard/staff/contractors", rule: { key: "staff", level: "full" } },
  { prefix: "/dashboard/staff", rule: { key: "staff", level: "view" } },
  { prefix: "/dashboard/members", rule: { key: "members", level: "view" } },
  { prefix: "/dashboard/classes", rule: { key: "classes", level: "view" } },
  { prefix: "/dashboard/events", rule: { key: "events", level: "view" } },
  { prefix: "/dashboard/purchase-options", rule: { key: "events", level: "view" } },
  { prefix: "/dashboard/memberships", rule: { key: "events", level: "view" } },
  { prefix: "/dashboard/privates", rule: { key: "events", level: "view" } },
  { prefix: "/dashboard/products", rule: { key: "events", level: "view" } },
  { prefix: "/dashboard/calendar", rule: { key: "schedule", level: "view" } },
  { prefix: "/dashboard/communication", rule: { key: "messages", level: "view" } },
  { prefix: "/dashboard/messages", rule: { key: "messages", level: "view" } },
  { prefix: "/dashboard/announcements", rule: { key: "messages", level: "view" } },
  { prefix: "/dashboard/attendance", rule: { key: "attendance", level: "edit" } },
  { prefix: "/dashboard/financials", rule: { key: "finances", level: "view" } },
  { prefix: "/dashboard/reports", rule: { key: "reports", level: "view" } },
  { prefix: "/dashboard/documents", rule: { key: "documents", level: "view" } },
  // /dashboard (home) intentionally has no rule — always allowed.
];

// Resolve the rule that applies to a path (longest matching prefix).
export function ruleForPath(pathname: string): NavRule | null {
  let best: { prefix: string; rule: NavRule } | null = null;
  for (const entry of PATH_PERMISSIONS) {
    if (pathname === entry.prefix || pathname.startsWith(entry.prefix + "/") || pathname.startsWith(entry.prefix)) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  return best?.rule ?? null;
}

// True if a (role, permissions) pair may access a path.
export function canAccessPath(
  role: string | undefined,
  perms: Record<string, unknown> | null | undefined,
  pathname: string,
): boolean {
  if (role === "OWNER") return true;
  if (role !== "STAFF") return false;
  const rule = ruleForPath(pathname);
  if (!rule) return true; // unguarded dashboard pages (e.g. home)
  if ("ownerOnly" in rule) return false;
  return hasPermission(perms, rule.key, rule.level);
}
