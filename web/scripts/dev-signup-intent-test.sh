#!/bin/sh
# Browser-test dev server for the Phase 7.2/7.3 signup-intent screens.
# Same discipline as scripts/dev-browser-test.sh: throwaway local Postgres,
# and SMTP_HOST + RESEND_API_KEY blanked so any send falls back to console
# logging in lib/email.ts — observable, and impossible to deliver.
cd "$(dirname "$0")/.." || exit 1
export LC_ALL=C
export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/clubos"
export DIRECT_URL="postgresql://postgres@127.0.0.1:55432/clubos"
export NEXTAUTH_URL="http://localhost:3000"
export NEXTAUTH_SECRET="localtestsecretlocaltestsecret123456"
export NEXT_PUBLIC_APP_URL="http://localhost:3000"
export SMTP_HOST=""
export RESEND_API_KEY=""
exec ./node_modules/.bin/next dev -H 127.0.0.1 -p 3000
