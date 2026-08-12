#!/bin/sh
# Browser-test dev server for the bulk price change screens.
#
# Same discipline as scripts/dev-local.sh: points Next at the throwaway local
# Postgres, and blanks SMTP_HOST + RESEND_API_KEY so any send falls back to
# console logging in lib/email.ts — observable, and impossible to deliver.
#
# The one difference: NEXTAUTH_URL is `localhost`, matching the origin the
# post-login router actually redirects to. Running the server on 127.0.0.1
# while NextAuth redirects to localhost splits the cookie jar, and every
# navigation after sign-in bounces back to /login with no session.
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
