// Shared constants + labels for the unified payout ledger (P2). Single source
// of truth for the API validation and the dashboard UI.

export const PAYEE_TYPES = ["STAFF", "GUEST", "CONTRACTOR", "EVENT_WORKER"] as const;
export type PayeeType = (typeof PAYEE_TYPES)[number];

export const PAYOUT_KINDS = [
  "PAYROLL",
  "CLINIC",
  "CAMP",
  "TOURNAMENT",
  "GUEST",
  "CONTRACTOR",
  "EVENT",
  "OTHER",
] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];

export const PAYOUT_STATUSES = ["PENDING", "PAID", "VOID"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_METHODS = ["CASH", "CHECK", "TRANSFER", "OTHER"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYEE_TYPE_LABELS: Record<string, string> = {
  STAFF: "Staff",
  GUEST: "Guest clinician",
  CONTRACTOR: "Contractor",
  EVENT_WORKER: "Event worker",
};

export const PAYOUT_KIND_LABELS: Record<string, string> = {
  PAYROLL: "Payroll",
  CLINIC: "Clinic",
  CAMP: "Camp",
  TOURNAMENT: "Tournament",
  GUEST: "Guest",
  CONTRACTOR: "Contractor",
  EVENT: "Event",
  OTHER: "Other",
};

// Payees identified by a Contractor row vs. a staff User row.
export function payeeUsesContractor(type: string): boolean {
  return type === "CONTRACTOR" || type === "GUEST";
}
