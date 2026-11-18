// Push notifications — the rules, with no database and no network.
//
// Everything that decides WHAT is sent, to WHOM, and with WHICH words lives
// here so it can be tested without a phone (scripts/push-tests.ts). The part
// that talks to the database, Apple and Google is lib/pushServer.ts.
//
// The standing rules (docs/MOBILE-APP-PLAN-2026-11-15.md §11):
//   - The words on the lock screen are FIXED. No amounts, no health
//     information, no names, no dates. Most athletes are minors and a lock
//     screen is read by whoever is holding the phone.
//   - Push is never required. Every kind has its own off switch per person.
//   - A membership fact (when it ends, who pays) is read from the
//     subscription, never from a field on the member.

import { hasBillingSubScope, hasPermission, type PermissionKey, type PermissionLevel } from "@/lib/permissions";

// ── Kinds and words ────────────────────────────────────────────────────────

export const PUSH_KINDS = ["APPROVALS", "MESSAGES", "OFFLINE_MEMBERSHIP_ENDING"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export function isPushKind(v: unknown): v is PushKind {
  return typeof v === "string" && (PUSH_KINDS as readonly string[]).includes(v);
}

/** Who is reading it: someone who works at the club, or a family. */
export type PushAudience = "STAFF" | "FAMILY";

export function audienceForRole(role: string | null | undefined): PushAudience {
  return role === "OWNER" || role === "STAFF" ? "STAFF" : "FAMILY";
}

/** The only sentences a push may carry. */
export const PUSH_TEXT = {
  APPROVALS: "Something is waiting for your approval.",
  MESSAGES: "You have a new message.",
  OFFLINE_MEMBERSHIP_ENDING_STAFF: "A cash membership ends soon. Record payment or renew.",
  OFFLINE_MEMBERSHIP_ENDING_FAMILY: "Your membership needs a payment to continue.",
} as const;

export function pushText(kind: PushKind, audience: PushAudience): string {
  if (kind === "APPROVALS") return PUSH_TEXT.APPROVALS;
  if (kind === "MESSAGES") return PUSH_TEXT.MESSAGES;
  return audience === "STAFF" ? PUSH_TEXT.OFFLINE_MEMBERSHIP_ENDING_STAFF : PUSH_TEXT.OFFLINE_MEMBERSHIP_ENDING_FAMILY;
}

/** The title is the club's name and nothing else. */
export function pushTitle(clubName: string | null | undefined): string {
  const name = (clubName ?? "").trim();
  return name || "AthletixOS";
}

// ── Where a tap goes ───────────────────────────────────────────────────────

export const APPROVALS_PATH = "/dashboard/members/approvals";
export const FAMILY_MEMBERSHIPS_PATH = "/member/memberships";

export function memberBillingPath(memberId: string): string {
  return `/dashboard/members/${encodeURIComponent(memberId)}/billing`;
}

/** A one-to-one conversation, as each side opens it. Ids only, never names. */
export function dmPaths(input: { otherUserId: string; subjectMemberId?: string | null }): PushPath {
  const other = encodeURIComponent(input.otherUserId);
  const about = input.subjectMemberId ? `?about=${encodeURIComponent(input.subjectMemberId)}` : "";
  return { staff: "/dashboard/messages", member: `/member/messages/dm/${other}${about}` };
}

export function groupPaths(groupId: string): PushPath {
  const id = encodeURIComponent(groupId);
  return { staff: `/dashboard/messages?group=${id}`, member: `/member/messages/group/${id}` };
}

/** One path for everyone, or one per audience. */
export type PushPath = string | { staff: string; member: string };

export function resolvePushPath(path: PushPath, audience: PushAudience): string {
  if (typeof path === "string") return path;
  return audience === "STAFF" ? path.staff : path.member;
}

/**
 * The path a tap may open: a path on this site, and nothing else. A push
 * payload is data from outside the page, so it is never trusted to name
 * another site ("//evil.example", "https://…", "/\evil").
 */
export function safePushPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  if (path.length === 0 || path.length > 512) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.includes("://")) return null;
  return path;
}

// ── Who may receive what ───────────────────────────────────────────────────

