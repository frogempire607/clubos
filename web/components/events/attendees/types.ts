// Shapes the Attendees screen reads from the two EXISTING endpoints:
//   GET /api/events/[id]/attendees      — the ledger (every number on screen)
//   GET /api/events/[id]/registrations  — per-registration detail the actions
//                                         need (payment method, recipient
//                                         repair, policy, category fields)
import type { AttendeeLedger } from "@/lib/eventAttendees";
import type { CheckInRecord, RowExtras, SendEntry } from "@/lib/eventAttendeeExtras";
import type { CategoryField } from "@/lib/eventCategories";

export type AttendeesPayload = {
  event: {
    id: string;
    name: string;
    startsAt: string;
    endsAt: string;
    capacity: number | null;
    publicSlug: string | null;
    sessionCount: number;
    categoryLabel: string | null;
    requirePaymentBeforeCheckin?: boolean;
  };
  ledger: AttendeeLedger;
  extras?: Record<string, RowExtras>;
  checkIns?: CheckInRecord[];
  sends?: Record<string, SendEntry[]>;
};

export type RegDetail = {
  id: string;
  name: string;
  status: string;
  amountDue: number | string | null;
  amountPaid: number | string | null;
  paymentMethod: string | null;
  transactionId: string | null;
  discountCode: string | null;
  discountLabel?: string | null;
  discountAmount: number | string | null;
  sessionIds?: string[] | null;
  invoiceCount: number;
  invoicedAt: string | null;
  paidVia: string | null;
  checkReference: string | null;
  lastChargeError: string | null;
  confirmationCode?: string | null;
  createdAt: string;
  approvalRequestedAt?: string | null;
  formResponses: Record<string, string | boolean> | null;
  proposedChange?: {
    proposedAt?: string;
    priceDelta?: number;
    changes?: Record<string, unknown>;
    labels?: Record<string, string>;
  } | null;
  proposedChangeRespondedAt?: string | null;
  member: { id: string; firstName: string; lastName: string; isMinor?: boolean; guardianName?: string | null } | null;
  recipient: {
    email: string | null;
    source: "REGISTRATION" | "MEMBER_FAMILY" | null;
    displayName: string | null;
    reason: string | null;
    fixMemberId: string | null;
  } | null;
};

export type RegistrationsPayload = {
  event: {
    name: string;
    registrationForm: { id: string; label: string }[] | null;
    variableCostEnabled: boolean;
    variableCostMode: string | null;
    variableCostEstimatedSignups: number | null;
    variableCostBilledAt: string | null;
    requirePaymentBeforeCheckin?: boolean;
    policy?: {
      requiresCoachApproval: boolean;
      allowProposedChanges: boolean;
      holdSpotDuringReview: boolean;
    };
    canDecide?: boolean;
    categoryFields?: CategoryField[];
    extraEntryLabel?: string;
    proposalNotePlaceholder?: string;
  };
  registrations: RegDetail[];
  activeCount: number;
  mode: "ESTIMATED" | "OFFICIAL";
  perHead: number | null;
  publicPrice: number | null;
};

export type InvoiceLine = {
  registrationId: string;
  name: string;
  email: string | null;
  emailReason: string | null;
  amount: number;
  expected: number;
  mismatch: boolean;
  processingFee: number;
  chargedTotal: number;
  alreadyInvoiced: boolean;
};

export type InvoicePreview = {
  isVariable: boolean;
  expected: number;
  passProcessingFees: boolean;
  lines: InvoiceLine[];
  mismatched: number;
  grandTotal: number;
};

export const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
