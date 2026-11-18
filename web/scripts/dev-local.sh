#!/bin/sh
# Local browser-testing dev server. Points Next at the throwaway local Postgres
# from scripts/seed-local-browser-test.ts instead of the production connection
# string in .env, so clicking around cannot touch a real club.
#
# Deliberately NOT a change to .env / .env.local — both are symlinks into the
# main checkout, and editing them would reconfigure the main checkout too.
cd "$(dirname "$0")/.." || exit 1
export LC_ALL=C
export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/clubos"
export DIRECT_URL="postgresql://postgres@127.0.0.1:55432/clubos"
export NEXTAUTH_URL="http://127.0.0.1:3000"
# Local-only, throwaway. Lets the Resend webhook be exercised end to end
# against a signed payload instead of read off the switch statement.
export RESEND_WEBHOOK_SECRET="whsec_bG9jYWx0ZXN0c2VjcmV0Zm9ycHJvYmluZzEyMw=="
# The worktree's .env carries REAL SMTP credentials, so a local test that
# triggers a send would try to mail an actual provider. Blanking SMTP_HOST makes
# lib/email.ts fall back to console logging — sends stay observable and become
# impossible to deliver. Never remove this from the local dev script.
export SMTP_HOST=""
export RESEND_API_KEY=""
# Same reasoning as SMTP, for the same reason: the worktree's .env carries a
# REAL Stripe key, and a local click that reaches a charge path would talk to
# the live account. Blanking it makes every Stripe call fail loudly here instead
# of succeeding somewhere real. Never remove this from the local dev script.
export STRIPE_SECRET_KEY=""
export STRIPE_WEBHOOK_SECRET=""
export STRIPE_CONNECT_WEBHOOK_SECRET=""
# Push notifications, for the same reason again: with the APNs key or the
# Firebase service account loaded, a local click that creates an approval or
# sends a message would put a real notification on a real family's phone.
# Blank, lib/pushServer.ts treats both platforms as not configured and every
# send is a no-op before its first query. Never remove this from the local dev
# script.
export APNS_KEY_ID=""
export APNS_PRIVATE_KEY=""
export FIREBASE_SERVICE_ACCOUNT_JSON=""
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3000"
# ── 2026-11-18: the credentials this list had still missed ───────────────────
# A SECOND production database address. lib/tenantPrisma.ts opens its own
# connection from APP_DATABASE_URL (the RLS role), used by the document
# signatures list and the ledger. It was never pointed anywhere local, so a
# local click on "Signatures" dialled the production pooler. Found by the crash
# audit's crawl: two attempts, both refused at sign-in by the pooler, so no
# query ran — luck again, not a property of this script.
export APP_DATABASE_URL="postgresql://postgres@127.0.0.1:55432/clubos"
# Plaid: with the real client id and secret loaded, "Connect bank" asks the
# real Plaid API for a link token. Blank, lib/plaid treats it as not set up.
export PLAID_CLIENT_ID=""
export PLAID_SECRET=""
# Supabase Storage: blank, lib/storage.ts writes uploads to local disk instead
# of the production bucket.
export SUPABASE_URL=""
export SUPABASE_SERVICE_ROLE_KEY=""
# Nothing local reports errors to, or is callable as, production.
export SENTRY_DSN=""
export NEXT_PUBLIC_SENTRY_DSN=""
export CRON_SECRET=""
# A local sign-in secret, so this works in a worktree with no .env and so the
# production secret is never what signs a local session.
export NEXTAUTH_SECRET="${LOCAL_NEXTAUTH_SECRET:-local-only-not-a-secret-0123456789abcdef}"

# ── DEFAULT-DENY: everything else a library would load for us ────────────────
# Why a list was never going to be enough: there does not have to be a .env in
# THIS folder. @prisma/client reads the .env beside the node_modules it was
# installed into — in a worktree, the MAIN checkout's — the moment it is
# imported, and fills in every variable not already set. Next does the same
# with the .env files here. So any name this script does not mention arrives
# with its production value. Three times now (SMTP 2026-08-17, Stripe
# 2026-08-24, the second database address 2026-11-18) the gap was a name
# nobody had thought to list.
#
# So: every name defined in any of those files that this script has NOT set
# above is exported blank. A new integration is off locally until someone
# deliberately gives it a local value here. `sh scripts/dev-local.sh env`
# prints what the server will see (names only), and
# scripts/dev-local-env-tests.ts runs that on every build.
MAIN_ROOT=$(node -e 'try{console.log(require("path").resolve(require.resolve("@prisma/client/package.json"),"../../../.."))}catch(e){}' 2>/dev/null)
for f in .env .env.local .env.development .env.development.local .env.production .env.production.local prisma/.env \
         "$MAIN_ROOT/.env" "$MAIN_ROOT/.env.local" "$MAIN_ROOT/.env.development" "$MAIN_ROOT/.env.development.local" \
         "$MAIN_ROOT/.env.production" "$MAIN_ROOT/.env.production.local" "$MAIN_ROOT/prisma/.env"; do
  [ -f "$f" ] || continue
  for k in $(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p' "$f"); do
    eval "already=\${$k+x}"
    if [ -z "$already" ]; then
      export "$k="
      echo "dev-local: $k is defined in an env file and has no local value here — blanked"
    fi
  done
done

# `sh scripts/dev-local.sh env [NAME…]` — what the server would see, by NAME
# only: blank, local (an address on this machine), or SET. Values are never
# printed. Loads the database client first, exactly as the server does, so
# anything it would pull in is in the picture.
if [ "$1" = "env" ]; then
  shift
  exec node -e '
    try { require("@prisma/client"); } catch (e) {}
    const names = process.argv.slice(1);
    for (const k of names.length ? names : Object.keys(process.env).sort()) {
      const v = process.env[k];
      const kind = v === undefined || v === "" ? "blank" : /^[a-z]+:\/\/([^@\/]*@)?(127\.0\.0\.1|localhost)([:\/?]|$)/.test(v) ? "local" : "SET";
      console.log(k + "=" + kind);
    }' "$@"
fi

NEXT="npx --no-install next"
if [ -x ./node_modules/.bin/next ]; then
  NEXT=./node_modules/.bin/next
fi
# `sh scripts/dev-local.sh built` — the SAME environment (every blank above
# still applies, still 127.0.0.1 only), but a production build instead of the
# dev compiler. For crawls that open every page (scripts/browser-crash-audit.ts):
# the dev server took about three minutes a page and hot-reloads under the
# crawl whenever a file is saved. Not a second way to configure a server — it
# exists so nobody needs one.
if [ "$1" = "built" ]; then
  $NEXT build || exit 1
  exec $NEXT start -H 127.0.0.1 -p 3000
fi
exec $NEXT dev -H 127.0.0.1 -p 3000
