// PendingApproval.kind for a client-requested membership transfer.
//
// Lives in its own module (rather than in the route that files it) so the
// approvals aggregator and the action route can both import it without
// pulling a route handler — and its Node-only dependencies — into their
// bundles. Same reason MEMBERSHIP_CANCEL_KIND lives in lib/approvals.ts.
export const MEMBERSHIP_TRANSFER_KIND = "MEMBERSHIP_TRANSFER" as const;