/**
 * Every kind of thing that lands in the club's approvals queue, and the
 * permission that lets a staff member see it there. This is the ONE mapping:
 * GET /api/approvals builds its queue from it, and a push about an approval
 * goes to exactly the people that queue would show it to. Owners see all.
 *
 * The strings are the PendingApproval.kind values (lib/approvals.ts,
 * lib/guardianLink.ts, lib/membershipTransferKind.ts) plus the two queue rows
 * that are not PendingApproval rows. scripts/push-tests.ts checks they match.
 */
export type ApprovalGate =
  | { key: PermissionKey; level: PermissionLevel }
  | { billingSubScope: "transfer_subscription" };

export const APPROVAL_GATES = {
  GUARDIAN_LINK: [{ key: "members", level: "view" }],
  INVOICE_SPLIT: [{ key: "members", level: "view" }],
  MEMBERSHIP_CANCEL: [{ key: "finances", level: "view" }],
  MEMBERSHIP_PURCHASE: [{ key: "finances", level: "view" }],
  PRIVATE_PACKAGE_PURCHASE: [{ key: "finances", level: "view" }],
  MEMBERSHIP_TRANSFER: [{ billingSubScope: "transfer_subscription" }],
  MEMBERSHIP_AUTOPAY_CHANGE: [{ key: "billing", level: "view" }],
  MEMBERSHIP_CHANGE_REQUEST: [{ key: "billing", level: "view" }],
  // A member finished setting up and waits for the club to start billing
  // (Member.migrationStatus ACTIVATED + approvalStatus PENDING_APPROVAL).
  MIGRATION_BILLING: [{ key: "members", level: "edit" }],
  // A family asked for different terms on a reactivation offer.
  REACTIVATION_CHANGE_REQUEST: [{ key: "billing", level: "view" }, { key: "members", level: "edit" }],
} as const satisfies Record<string, readonly ApprovalGate[]>;

export type OwnerApprovalKind = keyof typeof APPROVAL_GATES;

/** The queue kinds that are stored as PendingApproval rows. */
export const PENDING_APPROVAL_QUEUE_KINDS = [
  "GUARDIAN_LINK",
  "INVOICE_SPLIT",
  "MEMBERSHIP_CANCEL",
  "MEMBERSHIP_PURCHASE",
  "PRIVATE_PACKAGE_PURCHASE",
  "MEMBERSHIP_TRANSFER",
  "MEMBERSHIP_AUTOPAY_CHANGE",
  "MEMBERSHIP_CHANGE_REQUEST",
] as const satisfies readonly OwnerApprovalKind[];

export function isOwnerApprovalKind(kind: string): kind is OwnerApprovalKind {
  return Object.prototype.hasOwnProperty.call(APPROVAL_GATES, kind);
}

type Perms = Record<string, unknown> | null | undefined;

/**
 * May this person see (and so be told about) this kind of approval?
 * Owners: always. Staff: when any gate for the kind passes. Everyone else,
 * and any kind not listed above (the family-side kinds in
 * lib/parentalControls MEMBER_APPROVAL_KINDS are deliberately not listed):
 * never.
 */
export function canSeeApprovalKind(role: string | null | undefined, perms: Perms, kind: string): boolean {
  if (!isOwnerApprovalKind(kind)) return false;
  if (role === "OWNER") return true;
  if (role !== "STAFF") return false;
  return (APPROVAL_GATES[kind] as readonly ApprovalGate[]).some((g) =>
    "billingSubScope" in g ? hasBillingSubScope(perms, g.billingSubScope) : hasPermission(perms, g.key, g.level),
  );
}

/** The PendingApproval kinds this person's queue is built from. */
export function visiblePendingApprovalKinds(role: string | null | undefined, perms: Perms): string[] {
  return PENDING_APPROVAL_QUEUE_KINDS.filter((k) => canSeeApprovalKind(role, perms, k));
}

/**
 * Can this person receive this kind of push at all? Decides which switches
 * they are shown, and is re-checked when sending.
 *   APPROVALS                 owner, or staff who can see at least one kind
 *   MESSAGES                  owner, staff who can open Messages, every family
 *   OFFLINE_MEMBERSHIP_ENDING owner, staff with billing access, every family
 */
