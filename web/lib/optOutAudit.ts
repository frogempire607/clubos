// Append-only preference-change log for EmailOptOut. plan §3I "keep an
// audit log of preference changes". Every route that mutates the
// email_opt_outs table calls writeOptOutAudit() so the historical
// state is always reconstructable.
//
// Never mutated — a change from MARKETING → ALL writes a new
// UNSUBSCRIBE row (scope=ALL). A resubscribe writes a SUBSCRIBE row
// (scope=MARKETING for a re-opt-in to marketing only, ALL for a full
// re-enable).

import { prisma } from "@/lib/prisma";

export type OptOutAction = "SUBSCRIBE" | "UNSUBSCRIBE";
export type OptOutScope = "MARKETING" | "TRANSACTIONAL" | "ALL";
export type OptOutSource =
  | "UNSUBSCRIBE_LINK"
  | "ADMIN"
  | "BOUNCE"
  | "COMPLAINT"
  | "IMPORT"
  | "API";
export type ActorRole = "OWNER" | "STAFF" | "MEMBER" | "PROVIDER" | "ANONYMOUS";

export interface OptOutAuditArgs {
  clubId: string;
  email: string;                    // lower-cased at write
  userId?: string | null;           // linked User (when known)
  scope: OptOutScope;
  action: OptOutAction;
  source: OptOutSource;
  actorUserId?: string | null;      // OWNER/STAFF acting, or null for
                                    // anonymous unsubscribe-link clicks
                                    // and provider bounce webhooks
  actorRole?: ActorRole | null;
  context?: Record<string, unknown> | null;  // IP, UA, provider msg id, note
}

export async function writeOptOutAudit(args: OptOutAuditArgs): Promise<void> {
  // Fire-and-forget-ish — audit failures never block the underlying
  // preference change, but they DO log so an operator can spot the
  // divergence. (An unreachable audit table is worse than a stale one.)
  try {
    await prisma.emailOptOutAudit.create({
      data: {
        clubId: args.clubId,
        email: args.email.trim().toLowerCase(),
        userId: args.userId ?? null,
        scope: args.scope,
        action: args.action,
        source: args.source,
        actorUserId: args.actorUserId ?? null,
        actorRole: args.actorRole ?? null,
        context: (args.context ?? undefined) as never,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[optOutAudit] failed to write audit row", {
      clubId: args.clubId,
      email: args.email,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Reads the timeline for a single address, newest first. Used by the
// admin surface + the profile Communications tab.
export async function readOptOutHistory(clubId: string, email: string, limit = 50) {
  return prisma.emailOptOutAudit.findMany({
    where: { clubId, email: email.trim().toLowerCase() },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
