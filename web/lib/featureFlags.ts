// Server-side feature flags. Keep these boring: env-var switches read at
// request time so a Netlify env change flips the feature without a code
// deploy. Client code never reads these directly — gated APIs return
// `enabled: false` and the UI hides itself.

/** Invoice splitting (Client UX Phase 7). Set FEATURE_INVOICE_SPLIT=1 to enable. */
export function invoiceSplitEnabled(): boolean {
  return process.env.FEATURE_INVOICE_SPLIT === "1";
}
