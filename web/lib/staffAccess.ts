// B21 — plain-English wording for staff access levels, and the list of
// changes an owner is about to make (the Access tab's confirm step and the
// Recent activity lines both come from here). Pure; tested in
// scripts/staff-self-tests.ts.
import {
  PERMISSION_CATALOG, MESSAGES_SUBSCOPES, BILLING_SUBSCOPES,
  resolvePermissions, levelRank, hasMessagesSubScope, hasBillingSubScope,
  type PermissionKey, type PermissionLevel, type MessagesSubScope, type BillingSubScope,
} from "@/lib/permissions";

/** What each level means, per area — only the levels the catalog offers. */
export const LEVEL_MEANING: Record<PermissionKey, Partial<Record<PermissionLevel, string>>> = {
  members:    { none: "can't open member profiles", view: "can look up member profiles", edit: "can edit member profiles", full: "can edit and archive members" },
  attendance: { none: "can't take attendance", edit: "can take and fix attendance", full: "can take attendance and charge drop-ins" },
  classes:    { none: "can't see classes", view: "can see the class list", edit: "can edit classes", full: "can create, edit and delete classes" },
  events:     { none: "can't see events or purchase options", view: "can see events and purchase options", edit: "can edit events and purchase options", full: "can create, edit and delete events and purchase options" },
  schedule:   { none: "can't see the staff schedule", view: "can see the staff schedule", edit: "can assign classes and edit everyone's availability" },
  messages:   { none: "can't use messaging", view: "can read messages", send: "can message members", full: "can message members and post announcements" },
  documents:  { none: "can't see documents", view: "can see waivers and forms", edit: "can edit waivers and forms", full: "can create, edit and delete documents" },
  finances:   { none: "can't see money", view: "can see revenue, transactions and payroll", full: "can see and record revenue, payroll and payouts" },
  billing:    { none: "can't change member billing", view: "can see member billing", full: "can see and edit every member's plans, prices and payment methods" },
  reports:    { none: "can't see reports", view: "can see club reports" },
  staff:      { none: "can't see the staff list", view: "can see the staff list", full: "can add staff and change their access" },
};

export const MONEY_AREAS: ReadonlySet<PermissionKey> = new Set(["finances", "billing"]);

export const MESSAGES_SUBSCOPE_LABEL: Record<MessagesSubScope, string> = {
  bulk: "send to many members at once",
  marketing: "send marketing emails",
  templates: "use email templates",
  images: "add images to emails",
  unsubscribe: "manage the unsubscribe list",
  analytics: "see email results",
  approve: "approve campaigns before they send",
  audience_all_club: "email any member (not only their own athletes)",
};

export const BILLING_SUBSCOPE_LABEL: Record<BillingSubScope, string> = {
  transfer_subscription: "move a membership to another athlete in the family",
};

export type AccessState = {
  levels: Partial<Record<PermissionKey, PermissionLevel>>;
  messages?: Partial<Record<MessagesSubScope, boolean>> | null;
  billing?: Partial<Record<BillingSubScope, boolean>> | null;
};

