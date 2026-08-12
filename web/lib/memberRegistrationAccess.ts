// Who, on the member side, may see and answer for a registration (§5.4.7).
//
// One implementation, because the answer has to be identical on the page that
// renders the proposal and on the two routes that act on it — a surface that
// shows something the route then refuses is how families end up on the phone.
//
// The rule: the registration's member is either the signed-in user's own member
// record, or one they are a CONFIRMED guardian of. A registration with no member
// at all (a public signup) has no member-portal owner and is never reachable
// here, even when the email happens to match — an address is not proof of who
// is standing behind it.

import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";

type Sess = { user?: { id?: string; clubId?: string } } | null;

export type AccessResult =
  | { ok: true; memberId: string }
  | { ok: false; status: number; error: string };

export async function assertCanRespondToRegistration(
  session: Sess,
  registrationId: string,
): Promise<AccessResult> {
  const userId = session?.user?.id;
  const clubId = session?.user?.clubId;
  if (!userId || !clubId) return { ok: false, status: 401, error: "Unauthorized" };

  const reg = await prisma.eventRegistration.findFirst({
    where: {
      id: registrationId,
      clubId,
      memberId: { not: null },
      member: {
        OR: [
          { userId },
          { guardianLinks: { some: { ...ACTIVE_GUARDIAN_LINK, userId } } },
        ],
      },
    },
    select: { memberId: true },
  });

  // Deliberately one message for "not yours" and "doesn't exist": telling a
  // stranger which registration ids are real is a small leak with no upside.
  if (!reg?.memberId) return { ok: false, status: 404, error: "Registration not available" };
  return { ok: true, memberId: reg.memberId };
}
