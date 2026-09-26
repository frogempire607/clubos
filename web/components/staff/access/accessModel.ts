// B21 — the Access tab's draft, pure. No React, no fetch: covered by
// scripts/staff-access-ui-tests.ts.
//
// The draft is the three things the manager PATCH on /api/staff/[id] stores
// in StaffProfile.permissions: one level per PERMISSION_CATALOG area, the
// messages_subScopes map and the billing_subScopes map.
import {
  PERMISSION_CATALOG,
  MESSAGES_SUBSCOPES,
  BILLING_SUBSCOPES,
  resolveMessagesSubScopes,
  resolveBillingSubScopes,
  type PermissionKey,
  type PermissionLevel,
  type MessagesSubScope,
  type BillingSubScope,
} from "../../../lib/permissions";
import type { AccessState } from "../../../lib/staffAccess";

export type LevelTone = "none" | "view" | "edit" | "full";

/** Same colours as the directory chips: `send` is the messaging name for the edit tier. */
export function levelTone(level: PermissionLevel): LevelTone {
  return level === "send" ? "edit" : level;
}

/** Token pairs (globals.css) for each tone — light and dark come from the tokens. */
export const TONE_STYLE: Record<LevelTone, { background: string; color: string }> = {
  none: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  view: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
  edit: { background: "var(--color-edit-surface)", color: "var(--color-edit-text)" },
  full: { background: "var(--color-success-surface)", color: "var(--color-success-text)" },
};

export const LEVEL_LABEL: Record<PermissionLevel, string> = {
  none: "None",
  view: "View",
  send: "Send",
  edit: "Edit",
  full: "Full",
};

export type AccessDraft = {
  levels: Record<PermissionKey, PermissionLevel>;
  messages: Record<MessagesSubScope, boolean>;
  billing: Record<BillingSubScope, boolean>;
};

/**
 * Draft from the profile payload. Sub-scopes resolve through the same
 * defaults the server's guards use (hasMessagesSubScope), so the switches
 * show what the staff member can actually do today, not "off" for unset keys.
 */
export function accessDraftFromStaff(staff: {
  permissions: Record<PermissionKey, PermissionLevel>;
  messagesSubScopes: Record<string, boolean> | null;
  billingSubScopes: Record<string, boolean> | null;
}): AccessDraft {
  const levels = {} as Record<PermissionKey, PermissionLevel>;
  for (const a of PERMISSION_CATALOG) levels[a.key] = staff.permissions[a.key] ?? "none";
  return {
    levels,
    messages: resolveMessagesSubScopes({ messages_subScopes: staff.messagesSubScopes }),
    billing: resolveBillingSubScopes({ billing_subScopes: staff.billingSubScopes }),
  };
}

/** Which areas get the in-place "Advanced" block, and when it is open. */
export function hasAdvanced(key: PermissionKey): key is "messages" | "billing" {
  return key === "messages" || key === "billing";
}
export function advancedOpen(key: PermissionKey, level: PermissionLevel): boolean {
  return hasAdvanced(key) && level !== "none";
}

/** True when this area's row differs from the saved state (level or its sub-options). */
export function areaChanged(saved: AccessDraft, draft: AccessDraft, key: PermissionKey): boolean {
  if (saved.levels[key] !== draft.levels[key]) return true;
  if (key === "messages") return MESSAGES_SUBSCOPES.some((s) => saved.messages[s] !== draft.messages[s]);
  if (key === "billing") return BILLING_SUBSCOPES.some((s) => saved.billing[s] !== draft.billing[s]);
  return false;
}

export function isAccessDirty(saved: AccessDraft, draft: AccessDraft): boolean {
  return PERMISSION_CATALOG.some((a) => areaChanged(saved, draft, a.key));
}

/** For describeAccessChanges() in lib/staffAccess.ts. */
export function toAccessState(d: AccessDraft): AccessState {
  return { levels: d.levels, messages: d.messages, billing: d.billing };
}

/** The `permissions` body for PATCH /api/staff/[id]. Always sends both maps:
 *  the server replaces the whole permissions blob, so leaving one out would drop it. */
export function accessPayload(d: AccessDraft): Record<string, unknown> {
  return { ...d.levels, messages_subScopes: { ...d.messages }, billing_subScopes: { ...d.billing } };
}

/** "Full in 4 areas · edit in 2 · view in 3 · none in 2" */
export function levelSummary(levels: Record<PermissionKey, PermissionLevel>): string {
  const n: Record<LevelTone, number> = { none: 0, view: 0, edit: 0, full: 0 };
  for (const a of PERMISSION_CATALOG) n[levelTone(levels[a.key] ?? "none")] += 1;
  return `Full in ${n.full} area${n.full === 1 ? "" : "s"} · edit in ${n.edit} · view in ${n.view} · none in ${n.none}`;
}
