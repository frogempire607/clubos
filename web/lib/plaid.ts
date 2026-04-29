import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const env = process.env.PLAID_ENV || "sandbox";

const config = new Configuration({
  basePath: PlaidEnvironments[env as keyof typeof PlaidEnvironments],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
    },
  },
});

export const plaidClient = new PlaidApi(config);