export function canReceiveKind(role: string | null | undefined, perms: Perms, kind: PushKind): boolean {
  if (role === "OWNER") return true;
  if (role === "STAFF") {
    if (kind === "APPROVALS") return (Object.keys(APPROVAL_GATES) as OwnerApprovalKind[]).some((k) => canSeeApprovalKind(role, perms, k));
    if (kind === "MESSAGES") return hasPermission(perms, "messages", "view");
    return hasPermission(perms, "billing", "view");
  }
  if (role === "MEMBER") return kind === "MESSAGES" || kind === "OFFLINE_MEMBERSHIP_ENDING";
  return false;
}

export function receivableKinds(role: string | null | undefined, perms: Perms): PushKind[] {
  return PUSH_KINDS.filter((k) => canReceiveKind(role, perms, k));
}

/** How each switch reads on the settings card. */
export function kindLabel(kind: PushKind, audience: PushAudience): { title: string; description: string } {
  if (kind === "APPROVALS") return { title: "Approvals", description: "When something is waiting for your approval." };
  if (kind === "MESSAGES") return { title: "Messages", description: "When someone sends you a message." };
  return audience === "STAFF"
    ? { title: "Cash and check memberships", description: "When a cash or check membership is about to end." }
    : { title: "Membership payment reminders", description: "When a cash or check membership needs a payment to continue." };
}

export type PushPerson = { id: string; role: string | null | undefined; perms?: Perms };

/** Owners and permitted staff for one approval kind, never the person who asked. */
export function approvalRecipients(people: PushPerson[], approvalKind: string, excludeUserId?: string | null): string[] {
  return unique(
    people.filter((p) => p.id !== excludeUserId && canSeeApprovalKind(p.role, p.perms, approvalKind)).map((p) => p.id),
  );
}

/**
 * Who is told about a message: the people it was sent to, minus the sender.
 * A staff recipient who cannot open Messages is left out — the tap would land
 * on a page that refuses them.
 */
export function messageRecipients(people: PushPerson[], senderId: string): string[] {
  return unique(
    people.filter((p) => p.id !== senderId && canReceiveKind(p.role, p.perms, "MESSAGES")).map((p) => p.id),
  );
}

/** Owners and staff with billing access. */
export function offlineEndingStaffRecipients(people: PushPerson[]): string[] {
  return unique(
    people
      .filter((p) => (p.role === "OWNER" || p.role === "STAFF") && canReceiveKind(p.role, p.perms, "OFFLINE_MEMBERSHIP_ENDING"))
      .map((p) => p.id),
  );
}

/**
 * The paying family for one subscription: whoever the subscription says pays;
 * failing that the athlete's own login; failing that the confirmed guardians.
 */
export function offlineEndingFamilyUserIds(input: {
  payerUserId: string | null | undefined;
  memberUserId: string | null | undefined;
  guardianUserIds: readonly string[];
}): string[] {
  if (input.payerUserId) return [input.payerUserId];
  if (input.memberUserId) return [input.memberUserId];
  return unique(input.guardianUserIds.filter(Boolean));
}

/** Drop everyone who switched this kind off. No row means on. */
export function applyPreferences(
  userIds: readonly string[],
  prefs: readonly { userId: string; type: string; enabled: boolean }[],
  kind: PushKind,
): string[] {
  const off = new Set(prefs.filter((p) => p.type === kind && p.enabled === false).map((p) => p.userId));
  return unique(userIds.filter((id) => !off.has(id)));
}

function unique<T>(xs: readonly T[]): T[] {
  return Array.from(new Set(xs));
}

// ── Cash / check memberships about to end ──────────────────────────────────

export const OFFLINE_ENDING_LEAD_DAYS = 3;
export const OFFLINE_ENDING_TYPE = "OFFLINE_MEMBERSHIP_ENDING";

/** The subscription facts the reminder is decided from. Plain values only. */
export type OfflineSubscriptionFacts = {
  id: string;
  billingType: string | null;
  status: string | null;
  autoRenew: boolean;
  endDate: Date | null;
  stripeSubscriptionId: string | null;
  price: number;
  deliberateFree: boolean;
  pausedAt?: Date | null;
  /** True when a later membership on the same plan is already in place. */
  hasSuccessor?: boolean;
};

/**
 * Why a subscription is NOT one of these, or null when it is. Only a cash or
 * check membership that is active and will really stop on a known day counts.
 */
