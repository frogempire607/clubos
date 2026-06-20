import assert from "node:assert/strict";
import {
  missingRequiredDocumentIds,
  isDocumentRequiredAt,
} from "../lib/documents";
import {
  normalizeImportedMemberContact,
  validateMemberContact,
} from "../lib/memberValidation";

function testMemberContactRules() {
  const minor = normalizeImportedMemberContact({
    email: "Parent@Example.com",
    phone: "555-0100",
    isMinor: true,
  });
  assert.equal(minor.email, null);
  assert.equal(minor.phone, null);
  assert.equal(minor.guardianEmail, "parent@example.com");
  assert.equal(minor.guardianPhone, "555-0100");

  const adult = normalizeImportedMemberContact({
    email: "Adult@Example.com",
    phone: "555-0199",
    isMinor: false,
  });
  assert.equal(adult.email, "adult@example.com");
  assert.equal(adult.phone, "555-0199");
  assert.equal(adult.guardianEmail, null);
  assert.equal(adult.guardianPhone, null);

  assert.equal(
    validateMemberContact({
      isMinor: true,
      guardianName: "Parent Person",
      guardianEmail: "parent@example.com",
      email: null,
      phone: null,
    }),
    null,
  );
  assert.equal(
    validateMemberContact({
      isMinor: true,
      guardianName: "Parent Person",
      guardianEmail: null,
      email: null,
      phone: null,
    }),
    "Guardian email is required for minors.",
  );
  assert.equal(
    validateMemberContact({
      isMinor: false,
      guardianName: null,
      guardianEmail: null,
      email: null,
      phone: null,
    }),
    "Adult members need an email or phone.",
  );
}

function testDocumentSurfaceRules() {
  assert.equal(isDocumentRequiredAt({ id: "legacy", required: true, requiredAt: [] }, "ONBOARDING"), true);
  assert.equal(isDocumentRequiredAt({ id: "signup", required: true, requiredAt: ["SIGNUP"] }, "ONBOARDING"), false);
  assert.equal(isDocumentRequiredAt({ id: "signup", required: true, requiredAt: ["SIGNUP"] }, "SIGNUP"), true);
  assert.equal(isDocumentRequiredAt({ id: "onboarding", required: false, requiredAt: ["ONBOARDING"] }, "ONBOARDING"), true);

  assert.deepEqual(
    missingRequiredDocumentIds(
      [
        { id: "waiver", required: true, requiredAt: ["ONBOARDING"] },
        { id: "signup-only", required: true, requiredAt: ["SIGNUP"] },
        { id: "legacy", required: true, requiredAt: [] },
      ],
      ["waiver"],
      "ONBOARDING",
    ),
    ["legacy"],
  );
}

testMemberContactRules();
testDocumentSurfaceRules();
console.log("production hardening regression checks passed");