export type AccessChange = {
  key: string;
  money: boolean;
  /** Sentence about the staff member, e.g. "Sal will be able to …". */
  sentence: string;
  /** Activity-log line, e.g. "Changed Billing management from None to Full". */
  logLine: string;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function describeAccessChanges(firstName: string, before: AccessState, after: AccessState): AccessChange[] {
  const out: AccessChange[] = [];
  for (const area of PERMISSION_CATALOG) {
    const a = before.levels[area.key] ?? "none";
    const b = after.levels[area.key] ?? "none";
    if (a === b) continue;
    const meaning = LEVEL_MEANING[area.key][b] ?? b;
    const verb = meaning.startsWith("can't") ? meaning.replace(/^can't/, "will no longer be able to") : meaning.replace(/^can /, "will be able to ");
    out.push({
      key: area.key,
      money: MONEY_AREAS.has(area.key),
      sentence: `${firstName} ${verb}.`,
      logLine: `Changed ${area.label} from ${cap(a)} to ${cap(b)}`,
    });
  }
  const subs = (
    kind: "messages" | "billing",
    keys: readonly string[],
    labels: Record<string, string>,
    areaLabel: string,
  ) => {
    const x = (before[kind] ?? {}) as Record<string, boolean | undefined>;
    const y = (after[kind] ?? {}) as Record<string, boolean | undefined>;
    for (const k of keys) {
      const on0 = x[k] === true;
      const on1 = y[k] === true;
      if (on0 === on1) continue;
      out.push({
        key: `${kind}.${k}`,
        money: kind === "billing",
        sentence: on1 ? `${firstName} will be able to ${labels[k]}.` : `${firstName} will no longer be able to ${labels[k]}.`,
        logLine: `${on1 ? "Turned on" : "Turned off"} ${areaLabel}: ${labels[k]}`,
      });
    }
  };
  subs("messages", MESSAGES_SUBSCOPES, MESSAGES_SUBSCOPE_LABEL, "Messaging");
  subs("billing", BILLING_SUBSCOPES, BILLING_SUBSCOPE_LABEL, "Billing");
  return out;
}

/** Read the stored permissions JSON into an AccessState. */
export function accessStateFromJson(raw: unknown, resolved: Record<PermissionKey, PermissionLevel>): AccessState {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, boolean>) : null);
  return { levels: resolved, messages: pick(obj.messages_subScopes), billing: pick(obj.billing_subScopes) };
}

// ── No privilege escalation (2026-10-07) ────────────────────────────────────
//
// A staff manager (Staff & contractors: full) who is NOT an owner can hand out
// access — but never more than they hold themselves. Without this, staff:full
// was a master key: grant a second login `finances:full`, or raise a friend's
// billing access, and the manager's own limits meant nothing.
//
// The rule, per area and per sub-scope switch:
//   a change is refused when it RAISES the target above the manager's own
//   level. Leaving a level alone or lowering it is always fine — a manager
//   can still narrow someone who already has more than they do.
//
// `before` is the target's stored permissions (null/{} for a brand-new
// invite, which is treated as "nothing yet" so every default is a grant).
// Returns human labels of what was refused; empty = allowed. Pure.
export function accessAboveOwn(
  actorRaw: Record<string, unknown> | null | undefined,
  beforeRaw: Record<string, unknown> | null | undefined,
  afterRaw: Record<string, unknown> | null | undefined,
  opts?: { newAccount?: boolean },
): string[] {
  const actor = resolvePermissions(actorRaw ?? null);
  const after = resolvePermissions(afterRaw ?? null);
  const before = opts?.newAccount ? null : resolvePermissions(beforeRaw ?? null);
  const out: string[] = [];
  for (const area of PERMISSION_CATALOG) {
    const a = levelRank(after[area.key]);
    const b = before ? levelRank(before[area.key]) : 0;
    if (a > b && a > levelRank(actor[area.key])) out.push(`${area.label}: ${cap(after[area.key])}`);
  }
  // Sub-scope switches only count when the area itself is on for the target.
  if (levelRank(after.messages) > 0) {
    for (const s of MESSAGES_SUBSCOPES) {
      const on = hasMessagesSubScope(afterRaw ?? null, s);
      const was = !opts?.newAccount && levelRank(before?.messages) > 0 && hasMessagesSubScope(beforeRaw ?? null, s);
      const mine = levelRank(actor.messages) > 0 && hasMessagesSubScope(actorRaw ?? null, s);
      if (on && !was && !mine) out.push(`Messaging: ${MESSAGES_SUBSCOPE_LABEL[s]}`);
    }
  }
  for (const s of BILLING_SUBSCOPES) {
    const on = hasBillingSubScope(afterRaw ?? null, s);
    const was = !opts?.newAccount && hasBillingSubScope(beforeRaw ?? null, s);
    if (on && !was && !hasBillingSubScope(actorRaw ?? null, s)) out.push(`Billing: ${BILLING_SUBSCOPE_LABEL[s]}`);
  }
  return out;
}

export function accessAboveOwnMessage(refused: string[]): string {
  return `You can't give someone more access than you have yourself (${refused.join("; ")}). Ask an owner.`;
}