export function offlineEndingExclusion(s: OfflineSubscriptionFacts): string | null {
  if (s.stripeSubscriptionId) return "CARD_BILLED";
  if (s.billingType !== "MANUAL") return "NOT_CASH_OR_CHECK";
  if (s.deliberateFree) return "COMP";
  if (!(s.price > 0)) return "FREE";
  if (s.status !== "active") return "NOT_ACTIVE";
  if (s.autoRenew) return "RENEWS";
  if (!s.endDate) return "NO_END_DATE";
  if (s.pausedAt) return "PAUSED";
  if (s.hasSuccessor) return "ALREADY_RENEWED";
  return null;
}

/** YYYY-MM-DD of an end date. End dates are stored as calendar days. */
export function ymdOfEndDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD on the club's own calendar right now (UTC when no zone is set). */
export function clubTodayYmd(now: Date, timeZone: string | null | undefined): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const ymd = `${get("year")}-${get("month")}-${get("day")}`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
    } catch {
      /* unknown zone: fall through to UTC */
    }
  }
  return now.toISOString().slice(0, 10);
}

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole calendar days from the club's today to the end date. */
export function daysUntilEnd(endDate: Date, now: Date, timeZone: string | null | undefined): number {
  return Math.round((ymdToUtcMs(ymdOfEndDate(endDate)) - ymdToUtcMs(clubTodayYmd(now, timeZone))) / 86_400_000);
}

/**
 * Is the reminder due today? From three days before the end up to the day
 * before it. Not on the end day itself (the membership is ending, the moment
 * for a reminder has passed) and not earlier. The window is three days wide
 * rather than one so a missed daily run is caught the next day; the log row
 * (see offlineEndingDedupeKey) is what keeps it to one reminder.
 */
export function offlineEndingDue(s: OfflineSubscriptionFacts, now: Date, timeZone: string | null | undefined): boolean {
  if (offlineEndingExclusion(s) !== null || !s.endDate) return false;
  const days = daysUntilEnd(s.endDate, now, timeZone);
  return days >= 1 && days <= OFFLINE_ENDING_LEAD_DAYS;
}

/**
 * One reminder per membership period. The same subscription and end date give
 * the same key on every run; a renewed membership has a new end date and so a
 * new key.
 */
export function offlineEndingDedupeKey(subscriptionId: string, endDate: Date): string {
  return `offline-ending:${subscriptionId}:${ymdOfEndDate(endDate)}`;
}

// ── What is handed to Apple and Google ─────────────────────────────────────

export type PushMessage = { title: string; body: string; path: string; kind: PushKind };

export function buildPushMessage(input: { clubName: string | null | undefined; kind: PushKind; audience: PushAudience; path: PushPath }): PushMessage {
  return {
    title: pushTitle(input.clubName),
    body: pushText(input.kind, input.audience),
    path: resolvePushPath(input.path, input.audience),
    kind: input.kind,
  };
}

export const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
} as const;

export function apnsHost(environment: string | null | undefined): string {
  return environment === "development" ? APNS_HOSTS.development : APNS_HOSTS.production;
}

/** The request for one iPhone. `topic` is the app's bundle id. */
export function buildApnsRequest(input: { token: string; topic: string; message: PushMessage }): {
  path: string;
  headers: Record<string, string>;
  body: { aps: { alert: { title: string; body: string }; sound: string; "thread-id": string }; path: string; kind: string };
} {
  return {
    path: `/3/device/${encodeURIComponent(input.token)}`,
    headers: {
      "apns-topic": input.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
    },
    body: {
      aps: {
        alert: { title: input.message.title, body: input.message.body },
        sound: "default",
        "thread-id": input.message.kind,
      },
      path: input.message.path,
      kind: input.message.kind,
    },
  };
}

/** The request body for one Android phone (FCM HTTP v1). Data values are strings. */
export function buildFcmRequest(input: { token: string; message: PushMessage }): {
  message: {
    token: string;
    notification: { title: string; body: string };
    data: { path: string; kind: string };
    android: { priority: "HIGH" };
  };
} {
  return {
    message: {
      token: input.token,
      notification: { title: input.message.title, body: input.message.body },
      data: { path: input.message.path, kind: input.message.kind },
      android: { priority: "HIGH" },
    },
  };
}

