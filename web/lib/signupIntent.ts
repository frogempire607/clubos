// What a member signup is actually FOR — and therefore which rows it may create.
//
// The defect this exists to kill (audit 2026-08-15, plan §7.0):
//
//   A dad opened /member/signup, picked "Young Athlete", typed his SON'S name,
//   HIS OWN email, and that same address again as the guardian email. The route
//   created ONE User — email = dad's, name = the son's — nested the son's Member
//   under it, and then the consent link resolved the guardian BY EMAIL and found
//   that same account. The result was a single User that was simultaneously the
//   athlete, the athlete's login, and the athlete's guardian.
//
//   `applyParentalControls` keys oversight on `member.userId !== bookerUserId`,
//   so the child was treated as acting alone — controls inverted. And because
//   `Member.userId` is globally unique, a second Dorn child could never attach.
//
// Nobody pointed anything anywhere. The email lookup did it, because the form
// never said whose account was being created. So intent is now explicit, and
// the two addresses may never be the same address.
//
// PURE — no prisma, no next, no env. `scripts/signup-intent-tests.ts` covers it.

export type SignupIntent = "ADULT_ATHLETE" | "MINOR_ATHLETE" | "PARENT";

export const SIGNUP_INTENTS: readonly SignupIntent[] = [
  "ADULT_ATHLETE",
  "MINOR_ATHLETE",
  "PARENT",
] as const;

/**
 * Copy for step 1's picker. Each option states the OUTCOME in the person's own
 * words, and `accountLine` names — on the form, before they type anything —
 * whose login is about to exist. That sentence is the fix for "the dad's login
 * is named after his son".
 */
export const SIGNUP_INTENT_COPY: Record<
  SignupIntent,
  { label: string; description: string; accountLine: string }
> = {
  MINOR_ATHLETE: {
    label: "I'm signing my child up",
    description: "I'll manage their account",
    accountLine: "We'll create YOUR account, and add your child as an athlete under it.",
  },
  ADULT_ATHLETE: {
    label: "I train here myself",
    description: "I'm the athlete (18+)",
    accountLine: "We'll create your account and your athlete profile.",
  },
  PARENT: {
    label: "I only manage someone else's account",
    description: "My athlete is already registered with the club",
    accountLine: "We'll create YOUR account and connect you to athletes the club lists under your email.",
  },
};

export function normalizeEmail(raw: string | null | undefined): string {
  return (raw || "").trim().toLowerCase();
}

/**
 * THE AJ DORN RULE.
 *
 * One address may not be both the account being created and the guardian of
 * that account's athlete. When it is, the guardian-by-email lookup resolves to
 * the account itself and mints a self-guardian link — shape A.
 *
 * Empty guardian email is not a conflict (nothing to collide with); the
 * requiredness of a guardian email is a separate rule.
 */
export function guardianEmailConflictsWithAccount(
  accountEmail: string | null | undefined,
  guardianEmail: string | null | undefined,
): boolean {
  const account = normalizeEmail(accountEmail);
  const guardian = normalizeEmail(guardianEmail);
  if (!account || !guardian) return false;
  return account === guardian;
}

export const GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL = "GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL" as const;
export const CHILD_NAME_REQUIRED = "CHILD_NAME_REQUIRED" as const;
export const GUARDIAN_EMAIL_REQUIRED = "GUARDIAN_EMAIL_REQUIRED" as const;

export type SignupRejectionCode =
  | typeof GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL
  | typeof CHILD_NAME_REQUIRED
  | typeof GUARDIAN_EMAIL_REQUIRED;

export type SignupPlanInput = {
  intent: SignupIntent;
  /** The email the password is being set for — the account holder. */
  accountEmail: string;
  accountFirstName: string;
  accountLastName: string;
  /** Present on the modern child path: the athlete is a separate person. */
  childFirstName?: string | null;
  childLastName?: string | null;
  /**
   * Only the LEGACY minor shape sends this — a young athlete signing up with
   * their own login, naming a parent. The modern child path derives the
   * guardian from the account holder, so it sends nothing here.
   */
  guardianEmail?: string | null;
  guardianName?: string | null;
};

/**
 * What the submission is allowed to create. The route executes this; it does
 * not re-derive it. Keeping the decision in one pure function is what makes
 * "two User rows, zero self-guardian links" a testable property rather than a
 * hope about control flow.
 */
export type SignupPlan =
  /** The signer is the athlete. One User, one Member, no guardian. */
  | { kind: "ADULT_SELF"; accountIsAthlete: true; createsChildMember: false; guardianLink: "none" }
  /**
   * The signer is the GUARDIAN. Their User is the account; the child is a
   * Member with `userId: null` reached only through a guardian link. A
   * self-guardian link is structurally impossible here — the child has no
   * login to be conflated with.
   */
  | {
      kind: "CHILD_BY_GUARDIAN";
      accountIsAthlete: false;
      createsChildMember: true;
      guardianLink: "confirmed";
      child: { firstName: string; lastName: string };
    }
  /** Guardian-only login. No athlete created; the vouched sweep links existing ones. */
  | { kind: "GUARDIAN_ONLY"; accountIsAthlete: false; createsChildMember: false; guardianLink: "sweep" }
  /**
   * LEGACY: a minor with their OWN login naming a separate parent. Kept so an
   * older cached client can still submit, and so a genuine teen-with-own-email
   * keeps working. The guardian is a DIFFERENT User — created right after the
   * child's — and consent still routes through the emailed link.
   */
  | {
      kind: "MINOR_SELF_LEGACY";
      accountIsAthlete: true;
      createsChildMember: false;
      guardianLink: "consent-email";
      guardian: { email: string; name: string | null };
    };

