/**
 * Phase 6 §6B — permission boundaries, exercised rather than inspected.
 *
 *   npm run test:permission-behaviour
 *
 * `scripts/permission-boundary-guard.ts` proves a route CALLS a guard. It
 * cannot prove the guard says no. This calls the real exported route handlers
 * with a fabricated session and asserts the HTTP status that actually comes
 * back — so "Sal with finances:none gets a 403 on the expenses DELETE" is a
 * measured fact, not an inference from a grep.
 *
 * ── How it runs without a database or a login ───────────────────────────────
 *
 * Route handlers call `getServerSession(authOptions)` themselves, so the
 * session is injected by intercepting the module loader BEFORE the route is
 * required. `@/lib/prisma` is stubbed the same way, which does two jobs: it
 * lets `requirePermissionLive` read a permission blob we control, and it makes
 * any query past the guard throw. A test that reaches a real query is a test
 * whose guard did not fire, and it fails loudly instead of quietly talking to
 * a database.
 *
 * ── What an ALLOW case claims, and what it does not ────────────────────────
 *
 * 401 and 403 are the only statuses that mean "the guard stopped you". An
 * ALLOW case asserts only that neither came back — the request reached the
 * handler's own logic, where it then hits a validation 400 on this file's empty
 * body or the stubbed database. Asserting a success code instead would be
 * asserting business logic, which belongs in that feature's own tests.
 *
 * The asymmetry is deliberate. A wrongly-allowed request is caught by the DENY
 * cases, which are exact. A wrongly-denied one is caught here.
 */
import Module from "node:module";

// ── The permission fixtures ────────────────────────────────────────────────
//
// SAL is the real staff profile that prompted this: everything he needs to
// coach and run the front desk, and explicitly NOT finances.
const SAL_PERMISSIONS = {
  billing: "full",
  members: "full", events: "full", attendance: "full", classes: "full",
  documents: "full", messages: "full", staff: "full",
  schedule: "edit",
  reports: "view", finances: "view",
};
// The same person after an owner narrows finances to none.
const SAL_NO_FINANCES = { ...SAL_PERMISSIONS, finances: "none" };
// A coach with the shipped defaults for a fresh invite.
const COACH_DEFAULTS = {
  members: "view", attendance: "full", classes: "view", events: "view",
  schedule: "view", messages: "send", documents: "view",
  finances: "none", billing: "none", reports: "none", staff: "none",
};

type Sess = {
  user: { id: string; role: string; clubId: string; permissions: Record<string, unknown> | null };
} | null;

let CURRENT: Sess = null;
let LIVE_PERMS: Record<string, unknown> | null = null;

class GuardReachedDatabase extends Error {}

const prismaStub: unknown = new Proxy(
  {},
  {
    get(_t, model: string) {
      if (model === "staffProfile") {
        // What requirePermissionLive re-reads. This is the whole point of the
        // "live" variant: a permission revoked five minutes ago must apply
        // without the staff member signing in again.
        return { findUnique: async () => ({ permissions: LIVE_PERMS }) };
      }
      if (model === "then" || model === "$disconnect") return undefined;
      return new Proxy(
        {},
        {
          get() {
            return async () => {
              throw new GuardReachedDatabase(`query on prisma.${model} — the guard did not stop this`);
            };
          },
        },
      );
    },
  },
);

// Intercept before any route is loaded.
const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: unknown })._load = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === "next-auth") {
    return { getServerSession: async () => CURRENT, default: {} };
  }
  if (request === "@/lib/prisma" || request.endsWith("/lib/prisma")) {
    return { prisma: prismaStub, default: prismaStub };
  }
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) {
    return { authOptions: {} };
  }
  return (origLoad as (...a: unknown[]) => unknown).call(this, request, ...rest);
} as never;

// ── Harness ────────────────────────────────────────────────────────────────
let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const req = (body: unknown = {}) =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Call a route handler and report what the caller would actually receive.
 *
 * 401 and 403 are the only statuses that mean "the guard stopped you". Anything
 * else — including the 400 a zod validator returns for this test's empty body,
 * and the throw from the stubbed database — means the guard let the request
 * through, which is all an ALLOW case is claiming. Asserting a specific success
 * code would be asserting the handler's business logic, which is not what this
 * file is for.
 */
