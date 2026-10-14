// Server checks for an event audience (lib/eventAudience.ts).
import { prisma } from "@/lib/prisma";
import type { EventAudience } from "@/lib/eventAudience";

/** Every membership named must be one of this club's plans. */
export async function audienceMembershipProblem(clubId: string, aud: EventAudience): Promise<string | null> {
  const ids = aud.membershipIds ?? [];
  if (!ids.length) return null;
  const found = await prisma.membership.count({ where: { clubId, id: { in: ids } } });
  return found === new Set(ids).size ? null : "One of the memberships chosen isn't one of this club's plans.";
}
