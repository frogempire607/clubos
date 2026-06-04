// Single source of truth for the customizable owner dashboard.
// The page and the prefs API both import this so a widget added here
// automatically appears (at the end, visible) for existing users.

export type WidgetKind = "stat" | "section";

export type WidgetDef = {
  key: string;
  label: string;
  kind: WidgetKind;
  description: string;
};

// Order here is the out-of-the-box order for a brand-new club.
export const WIDGET_CATALOG: WidgetDef[] = [
  { key: "activeMembers", label: "Active members", kind: "stat", description: "Active vs. total members" },
  { key: "newMembers", label: "New members", kind: "stat", description: "Joined this month" },
  { key: "revenueMonth", label: "Revenue", kind: "stat", description: "Succeeded revenue this month" },
  { key: "netIncome", label: "Net income", kind: "stat", description: "Revenue minus expenses this month" },
  { key: "todayEvents", label: "Today's events", kind: "stat", description: "Events scheduled today" },
  { key: "upcomingEvents", label: "Upcoming events", kind: "stat", description: "Total events ahead" },
  { key: "attendanceMonth", label: "Attendance", kind: "stat", description: "Check-ins this month" },
  { key: "pendingPayments", label: "Pending payments", kind: "stat", description: "Registrants who owe money" },
  { key: "failedPayments", label: "Failed payments", kind: "stat", description: "Failed charges this month" },
  { key: "unreadMessages", label: "Unread messages", kind: "stat", description: "Direct messages to you" },
  { key: "docsNeedingSignatures", label: "Docs needing signatures", kind: "stat", description: "Outstanding required signatures" },
  { key: "calendar", label: "Mini calendar", kind: "section", description: "Month grid with event dots" },
  { key: "quickNav", label: "Quick navigation", kind: "section", description: "Shortcut cards to each section" },
  { key: "quickActions", label: "Quick actions", kind: "section", description: "Common create actions" },
  { key: "recentMembers", label: "Recent members", kind: "section", description: "Latest people who joined" },
  { key: "upcomingEventsList", label: "Upcoming events list", kind: "section", description: "Next events at a glance" },
  { key: "upcomingClassesList", label: "Upcoming classes", kind: "section", description: "Next class sessions" },
  { key: "recentMessages", label: "Recent messages", kind: "section", description: "Latest direct messages to you" },
  { key: "pendingBookings", label: "Recent bookings", kind: "section", description: "Latest event registrations and class bookings" },
  { key: "setupProgress", label: "Setup progress", kind: "section", description: "Onboarding / migration checklist" },
];

export const ALL_WIDGET_KEYS = WIDGET_CATALOG.map((w) => w.key);

// Sensible defaults that mirror the original fixed dashboard so existing
// clubs see no regression. Everything else is available but hidden.
export const DEFAULT_ORDER: string[] = [
  "activeMembers",
  "todayEvents",
  "revenueMonth",
  "upcomingEvents",
  "calendar",
  "quickNav",
  "recentMessages",
  "pendingBookings",
  "recentMembers",
  "upcomingEventsList",
];

export const DEFAULT_HIDDEN: string[] = ALL_WIDGET_KEYS.filter(
  (k) => !DEFAULT_ORDER.includes(k),
);

export type WidgetPrefs = { order: string[]; hidden: string[] };

// Merge stored prefs with the catalog: drop unknown keys, append any newly
// introduced widgets to the end so they show up without a migration.
export function resolvePrefs(raw: unknown): WidgetPrefs {
  const rawObj = (raw && typeof raw === "object" ? raw : {}) as {
    order?: unknown;
    hidden?: unknown;
  };
  const savedOrder = Array.isArray(rawObj.order)
    ? (rawObj.order as unknown[]).filter((k): k is string => typeof k === "string")
    : null;
  const savedHidden = Array.isArray(rawObj.hidden)
    ? (rawObj.hidden as unknown[]).filter((k): k is string => typeof k === "string")
    : null;

  if (!savedOrder && !savedHidden) {
    return { order: [...DEFAULT_ORDER], hidden: [...DEFAULT_HIDDEN] };
  }

  const known = new Set(ALL_WIDGET_KEYS);
  const order = (savedOrder ?? DEFAULT_ORDER).filter((k) => known.has(k));
  const hidden = (savedHidden ?? []).filter((k) => known.has(k));

  // Any catalog widget not referenced anywhere is appended as visible.
  for (const k of ALL_WIDGET_KEYS) {
    if (!order.includes(k) && !hidden.includes(k)) order.push(k);
  }
  return { order, hidden };
}
