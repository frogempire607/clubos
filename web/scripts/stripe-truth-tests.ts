// Pure-function tests for lib/stripeTruth.ts + lib/paymentSources.ts —
// specifically the API-version compatibility that caused the 2026-07-14
// missing-revenue incident (clover payloads have no top-level
// invoice.subscription / invoice.payment_intent).
//
// Run: npx tsx scripts/stripe-truth-tests.ts   (no DB, no Stripe)
import {
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  invoicePaymentIntentId,
  verifiedStripeTxFields,
} from "../lib/stripeTruth";
import { attendanceMethodClassification, EXCLUDE_VOID } from "../lib/paymentSources";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

// ── Clover shape (2026-02-25.clover — what the webhook actually receives) ──
// Mirrors the real stored payload of evt_1Tsv5ZEIplcCMoSoWW0fiuy0 (Michael
// Lister's dropped $545.37 invoice.paid).
const cloverInvoice = {
  id: "in_1Tsu95EIplcCMoSoKEmLlg5g",
  amount_paid: 54537,
  billing_reason: "subscription_cycle",
  customer: "cus_Uq2mEflgKI7Xdd",
  // NO top-level subscription / payment_intent fields at all:
  parent: {
    type: "subscription_details",
    quote_details: null,
    subscription_details: {
      metadata: {
        clubId: "club_1",
        memberId: "member_1",
        memberSubscriptionId: "msub_1",
      },
      subscription: "sub_1TqMhGEIplcCMoSoBDwCp2xq",
    },
  },
  payments: {
    data: [
      { payment: { type: "payment_intent", payment_intent: "pi_clover_1" }, status: "paid" },
    ],
  },
};

eq("clover: subscription id from parent", invoiceSubscriptionId(cloverInvoice), "sub_1TqMhGEIplcCMoSoBDwCp2xq");
eq("clover: metadata from parent", invoiceSubscriptionMetadata(cloverInvoice), {
  clubId: "club_1",
  memberId: "member_1",
  memberSubscriptionId: "msub_1",
});
eq("clover: payment intent from payments list", invoicePaymentIntentId(cloverInvoice), "pi_clover_1");

// Clover payload as actually delivered by the webhook (payments list often
// absent/empty in the event payload) — PI must be null, not a crash.
const cloverInvoiceNoPayments = { ...cloverInvoice, payments: undefined };
eq("clover w/o payments: subscription still resolves", invoiceSubscriptionId(cloverInvoiceNoPayments), "sub_1TqMhGEIplcCMoSoBDwCp2xq");
eq("clover w/o payments: payment intent null", invoicePaymentIntentId(cloverInvoiceNoPayments), null);

// ── Legacy shape (pre-basil, what the pinned SDK returns on retrieve) ──
const legacyInvoice = {
  id: "in_legacy",
  amount_paid: 515,
  subscription: "sub_legacy_1",
  payment_intent: "pi_legacy_1",
};
eq("legacy: top-level subscription", invoiceSubscriptionId(legacyInvoice), "sub_legacy_1");
eq("legacy: top-level payment intent", invoicePaymentIntentId(legacyInvoice), "pi_legacy_1");
eq("legacy: metadata empty (no parent)", invoiceSubscriptionMetadata(legacyInvoice), {});

// Expanded-object variants (either field may be an object when expanded).
eq(
  "expanded: subscription object",
  invoiceSubscriptionId({ subscription: { id: "sub_obj" } }),
  "sub_obj",
);
eq(
  "expanded: payment intent object",
  invoicePaymentIntentId({ payment_intent: { id: "pi_obj" } }),
  "pi_obj",
);
eq(
  "expanded clover: parent subscription object",
  invoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: "sub_pobj" } } } }),
  "sub_pobj",
);

// Degenerate inputs never throw.
eq("null invoice", invoiceSubscriptionId(null), null);
eq("empty invoice", invoicePaymentIntentId({}), null);
eq("empty metadata", invoiceSubscriptionMetadata(undefined), {});

// ── verifiedStripeTxFields ──
eq(
  "tx fields: full money facts",
  verifiedStripeTxFields({ paymentIntentId: "pi_1", chargeId: "ch_1", feeAmount: 16.12, netAmount: 529.25 }),
  { paymentSource: "STRIPE", reconciliationStatus: "VERIFIED", stripeChargeId: "ch_1", stripeFeeAmount: 16.12, netAmount: 529.25 },
);
eq(
  "tx fields: missing fee still VERIFIED (backfilled later)",
  verifiedStripeTxFields({ paymentIntentId: "pi_1", chargeId: null, feeAmount: null, netAmount: null }),
  { paymentSource: "STRIPE", reconciliationStatus: "VERIFIED" },
);
eq("tx fields: null money", verifiedStripeTxFields(null), {
  paymentSource: "STRIPE",
  reconciliationStatus: "VERIFIED",
});

// ── attendance classification ──
eq("attendance CASH", attendanceMethodClassification("CASH"), { paymentSource: "CASH", reconciliationStatus: "OFFLINE" });
eq("attendance CHECK", attendanceMethodClassification("CHECK"), { paymentSource: "CHECK", reconciliationStatus: "OFFLINE" });
eq("attendance CREDIT is UNVERIFIED external reader", attendanceMethodClassification("CREDIT"), {
  paymentSource: "EXTERNAL_READER",
  reconciliationStatus: "UNVERIFIED",
});
eq("attendance COMP", attendanceMethodClassification("COMP"), { paymentSource: "COMP", reconciliationStatus: "OFFLINE" });
eq("attendance INVOICE → manual adjustment", attendanceMethodClassification("INVOICE"), {
  paymentSource: "MANUAL_ADJUSTMENT",
  reconciliationStatus: "OFFLINE",
});

// EXCLUDE_VOID shape is what Prisma expects.
eq("EXCLUDE_VOID fragment", EXCLUDE_VOID, { NOT: { reconciliationStatus: "VOID" } });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
