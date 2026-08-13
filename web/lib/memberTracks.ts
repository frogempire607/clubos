// Phase 4.5.1 — the three status tracks, the 7-step migration meter, and the
// single `nextAction` resolver.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// One vocabulary was doing three jobs. A paying member mid-migration read as
// "Prospect · Un-invited" — two labels that were each individually defensible
// and together completely wrong: he had a membership, and he had been invited
// four times. The redesign splits the question into three tracks that NEVER
// share vocabulary:
//
//   Track 1  Role            who they are        (several at once, neutral chips)
//   Track 2  Membership      the money question  (one saturated pill)
//   Track 3  Account setup   login + migration   (a dot, never a pill)
//
// ── Why it is PURE ───────────────────────────────────────────────────────────
// Nothing here imports Prisma. Every function takes a plain shape and returns a
// plain shape, so the whole status model is verifiable in milliseconds on a
// machine with no .env — the same discipline as lib/familyRules.ts. The
// DB-facing serializer lives in lib/memberDisplay.ts and calls into this.
//
// ── Why one resolver ─────────────────────────────────────────────────────────
// The row's action button, the profile's next-action banner and the mobile
// card's action are three renderings of ONE decision. When they were derived
// separately they disagreed, which is how a member could show "Resend invite"
// in the list and "Assign membership" on the profile. `nextAction()` is the
// only place that decision is made.

// ─────────────────────────────────────────────────────────────────────────────
// Input shape
// ─────────────────────────────────────────────────────────────────────────────

/** A date as it may arrive from Prisma, JSON, or a fixture. */
export type DateLike = Date | string | null | undefined;

export type TrackSubscription = {
  /** pending | active | past_due | canceled | expired */
  status: string;
  planName?: string | null;
  optionLabel?: string | null;
  price?: number | null;
  billingPeriod?: string | null;
  currentPeriodEnd?: DateLike;
  canceledAt?: DateLike;
  endDate?: DateLike;
  /** RECURRING | ONE_TIME | MANUAL */
  billingType?: string | null;
  /** An owner said this $0 row is a real comp, not a placeholder. */
  deliberateFree?: boolean | null;
  /** At least one SUCCEEDED, non-VOID transaction exists for this subscription. */
  hasSucceededPayment?: boolean | null;
};

/**
 * Does this subscription represent an actual membership?
 *
 * "Do they hold a membership" and "is their money current" are different
 * questions and must not share a flag. This answers only the first.
 *
 *   - price > 0 needs evidence money has EVER arrived. A Stripe trial creates
 *     an active row at full price and charges nothing, so price alone counts a
 *     trialist as a member. (Levi Schanzenbach: active on $175 with zero
 *     payments, 2026-08-13.) `stripeStatus: "trialing"` is NOT the test — it
 *     is a cached snapshot that goes stale, and using it would demote Kellan
 *     Lister, whose row still says trialing though he paid $545.37 in July.
 *   - price = 0 needs the club to have said the comp is deliberate.
 *   - MANUAL is exempt from the money test on purpose. A cash member IS a
 *     member; unrecorded cash is a bookkeeping gap, not a lapsed membership.
 *     Those rows surface in the TRAINING_UNBILLED queue instead of silently
 *     flipping inactive.
 */
export function countsAsMembership(s: TrackSubscription): boolean {
  if (s.billingType === "MANUAL") return true;
  const price = Number(s.price ?? 0);
  if (price > 0) return s.hasSucceededPayment === true;
  return s.deliberateFree === true;
}

/**
 * Everything the status model reads. Deliberately a flat plain shape rather
 * than a Prisma type: a fixture must be able to construct one by hand.
 */