type Outcome = { status: number | null; blocked: boolean };

async function call(
  modulePath: string,
  verb: "POST" | "PATCH" | "PUT" | "DELETE",
  session: Sess,
  livePerms: Record<string, unknown> | null,
  params: Record<string, string> = {},
): Promise<Outcome> {
  CURRENT = session;
  LIVE_PERMS = livePerms;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(modulePath) as Record<string, (r: Request, c?: unknown) => Promise<Response>>;
  const handler = mod[verb];
  if (!handler) throw new Error(`${modulePath} has no ${verb}`);
  try {
    const res = await handler(req(), { params: Promise.resolve(params) });
    return { status: res.status, blocked: res.status === 401 || res.status === 403 };
  } catch {
    // Reached the stubbed database, or threw parsing the body. Either way the
    // guard did not stop it.
    return { status: null, blocked: false };
  }
}

const denied = (o: Outcome, code: 401 | 403) => o.status === code;
const allowed = (o: Outcome) => !o.blocked;

/**
 * A FRESH user id per call. `lib/apiGuard` memoises live permission lookups per
 * userId for a TTL, so reusing one id would serve the first fixture's
 * permissions to every later assertion — which is exactly how the first run of
 * this file produced six false failures.
 */
let seq = 0;
const staff = (perms: Record<string, unknown>): Sess => ({
  user: { id: `u_sal_${++seq}`, role: "STAFF", clubId: "club_1", permissions: perms },
});
const owner: Sess = { user: { id: "u_owner", role: "OWNER", clubId: "club_1", permissions: null } };
const member: Sess = { user: { id: "u_kid", role: "MEMBER", clubId: "club_1", permissions: null } };

const EXPENSES = require.resolve("../app/api/expenses/[id]/route.ts");
const PRODUCTS = require.resolve("../app/api/products/route.ts");
const RELATIONSHIPS = require.resolve("../app/api/members/[id]/relationships/route.ts");
const DOCUMENTS = require.resolve("../app/api/documents/route.ts");
const MEMBERS = require.resolve("../app/api/members/route.ts");
const ANNOUNCEMENTS = require.resolve("../app/api/announcements/route.ts");
const ANNOUNCE_SEND = require.resolve("../app/api/announcements/[id]/send/route.ts");

