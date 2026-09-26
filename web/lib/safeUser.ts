// Fields of a User row that are safe to send to a browser.
//
// B21 (2026-09-26): /api/staff returned whole User rows, including
// passwordHash and resetToken — the live setup/reset link token. With
// ?includeOwners=true any staff member with Staff & contractors: view could
// read an OWNER's reset token and take over the account. Every route that
// returns users to the client selects through this instead.
import type { Prisma } from "@prisma/client";

export const SAFE_USER_SELECT = {
  id: true,
  clubId: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  emailVerified: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

/** Never-send-to-client fields — scripts/staff-self-tests.ts asserts these stay out. */
export const SECRET_USER_FIELDS = ["passwordHash", "resetToken", "resetExpires"] as const;

/** Setup link sent and not used yet. Computed server-side so the token never leaves. */
export function invitePending(u: { resetToken?: string | null; lastLoginAt?: Date | null }): boolean {
  return !!u.resetToken && !u.lastLoginAt;
}
