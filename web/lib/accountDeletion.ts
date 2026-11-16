// What deleting your own account does. PURE — no database, no network.
//
// Both stores require that anyone who can create an account can delete it from
// inside the app (Apple 5.1.1(v); Google User Data policy), that "deactivate"
// is not offered in place of "delete", and that anything kept is named up
// front. Until 2026-11 only members had a delete button, it left a card-billed
// membership charging with nobody able to see it, and staff and owners had no
// way to delete at all.
//
// This module decides; lib/accountDeletionServer.ts reads the facts and writes.
// Every sentence a person reads before confirming comes from here, so the
// screen, the public /delete-account page and the tests cannot drift apart.

export type AccountRole = "MEMBER" | "STAFF" | "OWNER";

export type ManagedChild = {
  name: string;
  /** Other CONFIRMED guardians with a login, not counting the person deleting. */
  otherGuardians: number;
};

export type AccountDeletionFacts = {
  role: AccountRole;
  /** Other live OWNER logins in the same club. Only consulted for an owner. */
  otherOwners: number;
  /** The person has their own athlete/member profile at the club. */
  hasOwnMemberProfile: boolean;
  children: ManagedChild[];
  /**
   * Card-billed memberships this person pays for or holds that are still
   * running. Deleting the login does not stop Stripe; the club has to.
   */
  liveCardMemberships: { athleteName: string; planName: string }[];
};

export type AccountDeletionPlan = {
  allowed: boolean;
  /** Why not, in words for the person. Null when allowed. */
  blockedReason: string | null;
  /** What is removed, effective immediately. */
  removed: string[];
  /** What the club keeps, and why. */
  kept: string[];
  /** Things that happen as a consequence and need saying before confirming. */
  consequences: string[];
};

export const DELETE_CONFIRM_WORD = "delete";

/** The typed confirmation, forgiving about case and stray spaces only. */
export function deletionConfirmed(typed: string | null | undefined): boolean {
  return (typed ?? "").trim().toLowerCase() === DELETE_CONFIRM_WORD;
}

/** "A", "A and B", "A, B and C". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function planAccountDeletion(f: AccountDeletionFacts): AccountDeletionPlan {
  // The only refusal. A club with no owner cannot be administered, billed or
  // closed by anyone — and "delete the last owner" is really "close the club",
  // which is its own screen with its own warnings.
  if (f.role === "OWNER" && f.otherOwners === 0) {
    return {
      allowed: false,
      blockedReason:
        "You are the only owner of this club. Add another owner first, or close the club from Settings — closing it deletes your account along with it.",
      removed: [],
      kept: [],
      consequences: [],
    };
  }

  const removed = [
    "Your sign-in: your email address, password and any saved sign-in on your devices. You are signed out everywhere straight away.",
    "Your access to this club's information, including any children you manage.",
  ];
  if (f.role === "MEMBER") removed.push("Your name on your login. Messages you sent stay in the other person's inbox, shown as from a deleted account.");
  if (f.hasOwnMemberProfile && f.liveCardMemberships.length === 0) {
    removed.push("Your own athlete profile is taken off the club's active roster.");
  }
  if (f.role !== "MEMBER") removed.push("Your place on the class schedule from today on, and your personal calendar link.");

  const kept = [
    "Payment records, invoices and receipts — the club must keep these for its books and for tax.",
    "Documents and waivers that were signed, with the signer's name and the date.",
    "Attendance history.",
  ];
  if (f.role !== "MEMBER") {
    kept.push("Your name on records you created or were paid for (payments you recorded, classes you taught, payroll). A record with no name is not a record.");
  }

  const consequences: string[] = [];

  const stranded = f.children.filter((c) => c.otherGuardians === 0);
  const shared = f.children.filter((c) => c.otherGuardians > 0);
  if (shared.length > 0) {
    consequences.push(
      `${nameList(shared.map((c) => c.name))} ${shared.length === 1 ? "stays" : "stay"} with the club, and the other parent or guardian on the account keeps full access.`,
    );
  }
  if (stranded.length > 0) {
    consequences.push(
      `You are the only parent or guardian with a login for ${nameList(stranded.map((c) => c.name))}. ` +
        `${stranded.length === 1 ? "Their record stays" : "Their records stay"} with the club, but nobody will be able to book, pay or sign for ` +
        `them online until the club adds a guardian. ` +
        `To have a child's information removed as well, ask the club — it holds those records.`,
    );
  }

  if (f.liveCardMemberships.length > 0) {
    const lines = f.liveCardMemberships.map((m) => `${m.athleteName} — ${m.planName}`);
    consequences.push(
      `Deleting your account does not cancel a membership by itself. We will send the club a cancellation request for: ${lines.join("; ")}. ` +
        `Billing follows the club's terms until the club confirms, and you will not be able to see it here once your account is gone — contact the club if you are charged again.`,
    );
  }

  consequences.push("This cannot be undone. To use the club's portal again you would create a new account.");

  return { allowed: true, blockedReason: null, removed, kept, consequences };
}

/** The address a deleted login's row is given, so the real one is released. */
export function tombstoneEmail(userId: string): string {
  return `deleted-${userId}@deleted.athletix-os.invalid`;
}

/** True for an address produced by `tombstoneEmail`. */
export function isTombstoneEmail(email: string | null | undefined): boolean {
  return /^deleted-[^@]+@deleted\.athletix-os\.invalid$/.test(email ?? "");
}