export type MemberTrackInput = {
  id: string;
  firstName: string;
  lastName: string;

  /** MemberStatus enum as a string: ACTIVE | INACTIVE | PROSPECT | PAUSED */
  status: string;
  isMinor: boolean;
  dateOfBirth?: DateLike;

  email?: string | null;
  guardianEmail?: string | null;
  guardianName?: string | null;

  /** The member's OWN portal login. Null = no account of their own. */
  userId?: string | null;
  /** True when ≥1 CONFIRMED guardian link points at a registered portal user. */
  hasGuardianAccount?: boolean;

  /** Role signals. */
  hasAttendance?: boolean;
  /** This member's user is a confirmed guardian of ≥1 other member. */
  guardianOfCount?: number;
  /** Staff/owner role on the linked user. */
  isStaff?: boolean;
  /** They fund at least one subscription (their own or someone else's). */
  isAccountHolder?: boolean;

  /** Money. */
  subscriptions?: TrackSubscription[];
  trialEndsAt?: DateLike;
  /** Outstanding balance in dollars. 0/null = nothing owed. */
  balanceOwed?: number | null;
  balanceOverdueMonths?: number | null;

  /** Migration / import. */
  migrationStatus?: string | null;
  importedAt?: DateLike;
  importBatchId?: string | null;
  legacySource?: string | null;
  legacyMemberId?: string | null;
  legacyMembershipName?: string | null;
  legacyMembershipPrice?: number | null;
  activationEmailSentAt?: DateLike;
  activationEmailSendCount?: number | null;
  activatedAt?: DateLike;
  migrationCompletedAt?: DateLike;
  migrationCompletedAtFallback?: DateLike;
  approvalStatus?: string | null;
  paymentSetupStatus?: string | null;

  /**
   * Phase 4.5.1 columns — BLOCKED ON MIGRATION 20260804000000_members_experience.
   * Every one is optional and every consumer degrades: before the migration is
   * applied these read undefined and the model behaves exactly as it would with
   * no review recorded, nothing blocked and nothing snoozed.
   */
  reviewedAt?: DateLike;
  reviewedByUserId?: string | null;
  blockedReason?: string | null;
  snoozedUntil?: DateLike;

  /** Invitation delivery facts, from MemberInvitationDelivery. Also blocked. */
  invitationSendCount?: number | null;
  invitationOpenedCount?: number | null;
  invitationBouncedCount?: number | null;
  lastInvitationSentAt?: DateLike;
  lastInvitationEmail?: string | null;

  lastSeenAt?: DateLike;
};

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers — every input may be a Date, an ISO string, or absent
// ─────────────────────────────────────────────────────────────────────────────

export function toDate(v: DateLike): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isSet(v: DateLike): boolean {
  return toDate(v) !== null;
}

function isFuture(v: DateLike, now: Date): boolean {
  const d = toDate(v);
  return d !== null && d.getTime() > now.getTime();
}