export type SignupPlanResult =
  | { ok: true; plan: SignupPlan }
  | { ok: false; code: SignupRejectionCode; error: string };

export function planSignup(input: SignupPlanInput): SignupPlanResult {
  const accountEmail = normalizeEmail(input.accountEmail);
  const guardianEmail = normalizeEmail(input.guardianEmail);
  const childFirst = (input.childFirstName || "").trim();
  const childLast = (input.childLastName || "").trim();
  const hasChildName = !!childFirst;

  if (input.intent === "ADULT_ATHLETE") {
    // An adult athlete has no guardian. If a caller sends one anyway and it is
    // their own address, that is still the conflated shape — refuse it rather
    // than quietly storing a member who is their own guardian.
    if (guardianEmailConflictsWithAccount(accountEmail, guardianEmail)) {
      return rejectSameEmail();
    }
    return { ok: true, plan: { kind: "ADULT_SELF", accountIsAthlete: true, createsChildMember: false, guardianLink: "none" } };
  }

  if (input.intent === "PARENT") {
    if (guardianEmailConflictsWithAccount(accountEmail, guardianEmail)) {
      return rejectSameEmail();
    }
    return { ok: true, plan: { kind: "GUARDIAN_ONLY", accountIsAthlete: false, createsChildMember: false, guardianLink: "sweep" } };
  }

  // ── MINOR_ATHLETE ──────────────────────────────────────────────────────────
  // The modern form sends the child's name separately, which is how we know the
  // account holder is the guardian rather than the athlete.
  if (hasChildName) {
    // The guardian IS the account. A caller that also sends a DIFFERENT guardian
    // email is describing two guardians, which this form cannot express — the
    // co-guardian invite exists for that. Same address is the normal case here
    // and is NOT a conflict, because no child login is created to collide with.
    return {
      ok: true,
      plan: {
        kind: "CHILD_BY_GUARDIAN",
        accountIsAthlete: false,
        createsChildMember: true,
        guardianLink: "confirmed",
        child: { firstName: childFirst, lastName: childLast },
      },
    };
  }

  // LEGACY shape: firstName/lastName are the CHILD's and the account is theirs.
  if (!guardianEmail) {
    return {
      ok: false,
      code: GUARDIAN_EMAIL_REQUIRED,
      error:
        "A parent or guardian email is required to sign up a minor. Their consent is needed before the account can be used.",
    };
  }
  if (guardianEmailConflictsWithAccount(accountEmail, guardianEmail)) {
    return rejectSameEmail();
  }
  return {
    ok: true,
    plan: {
      kind: "MINOR_SELF_LEGACY",
      accountIsAthlete: true,
      createsChildMember: false,
      guardianLink: "consent-email",
      guardian: { email: guardianEmail, name: (input.guardianName || "").trim() || null },
    },
  };
}

function rejectSameEmail(): SignupPlanResult {
  return {
    ok: false,
    code: GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL,
    error:
      "The guardian email can't be the same as the email you're creating the account with — one address can't be both the athlete's login and the athlete's guardian. " +
      "If you're a parent signing your child up, go back and choose \"I'm signing my child up\": we'll create your account and add your child under it. " +
      "If the athlete has their own email, enter theirs above and keep the parent's here.",
  };
}

// ── Free trial attachment (§7.3) ─────────────────────────────────────────────

/**
 * A trial is a CLASS entitlement, so it belongs to whoever attends classes —
 * never to a login. Returns which member the window may be written to.
 *
 * `none` carries a reason so a parent who clicked a trial link is TOLD what
 * happened. The old code skipped the block silently when `memberProfile` was
 * null, which is why a guardian-only signup got no trial and no explanation.
 */
export type TrialTarget =
  | { target: "account-athlete" }
  | { target: "child" }
  | { target: "none"; reason: string };

export function trialTargetFor(plan: SignupPlan): TrialTarget {
  switch (plan.kind) {
    case "ADULT_SELF":
    case "MINOR_SELF_LEGACY":
      return { target: "account-athlete" };
    case "CHILD_BY_GUARDIAN":
      return { target: "child" };
    case "GUARDIAN_ONLY":
      return {
        target: "none",
        reason:
          "Your account manages athletes but isn't an athlete itself, so there's nothing to start a trial on yet. Add your athlete and we'll apply it to them.",
      };
  }
}

/**
 * Refuse to write `trialEndsAt` onto a record whose identity is ambiguous.
 *
 * Shape A (`Member.userId` is ALSO a guardian link on that same member) means
 * the row is simultaneously the athlete and the athlete's guardian. We cannot
 * say who the entitlement belongs to, so we grant nothing and say so rather
 * than stamping a trial onto a record that is about to be split apart by
 * scripts/fix-family-shapes.ts.
 */
export function trialBlockedBySelfGuardian(member: {
  userId: string | null;
  guardianUserIds: string[];
}): boolean {
  if (!member.userId) return false;
  return member.guardianUserIds.includes(member.userId);
}
