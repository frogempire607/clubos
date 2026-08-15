// What archiving a member actually does — and what it must never do.
//
// "Delete" here is always a SOFT delete. Money, signed documents, email
// history and attendance are records of things that really happened; a club
// that removed them would be unable to answer a chargeback, an audit, or a
// parent asking what they paid. The member stops appearing in the roster,
// billing and messaging, and can be restored.
//
// Pure: no prisma, no IO. Tested by scripts/member-deletion-tests.ts.

export interface AttachedRecords {
  transactions: number;
  succeededTransactions: number;
  activeSubscriptions: number;
  guardianLinks: number;
  guardedByThisMember: number;
  emailSends: number;
  documentSignatures: number;
  attendanceRecords: number;
  pendingApprovals: number;
  hasLogin: boolean;
  hasLiveStripeSubscription: boolean;
}

export interface DeletionBlock {
  code: string;
  message: string;
}

/**
 * Reasons to refuse outright. Deliberately short: archiving is reversible,
 * so almost nothing should block it. The exception is live Stripe billing —
 * archiving a member whose card is still being charged monthly would hide
 * them from every surface while the money kept moving.
 */
export function deletionBlocks(a: AttachedRecords): DeletionBlock[] {
  const blocks: DeletionBlock[] = [];
  if (a.hasLiveStripeSubscription) {
    blocks.push({
      code: "LIVE_STRIPE_SUBSCRIPTION",
      message:
        "This member has a live Stripe subscription. Cancel the membership first — archiving would " +
        "hide them from the roster while Stripe kept charging the card.",
    });
  }
  return blocks;
}

/**
 * Things the person confirming should be told, in the order they matter.
 * These are NOT blocks — they are the consequences of a reversible action.
 */
export function deletionWarnings(a: AttachedRecords): string[] {
  const out: string[] = [];
  if (a.activeSubscriptions > 0) {
    out.push(
      `${a.activeSubscriptions} active membership${a.activeSubscriptions === 1 ? "" : "s"} will stop counting them as a member.`,
    );
  }
  if (a.guardedByThisMember > 0) {
    out.push(
      `This person is a guardian for ${a.guardedByThisMember} other athlete${a.guardedByThisMember === 1 ? "" : "s"} — those athletes are not affected.`,
    );
  }
  if (a.pendingApprovals > 0) {
    out.push(
      `${a.pendingApprovals} pending approval${a.pendingApprovals === 1 ? "" : "s"} will be closed, so the queue stops showing a member who is gone.`,
    );
  }
  if (a.hasLogin) {
    out.push("Their portal login is disabled — they can no longer sign in.");
  }
  return out;
}

/** What is kept, stated positively so nobody assumes it's gone. */
export function deletionPreserved(a: AttachedRecords): string[] {
  const out: string[] = [];
  if (a.transactions > 0) {
    const one = a.transactions === 1;
    out.push(
      `${a.transactions} payment record${one ? "" : "s"} ${one ? "stays" : "stay"} on the books — revenue and tax reporting are unchanged.`,
    );
  }
  if (a.documentSignatures > 0) {
    const one = a.documentSignatures === 1;
    out.push(`${a.documentSignatures} signed document${one ? "" : "s"} ${one ? "stays" : "stay"} in the audit trail.`);
  }
  if (a.emailSends > 0) {
    const one = a.emailSends === 1;
    out.push(`${a.emailSends} email${one ? "" : "s"} ${one ? "stays" : "stay"} in the send history.`);
  }
  if (a.attendanceRecords > 0) {
    const one = a.attendanceRecords === 1;
    out.push(`${a.attendanceRecords} attendance record${one ? "" : "s"} ${one ? "stays" : "stay"} in reporting.`);
  }
  if (a.guardianLinks > 0) {
    const one = a.guardianLinks === 1;
    out.push(`${a.guardianLinks} guardian link${one ? "" : "s"} ${one ? "is" : "are"} kept so the family history is intact.`);
  }
  return out;
}

/** The exact sentence the actor must type. Names are what people recognise. */
export function confirmationPhrase(fullName: string): string {
  return fullName.trim();
}

export function confirmationMatches(typed: string, fullName: string): boolean {
  return typed.trim().toLowerCase() === confirmationPhrase(fullName).toLowerCase();
}