export function daysBetween(from: DateLike, now: Date): number | null {
  const d = toDate(from);
  if (!d) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

/** Whole years, floor. Null when there is no date of birth. */
export function ageFrom(dob: DateLike, now: Date): number | null {
  const d = toDate(dob);
  if (!d) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age < 0 ? null : age;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track 1 — Role
// ─────────────────────────────────────────────────────────────────────────────

export const ROLE = {
  ATHLETE: "ATHLETE",
  PARENT: "PARENT",
  ACCOUNT_HOLDER: "ACCOUNT_HOLDER",
  MINOR: "MINOR",
  STAFF: "STAFF",
} as const;

export type Role = (typeof ROLE)[keyof typeof ROLE];

export const ROLE_LABELS: Record<Role, string> = {
  ATHLETE: "ATHLETE",
  PARENT: "PARENT / GUARDIAN",
  ACCOUNT_HOLDER: "ACCOUNT HOLDER",
  MINOR: "MINOR",
  STAFF: "STAFF",
};

export type RoleChip = { role: Role; label: string };

/**
 * A person holds SEVERAL roles at once. A parent who also trains is one record
 * showing `ATHLETE · PARENT` — not two records, and not a single winning label.
 * Order is fixed so two surfaces never render the same person differently.
 */
export function rolesFor(m: MemberTrackInput, now: Date = new Date()): RoleChip[] {
  const out: RoleChip[] = [];

  const hasSubs = (m.subscriptions?.length ?? 0) > 0;
  if (hasSubs || m.hasAttendance) out.push({ role: ROLE.ATHLETE, label: ROLE_LABELS.ATHLETE });

  if ((m.guardianOfCount ?? 0) > 0) out.push({ role: ROLE.PARENT, label: ROLE_LABELS.PARENT });

  if (m.isAccountHolder) {
    out.push({ role: ROLE.ACCOUNT_HOLDER, label: ROLE_LABELS.ACCOUNT_HOLDER });
  }

  if (m.isMinor) {
    const age = ageFrom(m.dateOfBirth, now);
    // "MINOR · 14" when we know the age. The age is what makes the chip
    // actionable (waivers, age brackets); a bare "MINOR" is much less useful.
    out.push({ role: ROLE.MINOR, label: age === null ? "MINOR" : `MINOR · ${age}` });
  }

  if (m.isStaff) out.push({ role: ROLE.STAFF, label: ROLE_LABELS.STAFF });

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track 2 — Membership (the money question)
// ─────────────────────────────────────────────────────────────────────────────

export const MEMBERSHIP_TRACK = {
  ACTIVE: "ACTIVE",
  PENDING: "PENDING",
  PROSPECT: "PROSPECT",
  /**
   * ── J-10, RAISED FOR JULIAN'S CALL (2026-08-04) ──────────────────────────
   * Julian's definition: a Prospect "has attended a practice or done a free
   * trial but never became a member. That is NOT the same as an untouched lead
   * or an imported name nobody has contacted."
   *
   * The model DID conflate those. `!everHeldMembership(m) → PROSPECT` asked
   * only "have they ever bought anything", so a walk-in who trialled last
   * Tuesday and a name typed into the roster months ago and never contacted
   * rendered the identical pill. Imported names were already excluded — they
   * hit the never-Prospect rule and read Pending — so the collapse affected
   * exactly the manually-added group.
   *
   * They need different next actions, which is the practical proof they are
   * different states: the trialler needs a membership offered, the untouched
   * name needs somebody to make contact at all.
   *
   * LEAD is the split. The NAME is a placeholder — Julian decides whether the
   * pair ends up Prospect/Lead, Trialled/Prospect, or something else. Renaming
   * is a one-line change to MEMBERSHIP_LABELS; the derivation is what matters
   * and it is now correct either way.
   */
  LEAD: "LEAD",
  PAUSED: "PAUSED",
  INACTIVE: "INACTIVE",
} as const;

export type MembershipTrack = (typeof MEMBERSHIP_TRACK)[keyof typeof MEMBERSHIP_TRACK];

export const MEMBERSHIP_LABELS: Record<MembershipTrack, string> = {
  ACTIVE: "Active",
  // The "· not charged" half is the whole point: it is the sentence that stops
  // an owner panicking that an import started billing people.
  PENDING: "Pending · not charged",
  PROSPECT: "Prospect",
  // PLACEHOLDER NAME — see MEMBERSHIP_TRACK.LEAD. Julian picks the final pair.
  LEAD: "Lead",
  PAUSED: "Paused",
  INACTIVE: "Inactive",
};

const ACTIVE_SUB = "active";
const PENDING_SUB = "pending";

/** True when this person arrived from any import or migration path. */
export function isImported(m: MemberTrackInput): boolean {
  return Boolean(m.migrationStatus || isSet(m.importedAt) || m.importBatchId || m.legacyMemberId);
}

/** True when they have ever held a membership of any kind. */
export function everHeldMembership(m: MemberTrackInput): boolean {
  if ((m.subscriptions?.length ?? 0) > 0) return true;
  // An imported plan is a membership they hold in the old system. Treating it
  // as "never held one" is exactly the bug that labelled paying members
  // Prospect.
  if (m.legacyMembershipName || m.legacyMembershipPrice != null) return true;
  return false;
}

/**
 * Have they actually been through the door?
 *
 * Julian's definition of Prospect (2026-08-04): "attended a practice or done a
 * free trial but never became a member." Any of these is evidence of that:
 *
 *   · an attendance record of any kind — PRESENT, LATE, TRIAL or DROP_IN
 *   · a trial window ever granted (trialEndsAt set, past or future — a lapsed
 *     trial still means they trialled)
 *   · their own portal login, which they only get by being invited or signing up
 *
 * Everything else is a name in a list. The distinction matters because the two
 * need opposite next actions.
 */
export function hasTouchedTheClub(m: MemberTrackInput): boolean {
  if (m.hasAttendance) return true;
  if (isSet(m.trialEndsAt)) return true;
  if (m.userId) return true;
  return false;
}

export function membershipTrackFor(m: MemberTrackInput, now: Date = new Date()): MembershipTrack {
  // Owner-controlled and sticky — never inferred away.
  if (m.status === "PAUSED") return MEMBERSHIP_TRACK.PAUSED;

  const subs = m.subscriptions ?? [];
  // An active ROW is not the same as an active MEMBERSHIP — see countsAsMembership.
  if (subs.some((s) => s.status === ACTIVE_SUB && countsAsMembership(s))) return MEMBERSHIP_TRACK.ACTIVE;
  // A live staff-granted trial is real access, so it reads Active even with no
  // subscription row behind it.
  if (isFuture(m.trialEndsAt, now)) return MEMBERSHIP_TRACK.ACTIVE;

  if (subs.some((s) => s.status === PENDING_SUB)) return MEMBERSHIP_TRACK.PENDING;

  // ── The hard rule ────────────────────────────────────────────────────────
  // An imported member is NEVER Prospect. They had a membership somewhere else;
  // that is why they are in the import. Until the owner confirms the plan they
  // are Pending · not charged — which is both true and reassuring.
  if (isImported(m) && !isSet(m.migrationCompletedAt)) return MEMBERSHIP_TRACK.PENDING;

  if (!everHeldMembership(m)) {
    // J-10: Prospect means they SHOWED UP. Someone typed into the roster and
    // never contacted is a different state with a different next action —
    // offer them a membership vs. make contact at all.
    return hasTouchedTheClub(m) ? MEMBERSHIP_TRACK.PROSPECT : MEMBERSHIP_TRACK.LEAD;
  }

  return MEMBERSHIP_TRACK.INACTIVE;
}

/** The 11px muted second line under the pill. */
export function membershipDetailFor(m: MemberTrackInput, now: Date = new Date()): string | null {
  const track = membershipTrackFor(m, now);
  const subs = m.subscriptions ?? [];
  const live = subs.find((s) => s.status === ACTIVE_SUB) ?? subs.find((s) => s.status === PENDING_SUB);

  if (track === MEMBERSHIP_TRACK.PROSPECT) return "Trialled, never joined";
  if (track === MEMBERSHIP_TRACK.LEAD) return "Never contacted";

  if (live) {
    const bits = [live.planName ?? live.optionLabel, live.price != null ? formatMoney(live.price) : null]
      .filter(Boolean)
      .join(" · ");
    return bits || null;
  }

  if (track === MEMBERSHIP_TRACK.PENDING && (m.legacyMembershipName || m.legacyMembershipPrice != null)) {
    const bits = [
      m.legacyMembershipName,
      m.legacyMembershipPrice != null ? formatMoney(m.legacyMembershipPrice) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return bits ? `${bits} · imported` : "Imported plan";
  }

  if (track === MEMBERSHIP_TRACK.INACTIVE) {
    const ended = subs
      .map((s) => toDate(s.canceledAt) ?? toDate(s.endDate))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return ended ? `Lapsed ${shortDate(ended)}` : "Lapsed";
  }

  return null;
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2).replace(/\.00$/, "")}`;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Track 3 — Account setup (login + migration)
// ─────────────────────────────────────────────────────────────────────────────

export const SETUP_TRACK = {
  NOT_INVITED: "NOT_INVITED",
  INVITED: "INVITED",
  SETTING_UP: "SETTING_UP",
  PROFILE_CREATED: "PROFILE_CREATED",
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
  /**
   * Manually-added members who have not finished. NOT the same as NOT_INVITED:
   * nobody ever intended to invite a walk-in minor added at practice, so
   * labelling them "Un-invited" reads as an outstanding task that does not
   * exist. The README explicitly retires "Un-invited" for this group.
   */
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
} as const;

export type SetupTrack = (typeof SETUP_TRACK)[keyof typeof SETUP_TRACK];

/** Dot colors. Track 3 is a 6px dot + label — never a pill. */
export const SETUP_DOT: Record<SetupTrack, string> = {
  NOT_INVITED: "#9CA3AF",
  INVITED: "#FF6A00",
  SETTING_UP: "#6D5DF6",
  PROFILE_CREATED: "#6D5DF6",
  COMPLETE: "#4D7C0F",
  BLOCKED: "#DC2626",
  PROFILE_INCOMPLETE: "#9CA3AF",
};

/**
 * The closed value set for `members.blockedReason`.
 *
 * J-2 (owner, 2026-08-04): the COLUMN is TEXT, not a Postgres enum, so the list
 * can grow as real delivery failures are observed without a migration. But the
 * TYPE is a union, so a typo is a compile error rather than a silent new reason
 * that renders as "Blocked · emial bounced" and matches nothing.
 *
 * To add a reason: add it here and to BLOCKED_REASON_LABELS. The Record type
 * below makes the label mandatory — you cannot add one without the other.
 */
export const BLOCKED_REASONS = [
  "EMAIL_BOUNCED",
  "EMAIL_MISSING",
  "REPEATED_NO_OPEN",
  "SETUP_FAILED",
  "CONFLICTING_DATA",
  "MANUAL",
] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const BLOCKED_REASON_LABELS: Record<BlockedReason, string> = {
  EMAIL_BOUNCED: "email bounced",
  EMAIL_MISSING: "no email on file",
  REPEATED_NO_OPEN: "never opened",
  SETUP_FAILED: "setup failed",
  CONFLICTING_DATA: "conflicting data",
  MANUAL: "set aside",
};

/**
 * Narrow whatever the database returned to a known reason.
 *
 * The column is TEXT, so a row written by an older build — or by hand — can
 * carry anything. Unknown values are treated as "no reason recorded" rather
 * than rendered raw: showing an owner a bare enum token they have never seen is
 * worse than showing them a generic blocked state.
 */
export function asBlockedReason(v: string | null | undefined): BlockedReason | null {
  if (!v) return null;
  return (BLOCKED_REASONS as readonly string[]).includes(v) ? (v as BlockedReason) : null;
}

/** How many unopened sends before we stop burning invitations on an address. */
export const REPEATED_NO_OPEN_THRESHOLD = 3;

/**
 * Blocked is DERIVED as well as stored. The stored column is an explicit staff
 * or webhook decision; the derivation catches the case the redesign names
 * directly — "3 sends, never opened" — without waiting for someone to set a
 * flag. Returns null when nothing is blocking.
 */
export function derivedBlockedReason(m: MemberTrackInput): BlockedReason | null {
  // The stored column is TEXT, so narrow it before trusting it (J-2).
  const stored = asBlockedReason(m.blockedReason);
  if (stored) return stored;
  if ((m.invitationBouncedCount ?? 0) > 0) return "EMAIL_BOUNCED";

  const sends = m.invitationSendCount ?? m.activationEmailSendCount ?? 0;
  const opens = m.invitationOpenedCount ?? 0;
  if (sends >= REPEATED_NO_OPEN_THRESHOLD && opens === 0) return "REPEATED_NO_OPEN";

  // Only a problem for someone we are STILL trying to invite.
  //
  // Two exclusions, both learned from fixtures that failed the first time this
  // ran:
  //   · a manually-added walk-in is not on the invitation path at all, so a
  //     missing email is not an outstanding task;
  //   · someone who already opened the link — reached billing, activated, or
  //     finished — is past needing an address. Blocking them for "no email on
  //     file" would put a red Blocked dot on a member who has completed setup,
  //     which is exactly the class of wrong-but-defensible label this redesign
  //     exists to kill.
  if (isImported(m) && !inviteAddressFor(m) && !hasStartedSetup(m)) return "EMAIL_MISSING";

  return null;
}

/** True once the member has demonstrably opened the invitation and acted on it. */
export function hasStartedSetup(m: MemberTrackInput): boolean {
  return (
    Boolean(m.paymentSetupStatus) ||
    isSet(m.activatedAt) ||
    m.migrationStatus === "ACTIVATED" ||
    m.migrationStatus === "COMPLETED" ||
    setupComplete(m)
  );
}

/** Where an invitation would actually go. Minors' invitations go to a guardian. */
export function inviteAddressFor(m: MemberTrackInput): string | null {
  const own = m.email?.trim() || null;
  const guardian = m.guardianEmail?.trim() || null;
  return m.isMinor ? guardian || own : own || guardian;
}

/** True when this person's setup is finished by any legitimate route. */
export function setupComplete(m: MemberTrackInput): boolean {
  if (m.userId) return true;
  // A minor whose guardian holds the account IS complete. Requiring the child
  // to have their own login is what produced "Profile incomplete" on families
  // that had finished onboarding months earlier.
  if (m.isMinor && m.hasGuardianAccount) return true;
  return false;
}

export function setupTrackFor(m: MemberTrackInput): SetupTrack {
  const blocked = derivedBlockedReason(m);
  // Blocked outranks everything except being finished: a completed member with
  // an old bounce is not an outstanding task.
  if (setupComplete(m)) return SETUP_TRACK.COMPLETE;
  if (blocked) return SETUP_TRACK.BLOCKED;

  // Profile finished, membership not yet confirmed by the owner.
  if (isSet(m.activatedAt) || m.migrationStatus === "ACTIVATED" || m.migrationStatus === "COMPLETED") {
    return SETUP_TRACK.PROFILE_CREATED;
  }

  // Started but not finished. paymentSetupStatus is the only fact recorded
  // today that means "they opened the link and got as far as billing".
  if (m.paymentSetupStatus) return SETUP_TRACK.SETTING_UP;

  if (isSet(m.activationEmailSentAt) || m.migrationStatus === "INVITED") return SETUP_TRACK.INVITED;

  // Only migration-outreach members can be "not invited" — for everyone else
  // there was never an invitation to send.
  if (isImported(m)) return SETUP_TRACK.NOT_INVITED;

  return SETUP_TRACK.PROFILE_INCOMPLETE;
}

export function setupLabelFor(m: MemberTrackInput, now: Date = new Date()): string {
  const t = setupTrackFor(m);
  switch (t) {
    case SETUP_TRACK.COMPLETE:
      return "Complete";
    case SETUP_TRACK.BLOCKED: {
      const reason = derivedBlockedReason(m);
      const text = reason ? BLOCKED_REASON_LABELS[reason] : "blocked";
      return `Blocked · ${text}`;
    }
    case SETUP_TRACK.PROFILE_CREATED:
      return "Profile created";
    case SETUP_TRACK.SETTING_UP:
      return "Setting up";
    case SETUP_TRACK.INVITED: {
      const sent = toDate(m.lastInvitationSentAt) ?? toDate(m.activationEmailSentAt);
      const days = sent ? daysBetween(sent, now) : null;
      if (days === null) return "Invited";
      if (days <= 0) return "Invited · today";
      if (days === 1) return "Invited · 1 day ago";
      return `Invited · ${days} days ago`;
    }
    case SETUP_TRACK.NOT_INVITED:
      return "Not invited";
    default:
      return "Profile incomplete";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The 7-step migration meter
// ─────────────────────────────────────────────────────────────────────────────

export const MIGRATION_STEPS = [
  "Imported",
  "Information reviewed",
  "Invitation sent",
  "Member started setup",
  "Profile completed",
  "Membership confirmed",
  "Migration complete",
] as const;

export const MIGRATION_STEP_COUNT = MIGRATION_STEPS.length;

export const WAITING_ON = {
  NOBODY: "NOBODY",
  /** The club. Rendered "waiting on you". */
  STAFF: "STAFF",
  MEMBER: "MEMBER",
  BLOCKED: "BLOCKED",
} as const;

export type WaitingOn = (typeof WAITING_ON)[keyof typeof WAITING_ON];

export const WAITING_ON_LABELS: Record<WaitingOn, string> = {
  NOBODY: "Nobody",
  STAFF: "waiting on you",
  MEMBER: "waiting on member",
  BLOCKED: "blocked",
};

export type MigrationMeter = {
  /** 0 when the person is not a migration member at all. */
  step: number;
  total: number;
  steps: { index: number; label: string; done: boolean; current: boolean }[];
  waitingOn: WaitingOn;
  /** Whether to render the meter. Non-migration members get no meter. */
  applicable: boolean;
};

/**
 * How far through the 7 steps this person is. `step` is the number COMPLETED,
 * so a member who has been imported and reviewed but not invited is at step 2
 * with step 3 current.
 */
export function migrationMeterFor(m: MemberTrackInput, now: Date = new Date()): MigrationMeter {
  const applicable = isImported(m);

  const done: boolean[] = [
    // 1. Imported
    applicable,
    // 2. Information reviewed — the fact this migration adds. Before the column
    //    exists this is always false, which is honest: nothing recorded a review.
    isSet(m.reviewedAt),
    // 3. Invitation sent
    isSet(m.activationEmailSentAt) || isSet(m.lastInvitationSentAt) || m.migrationStatus === "INVITED",
    // 4. Member started setup
    Boolean(m.paymentSetupStatus) || isSet(m.activatedAt) || m.migrationStatus === "ACTIVATED" || m.migrationStatus === "COMPLETED",
    // 5. Profile completed
    isSet(m.activatedAt) || m.migrationStatus === "ACTIVATED" || m.migrationStatus === "COMPLETED",
    // 6. Membership confirmed
    m.approvalStatus === "APPROVED" || m.migrationStatus === "COMPLETED",
    // 7. Migration complete
    isSet(m.migrationCompletedAt) || m.migrationStatus === "COMPLETED",
  ];

  // Steps are ordinal: reaching step 5 means 1–4 happened even if a timestamp
  // is missing. Without this, a member activated before reviewedAt existed
  // renders a hole in the middle of their meter.
  let seenTrue = false;
  for (let i = done.length - 1; i >= 0; i--) {
    if (done[i]) seenTrue = true;
    else if (seenTrue) done[i] = true;
  }

  const step = done.filter(Boolean).length;
  const currentIndex = step >= MIGRATION_STEP_COUNT ? -1 : step; // 0-based index of the next step

  let waitingOn: WaitingOn = WAITING_ON.NOBODY;
  if (applicable && step < MIGRATION_STEP_COUNT) {
    if (setupTrackFor(m) === SETUP_TRACK.BLOCKED) waitingOn = WAITING_ON.BLOCKED;
    else if (isFuture(m.snoozedUntil, now)) waitingOn = WAITING_ON.NOBODY;
    // Steps 2, 6 and 7 are the club's move; 3 is the club's move too (someone
    // has to press send). 4 and 5 are the member's.
    else if (currentIndex === 3 || currentIndex === 4) waitingOn = WAITING_ON.MEMBER;
    else waitingOn = WAITING_ON.STAFF;
  }

  return {
    step,
    total: MIGRATION_STEP_COUNT,
    steps: MIGRATION_STEPS.map((label, i) => ({
      index: i + 1,
      label,
      done: done[i],
      current: i === currentIndex,
    })),
    waitingOn,
    applicable,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// nextAction — ONE resolver, three renderings
// ─────────────────────────────────────────────────────────────────────────────

export const ACTION_KIND = {
  FIX_EMAIL: "FIX_EMAIL",
  /**
   * Delivery succeeded and nobody read it. Distinct from FIX_EMAIL because the
   * two need OPPOSITE actions — see the branch in nextAction(). Only reachable
   * once per-send delivery data exists to prove nothing bounced.
   */
  CALL_GUARDIAN: "CALL_GUARDIAN",
  REVIEW_INFO: "REVIEW_INFO",
  SEND_INVITATION: "SEND_INVITATION",
  RESEND_INVITE: "RESEND_INVITE",
  CONFIRM_MEMBERSHIP: "CONFIRM_MEMBERSHIP",
  COMPLETE_MIGRATION: "COMPLETE_MIGRATION",
  ASSIGN_MEMBERSHIP: "ASSIGN_MEMBERSHIP",
  /** J-10: an untouched lead needs contact, not an offer. */
  MAKE_CONTACT: "MAKE_CONTACT",
  WIN_BACK: "WIN_BACK",
  ADD_CONTACT: "ADD_CONTACT",
  LEAVE_ALONE: "LEAVE_ALONE",
  NONE: "NONE",
} as const;

export type ActionKind = (typeof ACTION_KIND)[keyof typeof ACTION_KIND];

/** How the button renders. `charcoal` is reserved for fixing a broken thing. */
export type ActionTone = "brand" | "charcoal" | "muted";

export type NextAction = {
  kind: ActionKind;
  label: string;
  tone: ActionTone;
  /**
   * `<permission key>:<level>` the actor needs. The UI renders a locked,
   * greyed item with this named rather than hiding it — a coach must be able to
   * see that the action exists and who can do it.
   */
  permission: string | null;
  /** Whose turn it is, so the banner can say it without recomputing. */
  waitingOn: WaitingOn;
  /** Evidence line for the profile banner. Null for the row button. */
  detail?: string | null;
  /** True while a snooze is active — drops the person out of "Needs you". */
  snoozed?: boolean;
};

/**
 * The single decision. Precedence is deliberate and top-to-bottom:
 *
 *   1. Something is broken            → fix it before spending another send
 *   2. Someone is owed an answer      → the club is the blocker
 *   3. The member is mid-flight       → nudge, don't duplicate work
 *   4. Money is unresolved            → assign or win back
 *   5. Nothing to do                  → say so plainly
 */
export function nextAction(m: MemberTrackInput, now: Date = new Date()): NextAction {
  const setup = setupTrackFor(m);
  const meter = migrationMeterFor(m, now);
  const membership = membershipTrackFor(m, now);
  const snoozed = isFuture(m.snoozedUntil, now);

  // ── 1. Broken ─────────────────────────────────────────────────────────────
  if (setup === SETUP_TRACK.BLOCKED) {
    const reason = derivedBlockedReason(m);
    const sends = m.invitationSendCount ?? m.activationEmailSendCount ?? 0;
    const addr = inviteAddressFor(m);

    if (reason === "EMAIL_MISSING") {
      return {
        kind: ACTION_KIND.ADD_CONTACT,
        label: "Add email",
        tone: "charcoal",
        permission: "members:edit",
        waitingOn: WAITING_ON.BLOCKED,
        detail: `${m.firstName} has no email on file${m.isMinor ? " and no guardian address" : ""}, so there is nowhere to send an invitation.`,
        snoozed,
      };
    }
    // A BOUNCE and an IGNORE need opposite actions, and until the per-send
    // delivery log existed there was no way to tell them apart — so both
    // rendered "Fix email". That is right for a bounce and actively wrong for
    // an ignore: the address is fine, and telling staff to change it wastes
    // the one correct address the club has.
    //
    // REPEATED_NO_OPEN means delivery succeeded (or was never contradicted) and
    // nobody read it. The handoff's answer to that is a phone call — §1j lists
    // "Call <guardian>" in both the quick-action sheet and the compact profile
    // banner. Gated on members:view, because phoning a parent is not an edit.
    if (reason === "REPEATED_NO_OPEN") {
      const who = m.isMinor && m.guardianName ? m.guardianName : m.firstName;
      return {
        kind: ACTION_KIND.CALL_GUARDIAN,
        label: m.isMinor && m.guardianName ? `Call ${who.split(" ")[0]}` : "Call them",
        tone: "charcoal",
        permission: "members:view",
        waitingOn: WAITING_ON.BLOCKED,
        detail:
          `${sends} invitation${sends === 1 ? "" : "s"} sent to ${addr ?? "their address"}, never opened. ` +
          `The address works — nothing bounced — so changing it will not help.`,
        snoozed,
      };
    }

    return {
      kind: ACTION_KIND.FIX_EMAIL,
      label: "Fix email",
      tone: "charcoal",
      permission: "members:edit",
      waitingOn: WAITING_ON.BLOCKED,
      detail: `Invitations to ${addr ?? "their address"} are bouncing. Nothing will arrive until the address changes.`,
      snoozed,
    };
  }

  // A snoozed person keeps their real state but stops asking for attention.
  if (snoozed) {
    return {
      kind: ACTION_KIND.LEAVE_ALONE,
      label: "Snoozed",
      tone: "muted",
      permission: null,
      waitingOn: WAITING_ON.NOBODY,
      detail: `Set aside until ${shortDate(toDate(m.snoozedUntil)!)}.`,
      snoozed: true,
    };
  }

  // ── 2 & 3. Mid-migration ──────────────────────────────────────────────────
  if (meter.applicable && meter.step < MIGRATION_STEP_COUNT) {
    const currentStep = meter.step + 1; // 1-based

    if (currentStep === 2) {
      return {
        kind: ACTION_KIND.REVIEW_INFO,
        label: "Review info",
        tone: "brand",
        permission: "members:edit",
        waitingOn: WAITING_ON.STAFF,
        detail: "Check what came over from the import before inviting them.",
      };
    }
    if (currentStep === 3) {
      return {
        kind: ACTION_KIND.SEND_INVITATION,
        label: "Send invitation",
        tone: "brand",
        permission: "members:edit",
        waitingOn: WAITING_ON.STAFF,
        detail: `Nothing has been sent to ${m.firstName} yet.`,
      };
    }
    if (currentStep === 4 || currentStep === 5) {
      const sends = m.invitationSendCount ?? m.activationEmailSendCount ?? 0;
      const sentAt = toDate(m.lastInvitationSentAt) ?? toDate(m.activationEmailSentAt);
      const days = sentAt ? daysBetween(sentAt, now) : null;
      return {
        kind: ACTION_KIND.RESEND_INVITE,
        label: "Resend invite",
        tone: "brand",
        permission: "members:edit",
        waitingOn: WAITING_ON.MEMBER,
        detail: [
          sends > 0 ? `${sends} invitation${sends === 1 ? "" : "s"} sent` : "Invitation sent",
          inviteAddressFor(m) ? `to ${inviteAddressFor(m)}` : null,
          days !== null ? (days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    if (currentStep === 6) {
      return {
        kind: ACTION_KIND.CONFIRM_MEMBERSHIP,
        label: "Confirm membership",
        tone: "brand",
        // Confirming a membership is what starts billing, so it is gated on
        // `billing`, not `members` — a coach with members:edit must not be able
        // to start charging a family.
        permission: "billing:full",
        waitingOn: WAITING_ON.STAFF,
        detail: `${m.firstName} finished setup. Nothing is charged until you confirm the plan.`,
      };
    }
    return {
      kind: ACTION_KIND.COMPLETE_MIGRATION,
      label: "Mark complete",
      tone: "brand",
      permission: "members:edit",
      waitingOn: WAITING_ON.STAFF,
      detail: "Billing is live here. Safe to stop the old system for this member.",
    };
  }

  // ── 4. Money ──────────────────────────────────────────────────────────────
  if (membership === MEMBERSHIP_TRACK.PROSPECT) {
    return {
      kind: ACTION_KIND.ASSIGN_MEMBERSHIP,
      label: "Assign membership",
      tone: "brand",
      permission: "billing:full",
      waitingOn: WAITING_ON.STAFF,
      // They have been in the building. The offer is the next step.
      detail: `${m.firstName} has trained here but never joined.`,
    };
  }
  if (membership === MEMBERSHIP_TRACK.LEAD) {
    return {
      kind: ACTION_KIND.MAKE_CONTACT,
      label: "Make contact",
      tone: "brand",
      // Reaching out is not a money action, so it is gated on members, not
      // billing — a coach should be able to call a lead without being able to
      // start charging one.
      permission: "members:edit",
      waitingOn: WAITING_ON.STAFF,
      detail: `Nobody has contacted ${m.firstName} yet.`,
    };
  }
  if (membership === MEMBERSHIP_TRACK.INACTIVE) {
    return {
      kind: ACTION_KIND.WIN_BACK,
      label: "Win back",
      tone: "brand",
      permission: "billing:full",
      waitingOn: WAITING_ON.STAFF,
      detail: membershipDetailFor(m, now),
    };
  }

  // ── 5. Nothing outstanding ────────────────────────────────────────────────
  // Said plainly rather than left blank: an empty action cell reads as "not
  // loaded yet", and staff click it to find out.
  return {
    kind: ACTION_KIND.LEAVE_ALONE,
    label: "Leave alone",
    tone: "muted",
    permission: null,
    waitingOn: WAITING_ON.NOBODY,
    detail: null,
  };
}

/** Does this person belong in the "Needs you" work queue? */
export function needsStaffAttention(m: MemberTrackInput, now: Date = new Date()): boolean {
  const a = nextAction(m, now);
  if (a.snoozed) return false;
  return a.waitingOn === WAITING_ON.STAFF || a.waitingOn === WAITING_ON.BLOCKED;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import source label — never a hardcoded vendor name
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONLY place a previous-software name may come from is something the owner
 * typed. Resolution order:
 *
 *   1. ImportBatch.sourceLabel  — the 2.5.9 wizard's "Where are you importing
 *                                 from?" field. Already in production.
 *   2. Member.legacySource      — what the older CSV migration importer stored.
 *                                 Also owner-supplied, just from a different
 *                                 flow, so it is a legitimate fallback rather
 *                                 than a guess.
 *   3. null                     — copy degrades; it never invents a name.
 */
export function resolveSourceLabel(input: {
  batchSourceLabel?: string | null;
  legacySource?: string | null;
}): string | null {
  const batch = input.batchSourceLabel?.trim();
  if (batch) return batch;
  const legacy = input.legacySource?.trim();
  if (legacy) return legacy;
  return null;
}

/** "As imported from Acme Gym" → "As imported" when the owner typed nothing. */
export function importedColumnHeader(label: string | null): string {
  return label ? `As imported from ${label}` : "As imported";
}

/** "imported from Acme Gym on Jul 8" → "imported Jul 8" → "imported". */
export function importedMetaLine(label: string | null, importedAt: DateLike): string {
  const d = toDate(importedAt);
  const when = d ? shortDate(d) : null;
  if (label && when) return `imported from ${label} · ${when}`;
  if (label) return `imported from ${label}`;
  if (when) return `imported ${when}`;
  return "imported";
}

/** The prose fallback used in sentences: "…from your previous system". */
export function sourcePhrase(label: string | null): string {
  return label || "your previous system";
}
