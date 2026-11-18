// Push notifications — the part that touches the database, Apple and Google.
// The rules (who, what words, which path) are in lib/push.ts and are pure.
//
// THREE PROMISES THIS FILE KEEPS
//
//   1. A push can never fail or meaningfully slow the request that caused it.
//      Every exported notify* function catches everything, never rejects, and
//      gives up after PUSH_BUDGET_MS. Callers `await` it (on Netlify a promise
//      left running after the response is frozen with the function, so
//      "fire and forget" would mean "usually never sent") and get control back
//      within the budget whatever Apple or Google are doing.
//
//   2. It ships dark. With no APNs key and no Firebase service account in the
//      environment, sendPushToUsers returns before its first database query.
//
//   3. A token Apple or Google reports dead is switched off (disabledAt +
//      disabledReason), never deleted.
//
// No dependencies: APNs is node:http2 with an ES256 token, FCM is the HTTP v1
// API with a service-account RS256 assertion, both signed with node:crypto.
//
// NOTHING HERE HAS BEEN SENT TO A REAL PHONE. The request shapes follow Apple's
// and Google's published APIs and are covered by scripts/push-tests.ts, but the
// first real delivery will be the first time this code meets the providers.

import { createSign } from "node:crypto";
import http2 from "node:http2";
import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";
import { eligibleEventChatUserIds } from "@/lib/eventChat";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { emailDate } from "@/lib/emailTime";
import {
  APPROVALS_PATH,
  DEFAULT_APPLE_TEAM_ID,
  DEFAULT_APP_ID,
  FAMILY_MEMBERSHIPS_PATH,
  GOOGLE_TOKEN_URL,
  OFFLINE_ENDING_LEAD_DAYS,
  OFFLINE_ENDING_TYPE,
  apnsHost,
  apnsJwtParts,
  applyPreferences,
  approvalRecipients,
  audienceForRole,
  buildApnsRequest,
  buildFcmRequest,
  buildPushMessage,
  canReceiveKind,
  classifyApnsResponse,
  classifyFcmResponse,
  dmPaths,
  fcmJwtParts,
  groupPaths,
  memberBillingPath,
  messageRecipients,
  offlineEndingDedupeKey,
  offlineEndingDue,
  offlineEndingFamilyUserIds,
  offlineEndingStaffRecipients,
  type PushKind,
  type PushMessage,
  type PushOutcome,
  type PushPath,
  type PushPerson,
} from "@/lib/push";

/** How long a user-facing request will wait on a push before moving on. */
export const PUSH_BUDGET_MS = 2500;
/** How long one provider call may take. */
const PROVIDER_TIMEOUT_MS = 2000;

// ── Configuration (environment only) ───────────────────────────────────────

type ApnsConfig = { keyId: string; privateKey: string; teamId: string; bundleId: string; host: string };
type FcmConfig = { projectId: string; clientEmail: string; privateKey: string; keyId: string | null };

/** A PEM pasted into an environment variable often arrives with literal "\n". */
function pem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function apnsConfig(): ApnsConfig | null {
  const keyId = (process.env.APNS_KEY_ID ?? "").trim();
  const privateKey = (process.env.APNS_PRIVATE_KEY ?? "").trim();
  if (!keyId || !privateKey) return null;
  return {
    keyId,
    privateKey: pem(privateKey),
    teamId: (process.env.APPLE_TEAM_ID ?? "").trim() || DEFAULT_APPLE_TEAM_ID,
    bundleId: (process.env.APNS_BUNDLE_ID ?? "").trim() || DEFAULT_APP_ID,
    host: apnsHost((process.env.APNS_ENVIRONMENT ?? "").trim()),
  };
}

function fcmConfig(): FcmConfig | null {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string; private_key_id?: string };
    if (!j.project_id || !j.client_email || !j.private_key) return null;
    return { projectId: j.project_id, clientEmail: j.client_email, privateKey: pem(j.private_key), keyId: j.private_key_id ?? null };
  } catch {
    // Never log the value: it is a private key.
    console.error("[push] FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON; Android push is off.");
    return null;
  }
}