async function main() {
  console.log("\nPERMISSION BEHAVIOUR — real handlers, real status codes\n");

  // ── The one that started this ────────────────────────────────────────────
  console.log("expenses/[id] DELETE — finances:full, checked LIVE");
  check(
    "Sal with finances:none gets 403",
    denied(await call(EXPENSES, "DELETE", staff(SAL_NO_FINANCES), SAL_NO_FINANCES, { id: "e1" }), 403),
  );
  check(
    "a coach on the shipped defaults (finances:none) gets 403",
    denied(await call(EXPENSES, "DELETE", staff(COACH_DEFAULTS), COACH_DEFAULTS, { id: "e1" }), 403),
  );
  check(
    "finances:view is NOT enough to delete — 403",
    denied(await call(EXPENSES, "DELETE", staff(SAL_PERMISSIONS), SAL_PERMISSIONS, { id: "e1" }), 403),
  );
  check(
    "finances:full is let through",
    allowed(await call(EXPENSES, "DELETE", staff({ ...SAL_PERMISSIONS, finances: "full" }),
      { ...SAL_PERMISSIONS, finances: "full" }, { id: "e1" })),
  );
  check(
    "the OWNER is never blocked",
    allowed(await call(EXPENSES, "DELETE", owner, null, { id: "e1" })),
  );
  check(
    "a MEMBER cannot reach a dashboard route at all — 403",
    denied(await call(EXPENSES, "DELETE", member, null, { id: "e1" }), 403),
  );
  check(
    "no session — 401, not 403",
    denied(await call(EXPENSES, "DELETE", null, null, { id: "e1" }), 401),
  );

  // requirePermissionLive's whole reason to exist: the token is stale, the
  // database is not. A permission revoked after Sal signed in must bite now.
  console.log("\nexpenses/[id] DELETE — revocation applies without re-login");
  check(
    "token still says finances:full, live row says none → 403",
    denied(await call(EXPENSES, "DELETE", staff({ ...SAL_PERMISSIONS, finances: "full" }), SAL_NO_FINANCES, { id: "e1" }), 403),
  );
  check(
    "token says none, live row says full → allowed (a grant applies too)",
    allowed(await call(EXPENSES, "DELETE", staff(SAL_NO_FINANCES), { ...SAL_PERMISSIONS, finances: "full" }, { id: "e1" })),
  );

  // ── The rest of the mapping applied on 2026-09-04 ────────────────────────
  console.log("\nthe other newly-gated routes");
  check("products POST refuses finances:none",
    denied(await call(PRODUCTS, "POST", staff(COACH_DEFAULTS), COACH_DEFAULTS), 403));
  check("products POST allows finances:edit",
    allowed(await call(PRODUCTS, "POST", staff({ ...COACH_DEFAULTS, finances: "edit" }), null)));

  check("relationships POST refuses members:view",
    denied(await call(RELATIONSHIPS, "POST", staff(COACH_DEFAULTS), COACH_DEFAULTS, { id: "m1" }), 403));
  check("relationships DELETE refuses members:view",
    denied(await call(RELATIONSHIPS, "DELETE", staff(COACH_DEFAULTS), COACH_DEFAULTS, { id: "m1" }), 403));
  check("relationships POST allows members:edit",
    allowed(await call(RELATIONSHIPS, "POST", staff({ ...COACH_DEFAULTS, members: "edit" }), null, { id: "m1" })));

  check("documents POST refuses documents:view",
    denied(await call(DOCUMENTS, "POST", staff(COACH_DEFAULTS), COACH_DEFAULTS), 403));
  check("documents POST allows documents:edit",
    allowed(await call(DOCUMENTS, "POST", staff({ ...COACH_DEFAULTS, documents: "edit" }), null)));

  check("members POST refuses members:view",
    denied(await call(MEMBERS, "POST", staff(COACH_DEFAULTS), COACH_DEFAULTS), 403));
  check("members POST allows members:edit",
    allowed(await call(MEMBERS, "POST", staff({ ...COACH_DEFAULTS, members: "edit" }), null)));

  // The owner's 2026-09-04 ruling: a broadcast is not a DM. messages:send is
  // deliberately NOT enough — including on the send route, which a staffer who
  // cannot write an announcement could otherwise still fire.
  console.log("\nannouncements — broadcast needs messages:full, not messages:send");
  const SEND_LEVEL = { ...COACH_DEFAULTS, messages: "send" };
  check("create refuses messages:send",
    denied(await call(ANNOUNCEMENTS, "POST", staff(SEND_LEVEL), SEND_LEVEL), 403));
  check("create allows messages:full",
    allowed(await call(ANNOUNCEMENTS, "POST", staff({ ...COACH_DEFAULTS, messages: "full" }), null)));
  check("SEND refuses messages:send even with the bulk sub-scope",
    denied(await call(ANNOUNCE_SEND, "POST",
      staff({ ...SEND_LEVEL, messages_subScopes: { bulk: true } }), null, { id: "a1" }), 403));
  check("SEND allows messages:full with the bulk sub-scope",
    allowed(await call(ANNOUNCE_SEND, "POST",
      staff({ ...COACH_DEFAULTS, messages: "full", messages_subScopes: { bulk: true } }), null, { id: "a1" })));
  check("SEND still refuses messages:full WITHOUT the bulk sub-scope",
    denied(await call(ANNOUNCE_SEND, "POST",
      staff({ ...COACH_DEFAULTS, messages: "full", messages_subScopes: { bulk: false } }), null, { id: "a1" }), 403));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
