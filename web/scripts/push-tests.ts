/**
 * Push notifications (designed 2026-11-17, docs/MOBILE-APP-PLAN §11).
 *
 *   npx tsx scripts/push-tests.ts
 *
 * No database, no network, no phone. Every date is relative to now.
 *
 *   1  the words on the lock screen are fixed and carry no numbers
 *   2  an approval reaches the owner and only the staff who can see that kind
 *   3  a message reaches its recipients and never its sender
 *   4  a switch turned off is honoured; no row means on
 *   5  cash/check reminders: comps and card-billed memberships are never picked
 *   6  the three-day window, at its edges
 *   7  once per membership period
 *   8  dead tokens are recognised (and a bad payload is not mistaken for one)
 *   9  what is handed to Apple and Google
 *  10  a tap can only open a path on this site
 *  11  the wiring: secret-gated cron, best-effort sends, ships dark
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_GATES,
  APPROVALS_PATH,
  FCM_SCOPE,
  GOOGLE_TOKEN_URL,
  OFFLINE_ENDING_LEAD_DAYS,
  PENDING_APPROVAL_QUEUE_KINDS,
  PUSH_KINDS,
  PUSH_TEXT,
  apnsHost,
  apnsJwtParts,
  applyPreferences,
  approvalRecipients,
  audienceForRole,
  buildApnsRequest,
  buildFcmRequest,
  buildPushMessage,
  canReceiveKind,
  canSeeApprovalKind,
  classifyApnsResponse,
  classifyFcmResponse,
  daysUntilEnd,
  dmPaths,
  fcmJwtParts,
  groupPaths,
  kindLabel,
  memberBillingPath,
  messageRecipients,
  offlineEndingDedupeKey,
  offlineEndingDue,
  offlineEndingExclusion,
  offlineEndingFamilyUserIds,
  offlineEndingStaffRecipients,
  parseDeviceRegistration,
  pushText,
  pushTitle,
  receivableKinds,
  safePushPath,
  visiblePendingApprovalKinds,
  ymdOfEndDate,
  type OfflineSubscriptionFacts,
  type PushPerson,
} from "../lib/push";
import { DEFAULT_PERMISSIONS } from "../lib/permissions";

const ROOT = join(__dirname, "..");
const raw = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string) =>
  raw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join("|") === [...b].sort().join("|");
const none = { ...DEFAULT_PERMISSIONS, members: "none", messages: "none" } as Record<string, unknown>;
const staff = (perms: Record<string, unknown>) => ({ ...none, ...perms });

// ── Dates: all relative to now ─────────────────────────────────────────────
const NOW = new Date();
const DAY = 86_400_000;
/** Midnight UTC, `n` calendar days from today (UTC) — how end dates are stored. */
function endIn(n: number): Date {
  const t = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
  return new Date(t.getTime() + n * DAY);
}