export function pushConfigured(): { ios: boolean; android: boolean } {
  return { ios: apnsConfig() !== null, android: fcmConfig() !== null };
}

// ── Provider tokens (cached per warm instance) ─────────────────────────────

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

function signJwt(parts: { header: object; claims: object }, alg: "ES256" | "RS256", privateKey: string): string {
  const input = `${b64url(JSON.stringify(parts.header))}.${b64url(JSON.stringify(parts.claims))}`;
  const signer = createSign(alg === "ES256" ? "SHA256" : "RSA-SHA256");
  signer.update(input);
  const signature = alg === "ES256" ? signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }) : signer.sign(privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

// Apple wants the provider token reused for at least 20 minutes and refuses
// one older than 60. Fifty minutes sits between the two.
const APNS_JWT_TTL_MS = 50 * 60 * 1000;
let apnsJwtCache: { key: string; jwt: string; at: number } | null = null;

function apnsJwt(cfg: ApnsConfig): string {
  const cacheKey = `${cfg.teamId}:${cfg.keyId}`;
  const now = Date.now();
  if (apnsJwtCache && apnsJwtCache.key === cacheKey && now - apnsJwtCache.at < APNS_JWT_TTL_MS) return apnsJwtCache.jwt;
  const jwt = signJwt(apnsJwtParts({ keyId: cfg.keyId, teamId: cfg.teamId, nowSeconds: Math.floor(now / 1000) }), "ES256", cfg.privateKey);
  apnsJwtCache = { key: cacheKey, jwt, at: now };
  return jwt;
}

let fcmTokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function fcmAccessToken(cfg: FcmConfig): Promise<string> {
  const now = Date.now();
  if (fcmTokenCache && fcmTokenCache.key === cfg.clientEmail && fcmTokenCache.expiresAt - 60_000 > now) return fcmTokenCache.token;
  const assertion = signJwt(fcmJwtParts({ clientEmail: cfg.clientEmail, keyId: cfg.keyId, nowSeconds: Math.floor(now / 1000) }), "RS256", cfg.privateKey);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!res.ok || !body?.access_token) throw new Error(`Google token exchange failed (HTTP ${res.status})`);
  fcmTokenCache = { key: cfg.clientEmail, token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

// ── Provider clients ───────────────────────────────────────────────────────

type DeviceRow = { id: string; userId: string; platform: string; appId: string; token: string };
type Delivery = { device: DeviceRow; outcome: PushOutcome };

async function sendApns(cfg: ApnsConfig, jobs: { device: DeviceRow; message: PushMessage }[]): Promise<Delivery[]> {
  if (jobs.length === 0) return [];
  const failAll = (reason: string): Delivery[] => jobs.map((j) => ({ device: j.device, outcome: { result: "FAILED", reason } }));
  let jwt: string;
  try {
    jwt = apnsJwt(cfg);
  } catch {
    console.error("[push] could not sign the APNs token; check APNS_PRIVATE_KEY is the .p8 contents.");
    return failAll("JWT");
  }

  let session: http2.ClientHttp2Session;
  try {
    session = http2.connect(cfg.host);
  } catch {
    return failAll("CONNECT");
  }
  // One error handler for the whole session, so a dropped connection is an
  // outcome on each request and never an unhandled 'error' event.
  session.on("error", () => undefined);

  const one = (job: { device: DeviceRow; message: PushMessage }) =>
    new Promise<Delivery>((resolve) => {
      let settled = false;
      const done = (outcome: PushOutcome) => {
        if (settled) return;
        settled = true;
        resolve({ device: job.device, outcome });
      };
      try {
        const r = buildApnsRequest({ token: job.device.token, topic: job.device.appId || cfg.bundleId, message: job.message });
        const req = session.request({ ":method": "POST", ":path": r.path, authorization: `bearer ${jwt}`, "content-type": "application/json", ...r.headers });
        let status = 0;
        let data = "";
        req.setEncoding("utf8");
        req.setTimeout(PROVIDER_TIMEOUT_MS, () => { req.close(http2.constants.NGHTTP2_CANCEL); done({ result: "FAILED", reason: "TIMEOUT" }); });
        req.on("response", (headers) => { status = Number(headers[":status"]) || 0; });
        req.on("data", (chunk: string) => { data += chunk; });
        req.on("error", () => done({ result: "FAILED", reason: "NETWORK" }));
        req.on("close", () => done({ result: "FAILED", reason: "CLOSED" }));
        req.on("end", () => {
          let reason: string | null = null;
          try { reason = data ? ((JSON.parse(data) as { reason?: string }).reason ?? null) : null; } catch { /* not JSON */ }
          done(classifyApnsResponse(status, reason));
        });
        req.end(JSON.stringify(r.body));
      } catch {
        done({ result: "FAILED", reason: "REQUEST" });
      }
    });

  try {
    return await Promise.all(jobs.map(one));
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
}

async function sendFcm(cfg: FcmConfig, jobs: { device: DeviceRow; message: PushMessage }[]): Promise<Delivery[]> {
  if (jobs.length === 0) return [];
  let accessToken: string;
  try {
    accessToken = await fcmAccessToken(cfg);
  } catch (err) {
    console.error("[push] could not get a Google access token:", err instanceof Error ? err.message : "unknown error");
    return jobs.map((j) => ({ device: j.device, outcome: { result: "FAILED", reason: "AUTH" } }));
  }
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`;
  return Promise.all(
    jobs.map(async (job): Promise<Delivery> => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(buildFcmRequest({ token: job.device.token, message: job.message })),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
        const body = await res.json().catch(() => null);
        return { device: job.device, outcome: classifyFcmResponse(res.status, body) };
      } catch {
        return { device: job.device, outcome: { result: "FAILED", reason: "NETWORK" } };
      }
    }),
  );
}

// ── The one send function ──────────────────────────────────────────────────

export type PushSendResult = { configured: boolean; recipients: number; devices: number; sent: number; failed: number; disabled: number };

const NOTHING: PushSendResult = { configured: false, recipients: 0, devices: 0, sent: 0, failed: 0, disabled: 0 };

/**
 * Send one kind of push to a set of people in one club.
 *
 * Leaves out: anyone not in this club or deleted, anyone whose role cannot
 * receive this kind (re-checked here, whatever the caller decided), and anyone
 * who switched this kind off. Sends to each person's live devices; switches
 * off the tokens the provider says are dead.
 *
 * This function may throw. Request paths use the notify* wrappers below.
 */
export async function sendPushToUsers(input: { clubId: string; userIds: readonly string[]; kind: PushKind; path: PushPath }): Promise<PushSendResult> {
  const apns = apnsConfig();
  const fcm = fcmConfig();
  if (!apns && !fcm) return NOTHING;
  const ids = Array.from(new Set(input.userIds.filter(Boolean)));
  if (ids.length === 0) return { ...NOTHING, configured: true };

  const [users, prefs, club] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids }, clubId: input.clubId, deletedAt: null },
      select: { id: true, role: true, staffProfile: { select: { permissions: true } } },
    }),
    prisma.notificationPreference.findMany({
      where: { userId: { in: ids }, type: input.kind, enabled: false },
      select: { userId: true, type: true, enabled: true },
    }),
    prisma.club.findUnique({ where: { id: input.clubId }, select: { name: true } }),
  ]);

  const allowed = users.filter((u) => canReceiveKind(u.role, permsOf(u.staffProfile?.permissions), input.kind));
  const recipients = applyPreferences(allowed.map((u) => u.id), prefs, input.kind);
  if (recipients.length === 0) return { ...NOTHING, configured: true };
  const roleById = new Map(users.map((u) => [u.id, u.role as string]));

  const devices = await prisma.deviceToken.findMany({
    where: { userId: { in: recipients }, clubId: input.clubId, disabledAt: null },
    select: { id: true, userId: true, platform: true, appId: true, token: true },
  });
  if (devices.length === 0) return { configured: true, recipients: recipients.length, devices: 0, sent: 0, failed: 0, disabled: 0 };

  const jobs = devices.map((device) => ({
    device,
    message: buildPushMessage({ clubName: club?.name, kind: input.kind, audience: audienceForRole(roleById.get(device.userId)), path: input.path }),
  }));

  const [ios, android] = await Promise.all([
    apns ? sendApns(apns, jobs.filter((j) => j.device.platform === "IOS")) : Promise.resolve([] as Delivery[]),
    fcm ? sendFcm(fcm, jobs.filter((j) => j.device.platform === "ANDROID")) : Promise.resolve([] as Delivery[]),
  ]);
  const deliveries = [...ios, ...android];

  // Dead tokens: off, with the reason, grouped so it is one write per reason.
  const dead = new Map<string, string[]>();
  for (const d of deliveries) {
    if (d.outcome.result !== "DEAD") continue;
    dead.set(d.outcome.reason, [...(dead.get(d.outcome.reason) ?? []), d.device.id]);
  }
  let disabled = 0;
  for (const [reason, deviceIds] of dead) {
    const res = await prisma.deviceToken.updateMany({
      where: { id: { in: deviceIds }, disabledAt: null },
      data: { disabledAt: new Date(), disabledReason: reason.slice(0, 120) },
    });
    disabled += res.count;
  }

  const failures = deliveries.filter((d) => d.outcome.result === "FAILED");
  if (failures.length > 0) {
    // Reasons only. Never a token, never a person.
    const reasons = Array.from(new Set(failures.map((d) => (d.outcome.result === "FAILED" ? `${d.device.platform}:${d.outcome.reason}` : ""))));
    console.warn(`[push] ${input.kind}: ${failures.length} of ${deliveries.length} not delivered (${reasons.join(", ")})`);
  }

  return {
    configured: true,
    recipients: recipients.length,
    devices: devices.length,
    sent: deliveries.filter((d) => d.outcome.result === "OK").length,
    failed: failures.length,
    disabled,
  };
}

function permsOf(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * Run a push for a request: never rejects, never takes longer than the budget.
 * If the budget runs out the work is abandoned, not awaited.
 */
export async function bestEffortPush(label: string, work: () => Promise<unknown>, budgetMs = PUSH_BUDGET_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const guarded = Promise.resolve()
      .then(work)
      .catch((err) => { console.error(`[push] ${label} failed:`, err instanceof Error ? err.message : err); });
    await Promise.race([guarded, new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); })]);
  } catch {
    /* nothing a push does may reach the caller */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 1. Approvals ───────────────────────────────────────────────────────────

async function clubStaff(clubId: string): Promise<PushPerson[]> {
  const rows = await prisma.user.findMany({
    where: { clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
    select: { id: true, role: true, staffProfile: { select: { permissions: true } } },
  });
  return rows.map((u) => ({ id: u.id, role: u.role, perms: permsOf(u.staffProfile?.permissions) }));
}

/**
 * Something landed in the club's approvals queue. Tells the owner(s) and the
 * staff whose permissions show them that kind — the same people
 * GET /api/approvals would list it for. Never the person who asked.
 */
export async function notifyApprovalWaiting(input: { clubId: string; approvalKind: string; requestedByUserId?: string | null }): Promise<void> {
  await bestEffortPush("approval", async () => {
    if (!anyConfigured()) return;
    const recipients = approvalRecipients(await clubStaff(input.clubId), input.approvalKind, input.requestedByUserId);
    await sendPushToUsers({ clubId: input.clubId, userIds: recipients, kind: "APPROVALS", path: APPROVALS_PATH });
  });
}

function anyConfigured(): boolean {
  const c = pushConfigured();
  return c.ios || c.android;
}

// ── 2. Messages ────────────────────────────────────────────────────────────

/** A one-to-one message was stored. Tells its recipients, never its sender. */
export async function notifyDirectMessage(input: {
  clubId: string;
  senderId: string;
  recipientIds: readonly string[];
  subjectMemberId?: string | null;
}): Promise<void> {
  await bestEffortPush("message", async () => {
    if (!anyConfigured()) return;
    const ids = input.recipientIds.filter((id) => id && id !== input.senderId);
    if (ids.length === 0) return;
    await sendPushToUsers({
      clubId: input.clubId,
      userIds: await messageAudience(input.clubId, ids, input.senderId),
      kind: "MESSAGES",
      path: dmPaths({ otherUserId: input.senderId, subjectMemberId: input.subjectMemberId }),
    });
  });
}

/**
 * A message was posted in a group. Tells the group's members, never the
 * sender. For an event's chat the member list alone is not trusted: a family
 * whose registration ended is left out, exactly as the thread itself does.
 */
export async function notifyGroupMessage(input: { clubId: string; senderId: string; groupId: string }): Promise<void> {
  await bestEffortPush("group message", async () => {
    if (!anyConfigured()) return;
    const group = await prisma.messageGroup.findFirst({
      where: { id: input.groupId, clubId: input.clubId },
      select: { id: true, eventId: true, members: { select: { userId: true, user: { select: { role: true } } } } },
    });
    if (!group) return;
    let ids = group.members.map((m) => m.userId);
    if (group.eventId) {
      const eligible = await eligibleEventChatUserIds(group.eventId, input.clubId);
      ids = group.members.filter((m) => m.user.role !== "MEMBER" || eligible.has(m.userId)).map((m) => m.userId);
    }
    await sendPushToUsers({
      clubId: input.clubId,
      userIds: await messageAudience(input.clubId, ids, input.senderId),
      kind: "MESSAGES",
      path: groupPaths(group.id),
    });
  });
}

async function messageAudience(clubId: string, userIds: readonly string[], senderId: string): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { id: { in: Array.from(new Set(userIds)) }, clubId, deletedAt: null },
    select: { id: true, role: true, staffProfile: { select: { permissions: true } } },
  });
  return messageRecipients(rows.map((u) => ({ id: u.id, role: u.role, perms: permsOf(u.staffProfile?.permissions) })), senderId);
}

// ── 3. Cash / check memberships about to end ───────────────────────────────

/** True when the row was written, false when it already existed. */
async function claimNotification(row: { clubId: string; dedupeKey: string; recipientKey: string; channel: "PUSH" | "EMAIL" }): Promise<boolean> {
  try {
    await prisma.notificationLog.create({ data: { ...row, type: OFFLINE_ENDING_TYPE } });
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") return false;
    throw err;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The family's email. May name the athlete and the day; never an amount. */
export function renderOfflineEndingEmail(input: { clubName: string; athleteFirstName: string; endsOn: string; portalUrl: string; contactEmail?: string | null }): {
  subject: string;
  html: string;
  text: string;
} {
  const club = input.clubName.trim() || "your club";
  const athlete = input.athleteFirstName.trim() || "your athlete";
  const subject = `${athlete}'s membership at ${club} ends ${input.endsOn}`;
  const contact = input.contactEmail ? ` You can also reply to this email or write to ${input.contactEmail}.` : "";
  const text =
    `${athlete}'s membership at ${club} ends on ${input.endsOn}.\n\n` +
    `It is paid by cash or check, so it does not renew by itself. To keep it going, please make a payment at the club before that day.\n\n` +
    `See the membership: ${input.portalUrl}\n\n` +
    `If you have already paid, thank you. Please let the club know so they can record it.${contact}`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:540px;margin:0 auto;color:#1c1917">
      <h2 style="margin:0 0 12px;font-size:20px">${escapeHtml(athlete)}'s membership ends ${escapeHtml(input.endsOn)}</h2>
      <p style="line-height:1.6;color:#57534e;margin:0 0 12px">
        ${escapeHtml(athlete)}'s membership at <strong>${escapeHtml(club)}</strong> ends on <strong>${escapeHtml(input.endsOn)}</strong>.
      </p>
      <p style="line-height:1.6;color:#57534e;margin:0 0 20px">
        It is paid by cash or check, so it does not renew by itself. To keep it going, please make a payment at the club before that day.
      </p>
      <a href="${escapeHtml(input.portalUrl)}" style="display:inline-block;background:#1c1917;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">See the membership</a>
      <p style="line-height:1.6;color:#78716c;font-size:13px;margin:20px 0 0">
        If you have already paid, thank you. Please let the club know so they can record it.${escapeHtml(contact)}
      </p>
    </div>`;
  return { subject, html, text };
}

export type OfflineReminderRun = {
  considered: number;
  due: number;
  staffPushes: number;
  familyPushes: number;
  emails: number;
  alreadySent: number;
  errors: number;
};

/**
 * The daily job. For every cash or check membership that ends within three
 * days: tell the club's owner and billing staff, and remind the paying family
 * by push and by email. Once per membership period: the log row is written
 * FIRST and a send happens only if that write succeeded, so a second run, or
 * two runs at once, cannot remind anyone twice.
 *
 * Everything about the membership is read from the subscription row.
 */
export async function runOfflineMembershipReminders(now: Date = new Date()): Promise<OfflineReminderRun> {
  const out: OfflineReminderRun = { considered: 0, due: 0, staffPushes: 0, familyPushes: 0, emails: 0, alreadySent: 0, errors: 0 };

  // A coarse window in the database (time zones move the edge by under a day);
  // the exact rule is offlineEndingDue, in the club's own calendar.
  const DAY = 86_400_000;
  const subs = await prisma.memberSubscription.findMany({
    where: {
      billingType: "MANUAL",
      status: "active",
      autoRenew: false,
      stripeSubscriptionId: null,
      deliberateFree: false,
      price: { gt: 0 },
      pausedAt: null,
      endDate: { gte: new Date(now.getTime() - 2 * DAY), lte: new Date(now.getTime() + (OFFLINE_ENDING_LEAD_DAYS + 2) * DAY) },
      member: { deletedAt: null },
    },
    select: {
      id: true, memberId: true, membershipId: true, billingType: true, status: true, autoRenew: true, endDate: true,
      stripeSubscriptionId: true, price: true, deliberateFree: true, pausedAt: true, payerUserId: true,
      member: {
        select: {
          id: true, clubId: true, firstName: true, userId: true,
          guardianLinks: { where: ACTIVE_GUARDIAN_LINK, select: { userId: true, canReceiveEmails: true } },
          club: { select: { id: true, name: true, timezone: true, contactEmail: true, emailFromName: true, emailReplyTo: true } },
        },
      },
    },
  });
  out.considered = subs.length;
  if (subs.length === 0) return out;

  // "Already renewed": a later membership on the same plan is in place, either
  // chained to this one or simply running past this one's end.
  const others = await prisma.memberSubscription.findMany({
    where: {
      memberId: { in: Array.from(new Set(subs.map((s) => s.memberId))) },
      status: { in: ["active", "pending", "past_due", "trialing"] },
      id: { notIn: subs.map((s) => s.id) },
    },
    select: { id: true, memberId: true, membershipId: true, endDate: true, renewedFromId: true },
  });

  const staffByClub = new Map<string, PushPerson[]>();
  const baseUrl = getAppBaseUrl();

  for (const s of subs) {
    try {
      if (!s.endDate) continue;
      const endDate = s.endDate;
      const club = s.member.club;
      const hasSuccessor = others.some(
        (o) => o.memberId === s.memberId && (o.renewedFromId === s.id || (o.membershipId === s.membershipId && (!o.endDate || o.endDate > endDate))),
      );
      const facts = {
        id: s.id, billingType: s.billingType, status: s.status, autoRenew: s.autoRenew, endDate,
        stripeSubscriptionId: s.stripeSubscriptionId, price: Number(s.price), deliberateFree: s.deliberateFree, pausedAt: s.pausedAt, hasSuccessor,
      };
      if (!offlineEndingDue(facts, now, club.timezone)) continue;
      out.due++;
      const dedupeKey = offlineEndingDedupeKey(s.id, endDate);

      // Staff: owner + billing access.
      if (!staffByClub.has(club.id)) staffByClub.set(club.id, await clubStaff(club.id));
      const staffIds = offlineEndingStaffRecipients(staffByClub.get(club.id) ?? []);
      const staffToTell: string[] = [];
      for (const id of staffIds) {
        if (await claimNotification({ clubId: club.id, dedupeKey, recipientKey: id, channel: "PUSH" })) staffToTell.push(id);
        else out.alreadySent++;
      }
      if (staffToTell.length > 0) {
        await sendPushToUsers({ clubId: club.id, userIds: staffToTell, kind: "OFFLINE_MEMBERSHIP_ENDING", path: memberBillingPath(s.memberId) }).catch((err) => {
          out.errors++;
          console.error("[push] offline-ending staff push failed:", err instanceof Error ? err.message : err);
        });
        out.staffPushes += staffToTell.length;
      }

      // Family: who the subscription says pays, else the athlete's own login,
      // else the confirmed guardians.
      const familyIds = offlineEndingFamilyUserIds({
        payerUserId: s.payerUserId,
        memberUserId: s.member.userId,
        guardianUserIds: s.member.guardianLinks.map((g) => g.userId),
      });
      const family = familyIds.length
        ? await prisma.user.findMany({ where: { id: { in: familyIds }, clubId: club.id, deletedAt: null }, select: { id: true, email: true, role: true } })
        : [];

      // Push. Someone who works at the club was told above; not twice.
      const familyToTell: string[] = [];
      for (const u of family) {
        if (u.role !== "MEMBER") continue;
        if (await claimNotification({ clubId: club.id, dedupeKey, recipientKey: u.id, channel: "PUSH" })) familyToTell.push(u.id);
        else out.alreadySent++;
      }
      if (familyToTell.length > 0) {
        await sendPushToUsers({ clubId: club.id, userIds: familyToTell, kind: "OFFLINE_MEMBERSHIP_ENDING", path: FAMILY_MEMBERSHIPS_PATH }).catch((err) => {
          out.errors++;
          console.error("[push] offline-ending family push failed:", err instanceof Error ? err.message : err);
        });
        out.familyPushes += familyToTell.length;
      }

      // Email, to the same people. A guardian who asked for no email gets none.
      const noEmail = new Set(s.member.guardianLinks.filter((g) => g.canReceiveEmails === false).map((g) => g.userId));
      // End dates are calendar days stored at 00:00 UTC: print that day.
      const endsOn = emailDate(endDate, { kind: "class" });
      for (const u of family) {
        const email = (u.email ?? "").trim().toLowerCase();
        if (!email || noEmail.has(u.id)) continue;
        if (!(await claimNotification({ clubId: club.id, dedupeKey, recipientKey: email, channel: "EMAIL" }))) { out.alreadySent++; continue; }
        const copy = renderOfflineEndingEmail({
          clubName: club.name, athleteFirstName: s.member.firstName, endsOn,
          portalUrl: `${baseUrl}${FAMILY_MEMBERSHIPS_PATH}`, contactEmail: club.emailReplyTo || club.contactEmail,
        });
        try {
          const res = await sendClubEmail({
            clubId: club.id, kind: "TRANSACTIONAL", recipientEmail: email, recipientUserId: u.id, recipientMemberId: s.memberId,
            subject: copy.subject, bodyHtml: copy.html, bodyText: copy.text,
            fromName: club.emailFromName || club.name, replyTo: club.emailReplyTo || club.contactEmail,
            relatedMembershipId: s.membershipId, personalization: { memberSubscriptionId: s.id, reminder: OFFLINE_ENDING_TYPE },
          });
          if (res.status === "SENT") out.emails++;
          else if (res.status === "FAILED") out.errors++;
        } catch (err) {
          out.errors++;
          console.error("[push] offline-ending email failed:", err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      out.errors++;
      console.error("[push] offline-ending reminder failed for one membership:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}