/** Claims for Apple's provider token (ES256, signed in lib/pushServer). */
export function apnsJwtParts(input: { keyId: string; teamId: string; nowSeconds: number }): { header: object; claims: object } {
  return { header: { alg: "ES256", kid: input.keyId }, claims: { iss: input.teamId, iat: input.nowSeconds } };
}

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Claims for Google's service-account assertion (RS256, signed in lib/pushServer). */
export function fcmJwtParts(input: { clientEmail: string; keyId?: string | null; nowSeconds: number }): { header: object; claims: object } {
  return {
    header: { alg: "RS256", typ: "JWT", ...(input.keyId ? { kid: input.keyId } : {}) },
    claims: { iss: input.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: input.nowSeconds, exp: input.nowSeconds + 3600 },
  };
}

// ── What the answer means ──────────────────────────────────────────────────

/**
 * OK       delivered to Apple / Google
 * DEAD     this token will never work again: switch it off (never delete it)
 * FAILED   anything else: leave the token alone, it may work next time
 */
export type PushOutcome = { result: "OK" } | { result: "DEAD"; reason: string } | { result: "FAILED"; reason: string };

const APNS_DEAD_REASONS = new Set(["Unregistered", "BadDeviceToken"]);

export function classifyApnsResponse(status: number, reason: string | null | undefined): PushOutcome {
  if (status === 200) return { result: "OK" };
  const r = (reason ?? "").trim();
  if (status === 410) return { result: "DEAD", reason: r || "Unregistered" };
  if (APNS_DEAD_REASONS.has(r)) return { result: "DEAD", reason: r };
  return { result: "FAILED", reason: r || `HTTP ${status}` };
}

type FcmErrorBody = {
  error?: {
    status?: string;
    message?: string;
    details?: { errorCode?: string; fieldViolations?: { field?: string }[] }[];
  };
} | null | undefined;

export function classifyFcmResponse(status: number, body: unknown): PushOutcome {
  if (status >= 200 && status < 300) return { result: "OK" };
  const err = ((body as FcmErrorBody) ?? {})?.error ?? {};
  const details = Array.isArray(err.details) ? err.details : [];
  const errorCode = details.map((d) => d?.errorCode).find((c) => typeof c === "string") ?? null;
  if (errorCode === "UNREGISTERED") return { result: "DEAD", reason: "UNREGISTERED" };
  if (status === 404 || err.status === "NOT_FOUND") return { result: "DEAD", reason: "UNREGISTERED" };
  if (err.status === "INVALID_ARGUMENT" || errorCode === "INVALID_ARGUMENT") {
    // INVALID_ARGUMENT is also what a malformed payload gets. Only a complaint
    // about the TOKEN retires the token; otherwise one bad payload would
    // switch off every Android phone.
    const aboutToken =
      /registration token|not a valid FCM|message\.token/i.test(err.message ?? "") ||
      details.some((d) => (d?.fieldViolations ?? []).some((v) => /token/i.test(v?.field ?? "")));
    if (aboutToken) return { result: "DEAD", reason: "INVALID_ARGUMENT" };
  }
  return { result: "FAILED", reason: errorCode || err.status || `HTTP ${status}` };
}

// ── Device registration ────────────────────────────────────────────────────

export const DEVICE_PLATFORMS = ["IOS", "ANDROID"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEFAULT_APP_ID = "com.athletixos.app";
export const DEFAULT_APPLE_TEAM_ID = "J5TSB958YP";

/** A registration the server will accept, or null. */
export function parseDeviceRegistration(input: unknown): { token: string; platform: DevicePlatform; appId: string } | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const token = typeof o.token === "string" ? o.token.trim() : "";
  const platform = typeof o.platform === "string" ? o.platform.trim().toUpperCase() : "";
  const appId = typeof o.appId === "string" ? o.appId.trim() : "";
  if (token.length < 16 || token.length > 4096 || /\s/.test(token)) return null;
  if (!(DEVICE_PLATFORMS as readonly string[]).includes(platform)) return null;
  if (!/^[A-Za-z0-9._-]{3,200}$/.test(appId)) return null;
  return { token, platform: platform as DevicePlatform, appId };
}
