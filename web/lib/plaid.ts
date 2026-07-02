import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

// Normalize so a stray capitalization ("Production") or trailing space in the
// Netlify env var doesn't silently produce an undefined basePath — which makes
// every Plaid call fail with a confusing error. Plaid's env keys are lowercase:
// sandbox | development | production.
const rawEnv = (process.env.PLAID_ENV || "sandbox").trim().toLowerCase();
export const PLAID_ENV = rawEnv in PlaidEnvironments ? rawEnv : "sandbox";

const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV as keyof typeof PlaidEnvironments],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
    },
  },
});

export const plaidClient = new PlaidApi(config);
