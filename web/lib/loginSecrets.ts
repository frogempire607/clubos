// Fields of a User row that must never be sent to a browser. PURE.
//
// A route that reads a user with `include` gets every column, and handing that
// object to NextResponse.json sends all of them. /api/member/portal did
// exactly that until 2026-11-16: every member's own password hash and any
// live password-reset token rode along in the payload of every portal page.

export const LOGIN_SECRET_FIELDS = ["passwordHash", "resetToken", "resetExpires"] as const;

/** A shallow copy without the login secrets. Other fields are untouched. */
export function withoutLoginSecrets<T extends object>(user: T): Omit<T, (typeof LOGIN_SECRET_FIELDS)[number]> {
  const copy = { ...user } as Record<string, unknown>;
  for (const f of LOGIN_SECRET_FIELDS) delete copy[f];
  return copy as Omit<T, (typeof LOGIN_SECRET_FIELDS)[number]>;
}
