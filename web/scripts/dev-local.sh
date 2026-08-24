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
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3000"
exec ./node_modules/.bin/next dev -H 127.0.0.1 -p 3000
