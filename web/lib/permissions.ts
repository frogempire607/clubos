// Canonical staff permission model. One source of truth for the keys, the
// level ordering, sensible defaults, the nav→permission map, and the
// server-side guard. Owners always bypass every check.

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

// Nav / route path → required permission. ownerOnly entries are hidden from
// staff entirely. Order matters: longest prefix wins (checked by caller).
export type NavRule = { key: PermissionKey; level: PermissionLevel } | { ownerOnly: true };

export const PATH_PERMISSIONS: { prefix: string; rule: NavRule }[] = [
  { prefix: "/dashboard/settings", rule: { ownerOnly: true } },
  { prefix: "/dashboard/staff/payroll", rule: { key: "finances", level: "view" } },
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
