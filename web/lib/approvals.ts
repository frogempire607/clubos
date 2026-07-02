// Owner-surfaced PendingApproval kinds.
//
// These are reviewed by club owners/staff in the dashboard approvals queue
// (/dashboard/approvals) — never shown to members in their family-approvals
// card. Member-side (parental) kinds like CLASS_BOOK live elsewhere.

import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";

// A member/guardian asked to cancel a membership. Owner approval performs the
// real Stripe cancellation (see /api/member/subscriptions/cancel/approve).
//   payload: { subscriptionId, stripeSubscriptionId, optionLabel, requestingUserId, reason? }
//   amount:  the subscription's recurring price (for context in the queue)
export const MEMBERSHIP_CANCEL_KIND = "MEMBERSHIP_CANCEL" as const;

// A member/guardian wants to buy a NEW membership in-portal but pay by
// cash/check (no Stripe). Owner approval creates the MANUAL MemberSubscription
// and activates the member (see /api/approvals/membership-purchase).
//   payload: { membershipId, optionLabel, paymentMethod, memberId, requestingUserId }
//   amount:  the option price
export const MEMBERSHIP_PURCHASE_KIND = "MEMBERSHIP_PURCHASE" as const;

// A member/guardian wants to buy a private-lesson package by cash/check.
// Owner approval grants the PrivateCreditLedger credits + records an unpaid
// manual invoice transaction (see /api/approvals/private-package-purchase).
//   payload: { packageId, memberId, lessonTypeId?, priceOptionId?, paymentMethod, totalAmount, requestingUserId }
//   amount:  the computed pack total
export const PRIVATE_PACKAGE_PURCHASE_KIND = "PRIVATE_PACKAGE_PURCHASE" as const;

// Every kind that should appear in the owner dashboard approvals queue.
export const OWNER_APPROVAL_KINDS: string[] = [
  GUARDIAN_LINK_KIND,
  MEMBERSHIP_CANCEL_KIND,
  MEMBERSHIP_PURCHASE_KIND,
  PRIVATE_PACKAGE_PURCHASE_KIND,
];