console.log("\n§1 the words are fixed");
{
  const all = Object.values(PUSH_TEXT);
  check("exactly four sentences exist", all.length === 4);
  check("approvals", PUSH_TEXT.APPROVALS === "Something is waiting for your approval.");
  check("messages", PUSH_TEXT.MESSAGES === "You have a new message.");
  check("cash membership, to staff", PUSH_TEXT.OFFLINE_MEMBERSHIP_ENDING_STAFF === "A cash membership ends soon. Record payment or renew.");
  check("cash membership, to the family", PUSH_TEXT.OFFLINE_MEMBERSHIP_ENDING_FAMILY === "Your membership needs a payment to continue.");
  check("no sentence contains a digit or a $", all.every((t) => !/[0-9$]/.test(t)));
  check("no sentence has a slot for a name, amount or date", all.every((t) => !/[{}%<>]/.test(t)));
  check("every kind and audience resolves to one of the four", PUSH_KINDS.every((k) => (["STAFF", "FAMILY"] as const).every((a) => all.includes(pushText(k, a) as (typeof all)[number]))));
  check("staff and family get different words about a membership ending", pushText("OFFLINE_MEMBERSHIP_ENDING", "STAFF") !== pushText("OFFLINE_MEMBERSHIP_ENDING", "FAMILY"));
  check("owner and staff read as STAFF, a member login as FAMILY", audienceForRole("OWNER") === "STAFF" && audienceForRole("STAFF") === "STAFF" && audienceForRole("MEMBER") === "FAMILY");
  check("the title is the club's name", pushTitle("  Riverside Athletics ") === "Riverside Athletics");
  check("a club with no name still gets a title", pushTitle(null) === "AthletixOS" && pushTitle("   ") === "AthletixOS");
  const m = buildPushMessage({ clubName: "Riverside Athletics", kind: "OFFLINE_MEMBERSHIP_ENDING", audience: "FAMILY", path: "/member/memberships" });
  check("a built message is the club name plus a fixed sentence", m.title === "Riverside Athletics" && m.body === PUSH_TEXT.OFFLINE_MEMBERSHIP_ENDING_FAMILY);
  check("the settings labels carry no digits either", PUSH_KINDS.every((k) => (["STAFF", "FAMILY"] as const).every((a) => !/[0-9$]/.test(kindLabel(k, a).title + kindLabel(k, a).description))));
  const server = code("lib/pushServer.ts");
  check("the sender builds every message through buildPushMessage", server.includes("buildPushMessage({") && !/alert:\s*\{/.test(server) && !/notification:\s*\{/.test(server));
}

console.log("\n§2 approvals: the owner, and only the staff who can see that kind");
{
  const members = staff({ members: "view" });
  const membersEdit = staff({ members: "edit" });
  const finances = staff({ finances: "view" });
  const billing = staff({ billing: "view" });
  const transfer = staff({ billing_subScopes: { transfer_subscription: true } });
  const table: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["GUARDIAN_LINK", members, finances],
    ["INVOICE_SPLIT", members, billing],
    ["MEMBERSHIP_CANCEL", finances, members],
    ["MEMBERSHIP_PURCHASE", finances, billing],
    ["PRIVATE_PACKAGE_PURCHASE", finances, membersEdit],
    ["MEMBERSHIP_TRANSFER", transfer, staff({ billing: "full" })],
    ["MEMBERSHIP_AUTOPAY_CHANGE", billing, finances],
    ["MEMBERSHIP_CHANGE_REQUEST", billing, members],
    ["MIGRATION_BILLING", membersEdit, members],
    ["REACTIVATION_CHANGE_REQUEST", billing, finances],
  ];
  check("every kind in the mapping is covered by this table", same(table.map((t) => t[0]), Object.keys(APPROVAL_GATES)));
  for (const [kind, yes, no] of table) {
    check(
      `${kind}: owner yes, the right staff yes, other staff no, a member no`,
      canSeeApprovalKind("OWNER", null, kind) && canSeeApprovalKind("STAFF", yes, kind) && !canSeeApprovalKind("STAFF", no, kind) && !canSeeApprovalKind("STAFF", none, kind) && !canSeeApprovalKind("MEMBER", yes, kind),
    );
  }
  check("a reactivation change request also reaches staff who can edit members", canSeeApprovalKind("STAFF", membersEdit, "REACTIVATION_CHANGE_REQUEST"));
  check("full billing does not imply the transfer sub-scope", !canSeeApprovalKind("STAFF", staff({ billing: "full" }), "MEMBERSHIP_TRANSFER"));
  check(
    "the family-side approval kinds are never an owner approval",
    ["CLASS_BOOK", "EVENT_REGISTER", "PRIVATE_REQUEST", "PACKAGE_BUY", "MEMBERSHIP_SUBSCRIBE", "PRODUCT_BUY", "EVENT_PROPOSAL_RESPONSE"].every((k) => !canSeeApprovalKind("OWNER", null, k)),
  );
  const parental = raw("lib/parentalControls.ts");
  const memberKinds = (parental.match(/MEMBER_APPROVAL_KINDS = \[([\s\S]*?)\]/)?.[1] ?? "").match(/"([A-Z_]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
  check("…checked against the real list in lib/parentalControls", memberKinds.length >= 6 && memberKinds.every((k) => !canSeeApprovalKind("OWNER", null, k)));
  check("an unknown kind reaches nobody", !canSeeApprovalKind("OWNER", null, "SOMETHING_NEW"));

  const people: PushPerson[] = [
    { id: "owner", role: "OWNER" },
    { id: "frontdesk", role: "STAFF", perms: finances },
    { id: "coach", role: "STAFF", perms: none },
    { id: "parent", role: "MEMBER" },
  ];
  check("a cash purchase request: owner + finances staff, nobody else", same(approvalRecipients(people, "MEMBERSHIP_PURCHASE"), ["owner", "frontdesk"]));
  check("a guardian request: the owner only here", same(approvalRecipients(people, "GUARDIAN_LINK"), ["owner"]));
  check("the person who asked is never told", same(approvalRecipients(people, "MEMBERSHIP_PURCHASE", "frontdesk"), ["owner"]));
  check("an owner sees every stored kind; staff with nothing sees none", same(visiblePendingApprovalKinds("OWNER", null), PENDING_APPROVAL_QUEUE_KINDS) && visiblePendingApprovalKinds("STAFF", none).length === 0);
  check("finances staff see exactly the three money kinds", same(visiblePendingApprovalKinds("STAFF", finances), ["MEMBERSHIP_CANCEL", "MEMBERSHIP_PURCHASE", "PRIVATE_PACKAGE_PURCHASE"]));

  // The strings must be the real PendingApproval kinds.
  const approvals = raw("lib/approvals.ts") + raw("lib/guardianLink.ts") + raw("lib/membershipTransferKind.ts");
  const declared = Array.from(approvals.matchAll(/_KIND = "([A-Z_]+)" as const/g)).map((m) => m[1]);
  check("the stored kinds are exactly the owner-side kinds the app declares", same(declared, PENDING_APPROVAL_QUEUE_KINDS), declared.join(","));

  const queue = code("app/api/approvals/route.ts");
  check("the approvals queue is built from the same mapping", queue.includes("visiblePendingApprovalKinds(role, perms)") && queue.includes('canSeeApprovalKind(role, perms, "MIGRATION_BILLING")') && queue.includes('canSeeApprovalKind(role, perms, "REACTIVATION_CHANGE_REQUEST")'));
  check("…and no longer has gates of its own for those kinds", !queue.includes("kinds.push(") && !queue.includes("hasBillingSubScope("));
  check("the approval push opens the approvals page", APPROVALS_PATH === "/dashboard/members/approvals" && code("lib/pushServer.ts").includes('kind: "APPROVALS", path: APPROVALS_PATH'));

  const hooked = [
    "app/api/member/private-packages/[id]/buy/route.ts",
    "app/api/member/family/[memberId]/invoice-split/route.ts",
    "app/api/member/family/[memberId]/invite-guardian/route.ts",
    "app/api/member/subscriptions/request-cancel/route.ts",
    "app/api/member/subscriptions/[id]/autopay/route.ts",
    "app/api/member/memberships/subscribe/route.ts",
    "app/api/member/memberships/change-request/route.ts",
    "app/api/member-subscriptions/[id]/transfer/route.ts",
    "app/api/members/migration/activate/[token]/route.ts",
    "lib/accountDeletionServer.ts",
    "app/api/stripe/webhook/route.ts",
    "app/api/reactivate/[token]/change-request/route.ts",
  ];
  for (const f of hooked) {
    const src = code(f);
    const creates = (src.match(/pendingApproval\.create\(/g) ?? []).length;
    const tells = (src.match(/await notifyApprovalWaiting\(/g) ?? []).length;
    check(`${f} tells the club`, tells >= Math.max(1, creates), `${creates} created, ${tells} told`);
  }
  // A guardian-link request is queued inside lib/guardianLink, which a browser
  // bundle also reaches (via lib/familyAccess), so it must never import the
  // server-only sender. The two routes that call it tell the club instead,
  // and only when a NEW request was queued.
  check("lib/guardianLink never imports the push sender (browser bundle)", !code("lib/guardianLink.ts").includes("pushServer"));
  for (const f of ["app/api/member/portal/link-child/route.ts", "app/api/member/signup/route.ts"]) {
    check(`${f} tells the club about a new guardian request`, /queued\)? await notifyApprovalWaiting\(\{[^}]*GUARDIAN_LINK_KIND/.test(code(f)) || /\.queued\) \{\s*await notifyApprovalWaiting\(\{[^}]*GUARDIAN_LINK_KIND/.test(code(f)));
  }
  check("the family-side approval queue (lib/parentalControls) sends no owner push", !code("lib/parentalControls.ts").includes("notifyApprovalWaiting"));
}

console.log("\n§3 messages: the recipients, never the sender");
{
  const people: PushPerson[] = [
    { id: "coach", role: "STAFF", perms: staff({ messages: "send" }) },
    { id: "parent", role: "MEMBER" },
    { id: "athlete", role: "MEMBER" },
    { id: "owner", role: "OWNER" },
    { id: "bookkeeper", role: "STAFF", perms: none },
  ];
  check("the sender is excluded", same(messageRecipients(people, "coach"), ["parent", "athlete", "owner"]));
  check("a family sending: staff and owner are told, the sender is not", same(messageRecipients(people, "parent"), ["coach", "athlete", "owner"]));
  check("a one-person list containing only the sender tells nobody", messageRecipients([{ id: "coach", role: "STAFF", perms: staff({ messages: "send" }) }], "coach").length === 0);
  check("staff who cannot open Messages are left out", !messageRecipients(people, "parent").includes("bookkeeper"));
  check("nobody is listed twice", messageRecipients([...people, ...people], "coach").length === 3);
  const dm = dmPaths({ otherUserId: "u_1", subjectMemberId: "m_9" });
  check("a family opens the conversation with the sender, about that athlete (ids only)", typeof dm !== "string" && dm.member === "/member/messages/dm/u_1?about=m_9" && dm.staff === "/dashboard/messages");
  const g = groupPaths("g_3");
  check("a group opens the group, on each side", typeof g !== "string" && g.member === "/member/messages/group/g_3" && g.staff === "/dashboard/messages?group=g_3");
  const server = code("lib/pushServer.ts");
  check("the direct-message sender drops the sender before anything else", server.includes("input.recipientIds.filter((id) => id && id !== input.senderId)"));
  check("an event's chat re-checks who is still registered", server.includes("eligibleEventChatUserIds(group.eventId, input.clubId)"));
  for (const f of ["app/api/messages/dm/route.ts", "app/api/messages/dm/[userId]/route.ts", "app/api/member/messages/dm/[userId]/route.ts", "app/api/members/bulk/route.ts"]) {
    check(`${f} sends the push with the signed-in person as sender`, /await notifyDirectMessage\(\{[\s\S]{0,80}senderId: session\.user\.id/.test(code(f)));
  }
  check("every way a staff direct message is stored is followed by a push", (code("app/api/messages/dm/[userId]/route.ts").match(/await notifyDirectMessage\(/g) ?? []).length === 3);
  for (const f of ["app/api/messages/groups/[id]/route.ts", "app/api/member/messages/groups/[id]/route.ts"]) {
    check(`${f} sends the group push`, code(f).includes("await notifyGroupMessage({ clubId: session.user.clubId, senderId: session.user.id, groupId: params.id })"));
  }
  check("a bulk message is one push per person, sent after the loop", /for \(const memberId of ids\) \{[\s\S]*?\n  \}\n[\s\S]*?if \(pushTo\.size > 0\)/.test(code("app/api/members/bulk/route.ts")));
}

console.log("\n§4 the per-person switch");
{
  const ids = ["a", "b", "c"];
  check("no row means on", same(applyPreferences(ids, [], "MESSAGES"), ids));
  check("off excludes that person", same(applyPreferences(ids, [{ userId: "b", type: "MESSAGES", enabled: false }], "MESSAGES"), ["a", "c"]));
  check("off for one kind does not silence another", same(applyPreferences(ids, [{ userId: "b", type: "APPROVALS", enabled: false }], "MESSAGES"), ids));
  check("a row that says on is on", same(applyPreferences(ids, [{ userId: "b", type: "MESSAGES", enabled: true }], "MESSAGES"), ids));
  check("an owner is offered all three switches", same(receivableKinds("OWNER", null), PUSH_KINDS));
  check("a family is offered messages and membership reminders, never approvals", same(receivableKinds("MEMBER", null), ["MESSAGES", "OFFLINE_MEMBERSHIP_ENDING"]));
  check("staff with nothing are offered nothing", receivableKinds("STAFF", none).length === 0);
  check("staff with billing access are offered the membership switch", canReceiveKind("STAFF", staff({ billing: "view" }), "OFFLINE_MEMBERSHIP_ENDING") && !canReceiveKind("STAFF", staff({ finances: "full" }), "OFFLINE_MEMBERSHIP_ENDING"));
  check("staff are offered approvals only if some kind would reach them", canReceiveKind("STAFF", staff({ members: "view" }), "APPROVALS") && !canReceiveKind("STAFF", none, "APPROVALS"));
  check("an unknown role is offered nothing", receivableKinds(undefined, null).length === 0);
  const server = code("lib/pushServer.ts");
  check("the sender applies the switch before loading any device", server.indexOf("applyPreferences(") > 0 && server.indexOf("applyPreferences(") < server.indexOf("prisma.deviceToken.findMany("));
  check("…and re-checks the role can receive the kind at all", server.includes("canReceiveKind(u.role, permsOf(u.staffProfile?.permissions), input.kind)"));
  const api = code("app/api/me/notifications/route.ts");
  check("the settings API refuses a kind the person cannot receive", api.includes("receivableKinds(me.role, me.perms).includes(body.type)") && api.includes("status: 403"));
  check("…and reads the role from the database, not the session token", api.includes("prisma.user.findFirst(") && !api.includes("session.user.role"));
}

console.log("\n§5 which memberships get a reminder");
{
  const base: OfflineSubscriptionFacts = {
    id: "sub_1", billingType: "MANUAL", status: "active", autoRenew: false, endDate: endIn(3),
    stripeSubscriptionId: null, price: 120, deliberateFree: false, pausedAt: null, hasSuccessor: false,
  };
  check("a cash membership ending in three days is picked", offlineEndingExclusion(base) === null && offlineEndingDue(base, NOW, null));
  check("card-billed: never", offlineEndingExclusion({ ...base, stripeSubscriptionId: "sub_card" }) === "CARD_BILLED" && !offlineEndingDue({ ...base, stripeSubscriptionId: "sub_card" }, NOW, null));
  check("card-billed even if the row says MANUAL", !offlineEndingDue({ ...base, billingType: "MANUAL", stripeSubscriptionId: "sub_card" }, NOW, null));
  check("a recurring card row with no Stripe id yet: never", offlineEndingExclusion({ ...base, billingType: "RECURRING" }) === "NOT_CASH_OR_CHECK");
  check("a comp (marked free on purpose): never, whatever its price", offlineEndingExclusion({ ...base, deliberateFree: true }) === "COMP" && !offlineEndingDue({ ...base, deliberateFree: true }, NOW, null));
  check("a $0 membership: never", offlineEndingExclusion({ ...base, price: 0 }) === "FREE" && !offlineEndingDue({ ...base, price: 0 }, NOW, null));
  check("not active (pending, expired, canceled): never", ["pending", "expired", "canceled", "past_due"].every((status) => !offlineEndingDue({ ...base, status }, NOW, null)));
  check("one that renews: never", offlineEndingExclusion({ ...base, autoRenew: true }) === "RENEWS");
  check("one with no end date: never", offlineEndingExclusion({ ...base, endDate: null }) === "NO_END_DATE" && !offlineEndingDue({ ...base, endDate: null }, NOW, null));
  check("a paused one: never", offlineEndingExclusion({ ...base, pausedAt: new Date(NOW.getTime() - DAY) }) === "PAUSED");
  check("one already renewed: never", offlineEndingExclusion({ ...base, hasSuccessor: true }) === "ALREADY_RENEWED");

  check("the family is whoever the subscription says pays", same(offlineEndingFamilyUserIds({ payerUserId: "payer", memberUserId: "self", guardianUserIds: ["g1"] }), ["payer"]));
  check("else the athlete's own login", same(offlineEndingFamilyUserIds({ payerUserId: null, memberUserId: "self", guardianUserIds: ["g1"] }), ["self"]));
  check("else the confirmed guardians, each once", same(offlineEndingFamilyUserIds({ payerUserId: null, memberUserId: null, guardianUserIds: ["g1", "g2", "g1"] }), ["g1", "g2"]));
  check("nobody to tell is an empty list, not an error", offlineEndingFamilyUserIds({ payerUserId: null, memberUserId: null, guardianUserIds: [] }).length === 0);
  const people: PushPerson[] = [
    { id: "owner", role: "OWNER" },
    { id: "billing", role: "STAFF", perms: staff({ billing: "view" }) },
    { id: "coach", role: "STAFF", perms: staff({ members: "edit", finances: "full" }) },
    { id: "parent", role: "MEMBER" },
  ];
  check("staff side: owner + billing access, never a family", same(offlineEndingStaffRecipients(people), ["owner", "billing"]));

  const server = code("lib/pushServer.ts");
  const query = server.slice(server.indexOf("prisma.memberSubscription.findMany({"), server.indexOf("out.considered"));
  check("the job reads the subscription row", query.includes('billingType: "MANUAL"') && query.includes("stripeSubscriptionId: null") && query.includes("deliberateFree: false") && query.includes("price: { gt: 0 }") && query.includes("autoRenew: false") && query.includes('status: "active"'));
  check("…and takes the payer from the subscription", server.includes("payerUserId: s.payerUserId"));
  check("no membership fact is read from a field on the member", !/commitmentEndDate|billingAnchorDate|member\.membershipId|responsiblePayerUserId/.test(server));
  check("the staff push opens that member's billing; the family push their memberships", memberBillingPath("m_1") === "/dashboard/members/m_1/billing" && server.includes("path: memberBillingPath(s.memberId)") && server.includes("path: FAMILY_MEMBERSHIPS_PATH"));
  check("the family email is transactional, not bulk", /sendClubEmail\(\{\s*clubId: club\.id, kind: "TRANSACTIONAL"/.test(server));
  const email = server.slice(server.indexOf("export function renderOfflineEndingEmail"), server.indexOf("export type OfflineReminderRun"));
  check("the family email has no place for an amount", !/price|amount|\$\{?[0-9]|\bdue\b/i.test(email));
}

console.log("\n§6 three days before the end");
{
  const sub = (n: number): OfflineSubscriptionFacts => ({
    id: "sub_1", billingType: "MANUAL", status: "active", autoRenew: false, endDate: endIn(n),
    stripeSubscriptionId: null, price: 120, deliberateFree: false,
  });
  check("the lead time is three days", OFFLINE_ENDING_LEAD_DAYS === 3);
  check("four days out: not yet", !offlineEndingDue(sub(4), NOW, null) && daysUntilEnd(endIn(4), NOW, null) === 4);
  check("three days out: due", offlineEndingDue(sub(3), NOW, null) && daysUntilEnd(endIn(3), NOW, null) === 3);
  check("two days and one day out: still due (a missed run is caught)", offlineEndingDue(sub(2), NOW, null) && offlineEndingDue(sub(1), NOW, null));
  check("the end day itself: no", !offlineEndingDue(sub(0), NOW, null));
  check("already past: no", !offlineEndingDue(sub(-1), NOW, null) && !offlineEndingDue(sub(-30), NOW, null));
  check("a month out: no", !offlineEndingDue(sub(30), NOW, null));
  // The first and last instant of today (UTC) give the same answer.
  const startOfToday = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
  const endOfToday = new Date(startOfToday.getTime() + DAY - 1);
  check("the time of day the job runs does not move the window", offlineEndingDue(sub(3), startOfToday, null) && offlineEndingDue(sub(3), endOfToday, null) && !offlineEndingDue(sub(4), startOfToday, null) && !offlineEndingDue(sub(4), endOfToday, null));
  // A club far ahead of or behind UTC counts from its own calendar day.
  const ahead = daysUntilEnd(endIn(3), NOW, "Pacific/Kiritimati");
  const behind = daysUntilEnd(endIn(3), NOW, "Pacific/Pago_Pago");
  check("a club's own time zone moves the count by at most a day, in the right direction", (ahead === 3 || ahead === 2) && (behind === 3 || behind === 4) && ahead <= behind);
  check("an unknown time zone falls back to UTC rather than failing", daysUntilEnd(endIn(3), NOW, "Not/AZone") === 3);
}

console.log("\n§7 once per membership period");
{
  const end = endIn(3);
  const key = offlineEndingDedupeKey("sub_1", end);
  check("the key is offline-ending:<subscription>:<end day>", key === `offline-ending:sub_1:${ymdOfEndDate(end)}` && /^offline-ending:sub_1:\d{4}-\d{2}-\d{2}$/.test(key));
  check("the same membership and end date give the same key on every run", key === offlineEndingDedupeKey("sub_1", new Date(end.getTime())) && key === offlineEndingDedupeKey("sub_1", new Date(end.getTime() + 6 * 3_600_000)));
  check("a renewed membership (new end date) gets a new key", key !== offlineEndingDedupeKey("sub_1", endIn(33)));
  check("another membership gets its own key", key !== offlineEndingDedupeKey("sub_2", end));
  const server = code("lib/pushServer.ts");
  const job = server.slice(server.indexOf("export async function runOfflineMembershipReminders"));
  check("the log row is written before anything is sent", server.includes("prisma.notificationLog.create(") && job.indexOf("claimNotification(") < job.indexOf("sendPushToUsers("));
  check("a row that already exists means do not send", server.includes('.code === "P2002") return false'));
  check("every send in the job is behind a claim", (job.match(/await claimNotification\(/g) ?? []).length === 3 && (job.match(/sendPushToUsers\(/g) ?? []).length === 2 && (job.match(/sendClubEmail\(/g) ?? []).length === 1);
  check("push is logged per person, email per address", job.includes('recipientKey: id, channel: "PUSH"') && job.includes('recipientKey: u.id, channel: "PUSH"') && job.includes('recipientKey: email, channel: "EMAIL"'));
  const schema = raw("prisma/schema.prisma");
  check("the database enforces it (unique on what, who, how)", /model NotificationLog \{[\s\S]*?@@unique\(\[dedupeKey, recipientKey, channel\]\)/.test(schema));
}

console.log("\n§8 dead tokens");
{
  check("APNs 200 is delivered", classifyApnsResponse(200, null).result === "OK");
  check("APNs 410 is dead", classifyApnsResponse(410, "Unregistered").result === "DEAD" && classifyApnsResponse(410, null).result === "DEAD");
  check("APNs Unregistered / BadDeviceToken are dead", classifyApnsResponse(400, "BadDeviceToken").result === "DEAD" && classifyApnsResponse(400, "Unregistered").result === "DEAD");
  check("APNs anything else leaves the token alone", ["BadTopic", "TooManyRequests", "InternalServerError", "ExpiredProviderToken", "PayloadTooLarge"].every((r) => classifyApnsResponse(r === "TooManyRequests" ? 429 : 400, r).result === "FAILED"));
  check("APNs with no answer at all leaves the token alone", classifyApnsResponse(0, null).result === "FAILED" && classifyApnsResponse(503, null).result === "FAILED");
  check("FCM 200 is delivered", classifyFcmResponse(200, { name: "projects/x/messages/1" }).result === "OK");
  check("FCM UNREGISTERED is dead", classifyFcmResponse(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }).result === "DEAD");
  check("FCM 404 is dead even with no body", classifyFcmResponse(404, null).result === "DEAD");
  check("FCM INVALID_ARGUMENT about the token is dead", classifyFcmResponse(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }).result === "DEAD");
  check("…also when it names the token field", classifyFcmResponse(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid value", details: [{ fieldViolations: [{ field: "message.token" }] }] } }).result === "DEAD");
  check("FCM INVALID_ARGUMENT about the payload does NOT retire the token", classifyFcmResponse(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload received. Unknown name \"foo\"" } }).result === "FAILED");
  check("FCM quota, auth and server errors leave the token alone", [[429, "RESOURCE_EXHAUSTED"], [401, "UNAUTHENTICATED"], [403, "PERMISSION_DENIED"], [500, "INTERNAL"], [503, "UNAVAILABLE"]].every(([s, st]) => classifyFcmResponse(s as number, { error: { status: st } }).result === "FAILED"));
  const server = code("lib/pushServer.ts");
  check("a dead token is switched off with its reason", /prisma\.deviceToken\.updateMany\(\{[\s\S]*?disabledAt: new Date\(\), disabledReason:/.test(server));
  check("no device token is ever deleted, anywhere", !server.includes("deviceToken.delete") && !code("app/api/push/devices/route.ts").includes("deviceToken.delete"));
  check("only live tokens are sent to", server.includes("clubId: input.clubId, disabledAt: null }"));
}

console.log("\n§9 what is handed to Apple and Google");
{
  const message = buildPushMessage({ clubName: "Riverside Athletics", kind: "MESSAGES", audience: "FAMILY", path: dmPaths({ otherUserId: "u_1" }) });
  const apns = buildApnsRequest({ token: "abc123", topic: "com.athletixos.app", message });
  check("APNs: the device path", apns.path === "/3/device/abc123");
  check("APNs: an alert for this app", apns.headers["apns-topic"] === "com.athletixos.app" && apns.headers["apns-push-type"] === "alert" && apns.headers["apns-priority"] === "10");
  check("APNs: title is the club, body is the fixed sentence", apns.body.aps.alert.title === "Riverside Athletics" && apns.body.aps.alert.body === PUSH_TEXT.MESSAGES);
  check("APNs: the path travels beside aps, for the tap", apns.body.path === "/member/messages/dm/u_1" && apns.body.kind === "MESSAGES");
  check("APNs: nothing else is in the payload", same(Object.keys(apns.body), ["aps", "path", "kind"]) && same(Object.keys(apns.body.aps), ["alert", "sound", "thread-id"]));
  const fcm = buildFcmRequest({ token: "tok", message });
  check("FCM: one message to one token", fcm.message.token === "tok" && same(Object.keys(fcm), ["message"]));
  check("FCM: title is the club, body is the fixed sentence", fcm.message.notification.title === "Riverside Athletics" && fcm.message.notification.body === PUSH_TEXT.MESSAGES);
  check("FCM: data is strings only, carrying the path", fcm.message.data.path === "/member/messages/dm/u_1" && Object.values(fcm.message.data).every((v) => typeof v === "string"));
  check("FCM: nothing else is in the payload", same(Object.keys(fcm.message), ["token", "notification", "data", "android"]) && same(Object.keys(fcm.message.data), ["path", "kind"]));
  const staffMsg = buildPushMessage({ clubName: "Riverside Athletics", kind: "MESSAGES", audience: "STAFF", path: groupPaths("g_3") });
  check("the path follows who is reading", staffMsg.path === "/dashboard/messages?group=g_3");
  check("production unless told development", apnsHost("production") === "https://api.push.apple.com" && apnsHost(undefined) === "https://api.push.apple.com" && apnsHost("development") === "https://api.sandbox.push.apple.com");
  const nowS = Math.floor(NOW.getTime() / 1000);
  const a = apnsJwtParts({ keyId: "KEYID", teamId: "TEAMID", nowSeconds: nowS }) as { header: { alg: string; kid: string }; claims: { iss: string; iat: number } };
  check("APNs token: ES256, key id, team id, issued now", a.header.alg === "ES256" && a.header.kid === "KEYID" && a.claims.iss === "TEAMID" && a.claims.iat === nowS);
  const f = fcmJwtParts({ clientEmail: "svc@example.iam.gserviceaccount.com", nowSeconds: nowS }) as { header: { alg: string }; claims: { iss: string; scope: string; aud: string; iat: number; exp: number } };
  check("Google assertion: RS256, messaging scope, an hour", f.header.alg === "RS256" && f.claims.scope === FCM_SCOPE && f.claims.aud === GOOGLE_TOKEN_URL && f.claims.exp - f.claims.iat === 3600);
  check("…exchanged at Google's token endpoint", GOOGLE_TOKEN_URL === "https://oauth2.googleapis.com/token");
  const server = code("lib/pushServer.ts");
  check("signed with node:crypto, sent over node:http2, no SDK", server.includes('from "node:crypto"') && server.includes('from "node:http2"') && server.includes('dsaEncoding: "ieee-p1363"') && !/firebase-admin|from "jose"|from "apn"/.test(server));

  check("a device registration needs a token, a platform and an app id", parseDeviceRegistration({ token: "a".repeat(64), platform: "ios", appId: "com.athletixos.app" })?.platform === "IOS");
  check("…and refuses anything else", [null, {}, { token: "short", platform: "IOS", appId: "com.athletixos.app" }, { token: "a".repeat(64), platform: "WEB", appId: "com.athletixos.app" }, { token: "a".repeat(64), platform: "IOS" }, { token: "a b".repeat(30), platform: "ANDROID", appId: "com.athletixos.app" }].every((x) => parseDeviceRegistration(x) === null));
  const devices = code("app/api/push/devices/route.ts");
  check("registration is for the signed-in person only", devices.includes("getServerSession(authOptions)") && devices.includes("userId: session.user.id") && devices.includes("status: 401"));
  check("one row per (app, token); a token that moves is reassigned and switched back on", devices.includes("appId_token: { appId: reg.appId, token: reg.token }") && /update: \{ clubId: session\.user\.clubId, userId: session\.user\.id,[^}]*disabledAt: null, disabledReason: null \}/.test(devices));
  check("the app id and platform are always recorded", /create: \{[^}]*platform: reg\.platform, appId: reg\.appId/.test(devices));
  check("sign-out switches the row off, for this person only", /updateMany\(\{\s*where: \{ userId: session\.user\.id, token/.test(devices) && devices.includes('disabledReason: "SIGNED_OUT"'));
  check("both are rate-limited", (devices.match(/rateLimit\(\{ key: `push:devices:\$\{session\.user\.id\}`/g) ?? []).length === 2);
}

console.log("\n§10 a tap opens a path on this site, nothing else");
{
  check("an ordinary path is kept", safePushPath("/dashboard/members/approvals") === "/dashboard/members/approvals" && safePushPath("/member/messages/dm/u_1?about=m_9") === "/member/messages/dm/u_1?about=m_9");
  check("another site is refused", ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "evil.example", "/x://y"].every((p) => safePushPath(p) === null));
  check("nothing, or not a string, is refused", [undefined, null, "", 7, {}, "/" + "a".repeat(600), "/a\nb"].every((p) => safePushPath(p) === null));
  const client = code("lib/pushClient.ts");
  check("the app checks the path and the origin before navigating", client.includes("safePushPath(data.path)") && client.includes("url.origin !== window.location.origin") && client.indexOf("safePushPath(") < client.indexOf("window.location.assign("));
  check("the permission prompt is only ever shown from enablePush", (client.match(/pushRequestPermission\(\)/g) ?? []).length === 1 && /export async function enablePush[\s\S]*?pushRequestPermission\(\)/.test(client));
  const reg = code("components/PushRegistration.tsx");
  check("the registration component renders nothing and never prompts", reg.includes("return null;") && !reg.includes("enablePush") && !reg.includes("pushRequestPermission"));
  const card = code("components/account/NotificationSettings.tsx");
  check("the settings card prompts only from its button", card.includes("onClick={turnOn}") && (card.match(/enablePush\(\)/g) ?? []).length === 1 && !/useEffect\([\s\S]*?enablePush\(\)[\s\S]*?\}, \[\]\)/.test(card));
  check("…and has no text under 12px", !/text-\[(?:\d|1[01])(?:\.\d+)?px\]/.test(card) && !/fontSize:\s*(?:\d|1[01])\b/.test(card));
}

console.log("\n§11 the wiring");
{
  const cron = code("app/api/cron/offline-membership-reminders/route.ts");
  check("the cron route is off (503) when CRON_SECRET is unset", cron.includes("process.env.CRON_SECRET") && /if \(!secret\) \{[\s\S]*?status: 503/.test(cron));
  check("it compares the secret in constant time", cron.includes("timingSafeEqual(a, b)") && cron.includes("if (a.length !== b.length) return false"));
  check("a wrong or missing secret is 401, before any work", /if \(!secretMatches\(provided, secret\)\) \{[\s\S]*?status: 401/.test(cron) && cron.indexOf("secretMatches(provided, secret)") < cron.indexOf("runOfflineMembershipReminders()"));
  check("it is gated the same way as the payday cron", ["process.env.CRON_SECRET", "timingSafeEqual(a, b)", 'startsWith("bearer ")', 'url.searchParams.get("key")'].every((s) => cron.includes(s) && code("app/api/cron/pay-reminders/route.ts").includes(s)));
  const fn = code("netlify/functions/offline-membership-reminders-cron.mts");
  check("the scheduled function runs daily and only calls the route", /schedule: "0 \d+ \* \* \*"/.test(fn) && fn.includes("/api/cron/offline-membership-reminders") && fn.includes('Netlify.env.get("CRON_SECRET")') && fn.includes("authorization: `Bearer ${secret}`"));

  const server = code("lib/pushServer.ts");
  check("with nothing configured, a send returns before its first query", server.indexOf("if (!apns && !fcm) return NOTHING;") > 0 && server.indexOf("if (!apns && !fcm) return NOTHING;") < server.indexOf("prisma.user.findMany("));
  check("every notify* a request calls is wrapped: no throw, bounded wait", ["notifyApprovalWaiting", "notifyDirectMessage", "notifyGroupMessage"].every((n) => new RegExp(`export async function ${n}\\([\\s\\S]*?\\): Promise<void> \\{\\s*await bestEffortPush\\(`).test(server)));
  check("the wait is capped", /export const PUSH_BUDGET_MS = \d{3,4};/.test(server) && server.includes("Promise.race([guarded,"));
  check("configuration comes from the environment only", ["APNS_KEY_ID", "APNS_PRIVATE_KEY", "APPLE_TEAM_ID", "APNS_BUNDLE_ID", "APNS_ENVIRONMENT", "FIREBASE_SERVICE_ACCOUNT_JSON"].every((v) => server.includes(`process.env.${v}`)));
  const everything = ["lib/push.ts", "lib/pushServer.ts", "lib/pushClient.ts", "app/api/push/devices/route.ts", "app/api/me/notifications/route.ts", "app/api/cron/offline-membership-reminders/route.ts", "netlify/functions/offline-membership-reminders-cron.mts", "scripts/dev-local.sh"].map(raw).join("\n");
  check("no key material is written anywhere in this work", !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(everything) && !/"private_key"\s*:/.test(everything));
  check("nothing logs a token or a key", !/console\.(log|warn|error)\([^)]*\b(token|privateKey|accessToken|jwt)\b[^)]*\)/.test(server.replace(/"[^"]*"|`[^`]*`/g, '""')));
  const dev = raw("scripts/dev-local.sh");
  check("local dev blanks the push credentials", dev.includes('export APNS_PRIVATE_KEY=""') && dev.includes('export FIREBASE_SERVICE_ACCOUNT_JSON=""'));
  check("lib/push.ts stays pure (no database, no network)", !/from "@\/lib\/prisma"|@prisma\/client|fetch\(|node:http2|node:crypto/.test(code("lib/push.ts")));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
