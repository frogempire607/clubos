// Human-facing descriptions of the §3F personalization tokens.
//
// The token list itself lives in lib/emailPersonalization.ts — that is the
// contract the interpolator honours. This file is only how a person chooses
// one, and it exists because "type {{member_first_name}} or any other token"
// asks the sender to remember fourteen exact strings.
//
// Pure: no prisma, no IO. Tested by scripts/personalization-catalog-tests.ts.

import { PERSONALIZATION_TOKENS, type PersonalizationToken } from "@/lib/emailPersonalization";

/**
 * Where a token's value comes from — which decides whether it resolves at all
 * on a given send.
 *
 *  RECIPIENT — read off the member being written to. Always available on a
 *              member send, though an individual row can still be blank
 *              (no membership, no guardian).
 *  CLUB      — read off the sending club. Always the same for everyone.
 *  CONTEXT   — supplied by the CALL SITE, not the composer. A bulk send from
 *              the Members tab supplies none, so these resolve to blank for
 *              every recipient. That is the trap this grouping exists to
 *              expose: they look available and silently produce nothing.
 */
export type TokenSource = "RECIPIENT" | "CLUB" | "CONTEXT";

export interface TokenInfo {
  token: PersonalizationToken;
  label: string;
  description: string;
  source: TokenSource;
}

export const TOKEN_CATALOG: TokenInfo[] = [
  {
    token: "member_first_name",
    label: "Member first name",
    description: "The first name of whoever this email is addressed to.",
    source: "RECIPIENT",
  },
  {
    token: "athlete_first_name",
    label: "Athlete first name",
    description:
      "The athlete the email is about. Same as the member for adults; the child's name when a guardian receives it.",
    source: "RECIPIENT",
  },
  {
    token: "guardian_first_name",
    label: "Guardian first name",
    description: "The athlete's primary guardian. Blank for adult members with no guardian.",
    source: "RECIPIENT",
  },
  {
    token: "membership_name",
    label: "Membership name",
    description: "The athlete's active membership plan. Blank if they don't hold one.",
    source: "RECIPIENT",
  },
  {
    token: "membership_end_date",
    label: "Membership end date",
    description: "When the athlete's membership runs out. Blank on open-ended memberships.",
    source: "RECIPIENT",
  },
  {
    token: "outstanding_balance",
    label: "Outstanding balance",
    description: "What the athlete currently owes across all sources.",
    source: "RECIPIENT",
  },
  {
    token: "migration_link",
    label: "Account setup link",
    description:
      "That member's personal activation link. Only resolves for members who are still being migrated.",
    source: "RECIPIENT",
  },
  {
    token: "club_name",
    label: "Club name",
    description: "Your club's name.",
    source: "CLUB",
  },
  {
    token: "club_contact_information",
    label: "Club contact info",
    description: "Your club's phone and email on one line.",
    source: "CLUB",
  },
  {
    token: "event_name",
    label: "Event name",
    description: "The event this send is about.",
    source: "CONTEXT",
  },
  {
    token: "class_name",
    label: "Class name",
    description: "The class this send is about.",
    source: "CONTEXT",
  },
  {
    token: "coach_name",
    label: "Coach name",
    description: "The coach this send is about.",
    source: "CONTEXT",
  },
  {
    token: "registration_link",
    label: "Registration link",
    description: "A registration URL supplied by the thing that triggered the email.",
    source: "CONTEXT",
  },
  {
    token: "payment_link",
    label: "Payment link",
    description: "A payment URL supplied by the thing that triggered the email.",
    source: "CONTEXT",
  },
];

export const SOURCE_LABEL: Record<TokenSource, string> = {
  RECIPIENT: "About the recipient",
  CLUB: "About your club",
  CONTEXT: "Not available in this send",
};

export const SOURCE_NOTE: Record<TokenSource, string | null> = {
  RECIPIENT: null,
  CLUB: null,
  CONTEXT:
    "These are filled in by automatic emails (an event confirmation, a payment reminder). " +
    "A send you compose here has nothing to fill them from, so they would come out blank.",
};

/** `{{token}}` — the exact text the interpolator matches. */
export function tokenSyntax(token: string): string {
  return `{{${token}}}`;
}

export function tokenInfo(token: string): TokenInfo | null {
  return TOKEN_CATALOG.find((t) => t.token === token) ?? null;
}

/** Catalog entries grouped for display, in the order a person should scan them. */
export function groupedTokens(): Array<{ source: TokenSource; tokens: TokenInfo[] }> {
  const order: TokenSource[] = ["RECIPIENT", "CLUB", "CONTEXT"];
  return order
    .map((source) => ({ source, tokens: TOKEN_CATALOG.filter((t) => t.source === source) }))
    .filter((g) => g.tokens.length > 0);
}

/**
 * Every token the interpolator knows must be describable, or the picker
 * silently hides one and the sender is back to guessing. Asserted by a test
 * rather than trusted.
 */
export function catalogCoversEveryToken(): { ok: boolean; missing: string[]; extra: string[] } {
  const known = new Set<string>(PERSONALIZATION_TOKENS as unknown as readonly string[]);
  const described = new Set(TOKEN_CATALOG.map((t) => t.token as string));
  return {
    ok: known.size === described.size && [...known].every((k) => described.has(k)),
    missing: [...known].filter((k) => !described.has(k)),
    extra: [...described].filter((d) => !known.has(d)),
  };
}
