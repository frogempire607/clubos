#!/bin/sh
# Browser-test dev server for the Phase 5 tournament workflow.
#
# Same discipline as scripts/dev-browser-test.sh — throwaway local Postgres,
# SMTP and Resend blanked so any send falls back to console logging — plus one
# addition that matters more here than anywhere else:
#
#   STRIPE_SECRET_KEY is replaced with a dummy.
#
# Approving an APPROVAL_CHARGE registration calls the real charge engine. The
# worktree .env carries a LIVE key and the club's real connected account id, so
# without this line a click in a local browser test could move real money on a
# real family's card. A dummy key makes that impossible: the call fails loudly
# instead of succeeding quietly.
cd "$(dirname "$0")/.." || exit 1
export LC_ALL=C
export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/clubos"
export DIRECT_URL="postgresql://postgres@127.0.0.1:55432/clubos"
export NEXTAUTH_URL="http://localhost:3000"
export NEXTAUTH_SECRET="localtestsecretlocaltestsecret123456"
export NEXT_PUBLIC_APP_URL="http://localhost:3000"
export SMTP_HOST=""
export RESEND_API_KEY=""
export STRIPE_SECRET_KEY="sk_test_LOCAL_DUMMY_NEVER_VALID"
export STRIPE_WEBHOOK_SECRET=""
# node_modules lives in the main checkout, not the worktree (the worktree has
# no install of its own) — resolve next through npx so this works from either.
exec npx next dev -H 127.0.0.1 -p 3000
