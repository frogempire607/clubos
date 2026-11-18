// What a person is told when Google / Apple sign-in doesn't work out. Plain
// words for each short code the sign-in routes put on the login page or hand
// back to the app. No imports, so pages can use it too.

export const SOCIAL_ERROR_TEXT: Record<string, string> = {
  not_configured: "That sign-in option isn't available yet. Use your email and password.",
  club: "We couldn't find that club. Check the club code and try again.",
  cancelled: "Sign-in was cancelled.",
  state: "That sign-in attempt expired. Please try again.",
  provider: "We couldn't confirm that sign-in. Please try again, or use your email and password.",
  consent: "A parent or guardian must complete consent before this account can be used.",
  taken: "That Google or Apple account is already connected to a different login at this club.",
  removed: "That login is no longer active. Use your email and password, or ask the club.",
  rate: "Too many attempts. Wait a few minutes and try again.",
};

/** The sentence for a code; a sentence passes through; anything else gets the general one. */
export function socialErrorText(code: string | null | undefined): string {
  if (!code) return SOCIAL_ERROR_TEXT.provider;
  if (SOCIAL_ERROR_TEXT[code]) return SOCIAL_ERROR_TEXT[code];
  return /\s/.test(code) ? code : SOCIAL_ERROR_TEXT.provider;
}
