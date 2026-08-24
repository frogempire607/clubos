# AthletixOS — Repo Root Context

The full, current project context lives in **`web/CLAUDE.md`** — read it before touching members, activation, billing, guardian/minor flows, uploads, or DB migrations. This file captures only the repo-level basics.

## Layout

- Next.js 14 (App Router) app lives in `web/`.
- API routes: `web/app/api/**`. Pages: `web/app/**`. Prisma schema: `web/prisma/schema.prisma`. Shared code: `web/lib/**`. Components: `web/components/**`.
- Git lives at this repo root; build/verify from `web/`.

## Verify loop (every batch)

```
cd web && npx tsc --noEmit && npm run build
```

`web/tsconfig.json` has `"incremental": true`. If tsc looks suspiciously clean right after edits, delete `web/*.tsbuildinfo` and re-run — a stale incremental cache has produced false "clean" results before. `npm run build` is the real gate.

## Deploy pipeline

Push to GitHub `main` → Netlify auto-builds & deploys. You don't deploy directly, you push. The iOS app is a Capacitor wrapper that loads the live URL, so no `cap:sync` is needed for web changes.

## Database

Postgres on Supabase. Apply migrations with `npx prisma migrate deploy` (**not** `migrate dev` — the shadow DB is blocked by the pooler) and run it **before** pushing code that references new columns. Hand-write migration SQL folders. Add migrations only if truly needed, and explain them.

## Guardrails

Do **not**: rename core models, break onboarding links, break Stripe checkout, break active-membership detection, break role permissions, or remove existing data. Safe migrations only, explained before/after.

Two gotchas that already bit us:

1. When you replace an inline auth check with `requirePermission(session, …)`, TypeScript loses `session` null-narrowing → the build fails with "'session' is possibly null." Add an explicit `if (!session) return 401;` before the guard.
2. Permission model: `StaffProfile.permissions` is a JSON blob. Keys: `members, attendance, classes, events, schedule, messages, documents, finances, reports, staff`. Levels: `none, view, send, edit, full`. **OWNER bypasses everything.** Guard server-side with `requirePermission` (`web/lib/apiGuard.ts`) or `hasPermission` (`web/lib/permissions.ts`). **Privates are gated under the `events` key**, not a "privates" key.

## Database safety — non-negotiable

- NEVER pass a production connection string to `--shadow-database-url`. Prisma
  drops and recreates shadow databases by design. This wiped production on
  2026-07-29 (recovered from a pg_dump taken minutes earlier).
- NEVER run `prisma migrate reset` or `prisma db push --accept-data-loss`
  against production.
- Before any session that touches migrations, take a backup:
  `export PATH="$(brew --prefix postgresql@17)/bin:$PATH"`
  `pg_dump "<session pooler URI>" --no-owner --no-privileges -f ~/clubos-backups/pre-$(date +%Y%m%d-%H%M).sql`
- Supabase server is Postgres 17.6 — local pg_dump/psql must be 17+.
- The direct DB host does not resolve on this network. Use the session pooler
  (port 5432) for psql/pg_dump/migrate, transaction pooler (6543,
  `?pgbouncer=true`) for the app.
- Julian runs all database commands from his own terminal. The Claude Code
  sandbox cannot reach the database.

### Local dev servers — kill strays by CONNECTION, never by port

**`npm run dev` in a worktree starts a server pointed at production, on
`0.0.0.0`.** It reaches production two different ways, which is why you cannot
check for one of them:

- in **some** worktrees `web/.env` / `web/.env.local` are **symlinks into the
  main checkout**;
- in **others** the worktree has its own regular `.env` that carries the
  production `DATABASE_URL` anyway (verified 2026-08-22 in
  `web/.claude/worktrees/elastic-wilson-411ecb`, which has a real file, no
  `.env.local` at all, and the production pooler host).

So **"is it a symlink?" is NOT a valid check** — a "no" proves nothing, and
reading the file to reassure yourself is the wrong move regardless. The only
safe local server is `scripts/dev-local.sh`. **Verification is by connection,
always** — see the commands below.

#### The database is only one of the credentials

Pointing `DATABASE_URL` at the throwaway Postgres is the *first* thing
`dev-local.sh` does, not the only thing. The worktree `.env` also carries live
credentials for every outbound system, and each one is reachable from a local
click. The script blanks all of them, and **every entry below is load-bearing —
never remove one, and never hand-roll a partial override in its place**:

| Blanked | What a local click would otherwise do | How it fails once blanked |
|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` → `127.0.0.1:55432` | Read and write **real member rows** | Talks to the throwaway Postgres |
| `SMTP_HOST` | Deliver real mail to real families | `lib/email.ts` logs to console |
| `RESEND_API_KEY` | Same, via Resend | Falls back to the SMTP path, i.e. console |
| `STRIPE_SECRET_KEY` | **Charge a real card, cancel a real subscription, create a real Stripe object on the club's connected account** | Every Stripe call throws, loudly and locally |
| `STRIPE_WEBHOOK_SECRET` / `STRIPE_CONNECT_WEBHOOK_SECRET` | Verify and act on real webhook payloads replayed locally | Signature verification fails |

It also binds `127.0.0.1` (not `0.0.0.0`) and sets `NEXTAUTH_URL` to match.

**Blanking is not belt-and-braces — it is the only thing standing between a
local click and a real side effect, and twice now "nothing happened" has been
luck rather than a property of the setup:**

- **2026-08-17** — three local servers ran with a hand-rolled `DATABASE_URL`
  override instead of this script. The database was correctly the local
  throwaway, but **real SMTP credentials stayed loaded the whole time** and one
  server bound `0.0.0.0`. Nothing was sent because the screens being driven
  happened not to send.
- **2026-08-24** — `dev-local.sh` itself was found to blank SMTP and Resend but
  **not `STRIPE_SECRET_KEY`**, while §8.6 autopay work was being browser-tested.
  Autopay ON creates a Stripe subscription and OFF cancels one. Nothing reached
  Stripe only because the seeded local club has no `stripeAccountId`, so every
  guard fired before the API call. That is the club fixture saving it, not the
  test setup. Fixed the same day.

The pattern in both: the *database* was handled, a *different* credential was
not, and the escape was a property of the data rather than of the configuration.
When adding any new outbound integration, add its key to `dev-local.sh` and to
this table in the same commit.

On 2026-08-21 a prod-pointed `npm run dev` was killed, the port was verified
free, and a prod-pointed server was later found listening again — while a bulk
email composer aimed at 293 real families was open in the browser. Nothing
restarts it automatically (checked: no launchd agent, no cron, no
pm2/forever/nodemon, no `launch.json` with restart semantics). The likely source
was a **second Claude session running concurrently** — several usually are.

So before starting any dev server, and before trusting that one is gone:

- **Check by connection, not by port.** `lsof -ti tcp:3000` returning nothing
  proves only that nothing holds *that* port *this instant*. Two servers can
  share port 3000 (one bound `127.0.0.1`, one bound `*`), and the one you did
  not start may be the one answering. The question that matters is *what is
  this process connected to*:

  ```sh
  # every server, and the database each one is actually talking to
  for p in $(pgrep -f "next-server|next dev"); do
    ps -o command= -p $p | cut -c1-90
    lsof -p $p -i -n -P | grep ESTABLISHED | grep -E ":5432|:6543|:55432"
  done

  # the one-line check that must come back empty
  lsof -nP -i | grep -iE "supabase|:6543|:5432" | grep -v 55432
  ```

- **Kill by command line, then verify by connection.** `pkill -f "next dev"`,
  then re-run the check above. "Port free" is not the finish line.
- **Never point a browser at a prod-connected dev server** to test a screen that
  can send email, charge a card, or write member rows. "I will not click Send"
  is not a safety property.

### Branch policy — one branch per PHASE, never one per session

**Work on `main`, or on a single long-lived branch for the phase you are in.
Do NOT create a new branch or a new worktree for each session.**

This is not a style preference. On 2026-08-11 two branches — one per session —
had independently built the same Session D work (D-1 through D-4 and the three
dead profile tabs) against the same brief. Merging them produced six conflicts
in files where *both sides were correct*, and resolving it meant reading two
good implementations of every fix and choosing between them line by line. Some
of that work was simply thrown away. The duplicated effort cost more than the
conflicts did.

Concretely:

- **Continue the existing phase branch.** `git log --oneline -5` and
  `git branch -a` first; if a branch for this phase exists, check it out and
  keep going. Its name is in `docs/improvement/PROGRESS.md`'s latest session
  entry.
- **Only start a new branch when a new PHASE starts**, and say so explicitly.
- **Merge to `main` at the end of a phase, not later.** Two branches that both
  sit unmerged for days is the setup that caused this.
- **Prefer the main checkout** (`/Users/cubano/Desktop/clubos`). A worktree is
  for genuinely parallel work, not for tidiness — and its per-worktree `.env`,
  `node_modules` and migration state are a recurring source of "it works here
  but not there".
- If you do end up in a worktree, still state the path and branch up front, as
  below.

**Before writing any code, say which branch you are on and why it is the right
one.** If the answer is "I made a new one for this session", that is the wrong
answer.

### Say which checkout you're working in — up front

Sessions often run in a **git worktree**, not the main checkout. Migrations,
`.env`, and `node_modules` are per-worktree, so "I applied the migration" and
"the migration isn't there" can both be true at once — that exact confusion cost
a round-trip on 2026-08-02.

**In the first message of any session that writes a migration or a script Julian
will run, state the absolute path and branch**, e.g.:

> Working in `web/.claude/worktrees/nifty-pasteur-1ecb47` on branch
> `claude/phase-4-account-bugs-5a03fa`. Apply from there:
> `cd <that path>/web && npx prisma migrate deploy`

Also: **`M<n>` numbers in `docs/improvement/PROGRESS.md` are a planning
inventory, not identifiers.** Several are reserved for unbuilt work and have
been renumbered before. Always name the migration by its **folder**
(`20260803000000_family_accounts`) when asking for it to be applied.

### Supabase MCP is READ-ONLY

The Supabase MCP connects directly to **production**. Unless Julian explicitly
says otherwise **in that session**, it is for `SELECT` only.

- **No DDL of any kind.** No `CREATE`/`DROP`/`ALTER` on tables, indexes, types,
  functions, or policies.
- **No `CREATE EXTENSION` / `DROP EXTENSION`.** If a query needs an extension
  that isn't installed, write the logic in TypeScript instead. (This rule
  exists because a session created `fuzzystrmatch` to use `levenshtein()`
  during a read-only diagnosis on 2026-08-02. It was dropped immediately and
  nothing was harmed, but it should never have been run.)
- **No writes.** No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `UPSERT`, or
  `apply_migration`.
- **Data corrections never go through MCP.** They go in a script that is
  **dry-run by default**, requires an explicit allowlist to act, and that
  **Julian runs from his own terminal** — e.g. `scripts/fix-family-links.ts`,
  `scripts/fix-status-truth.ts`.
- Reading production to diagnose real records is encouraged — that is what the
  MCP is for. Anything that changes state is Julian's to run.
