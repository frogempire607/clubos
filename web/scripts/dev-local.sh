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
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3000"
exec ./node_modules/.bin/next dev -H 127.0.0.1 -p 3000
