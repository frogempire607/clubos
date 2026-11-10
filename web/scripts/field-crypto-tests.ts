// Phase 12.1 Part 2 — field-level encryption and tax-identification numbers.
//
//   npm run test:field-crypto     (and it GATES the build)
//
// No database, no network. The crypto runs for real against a throwaway key
// generated in-process.
//
// §6 IS THE BUILD GUARD the brief asks for: a TIN-shaped field in the schema
// is only allowed to exist while field-level encryption exists to protect it,
// is only ever written as ciphertext, and is only ever decrypted in one
// audited place. If any of that stops being true, the build fails.
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  FIELD_KEY_ENV,
  FIELD_RETIRED_KEYS_ENV,
  FieldCryptoError,
  decryptField,
  encryptField,
  fieldCryptoConfigured,
  fieldCryptoStatus,
  isEncryptedField,
  needsReencryption,
} from "../lib/fieldCrypto";
import {
  TAX_CLASSIFICATIONS,
  W9_CERTIFICATION_TEXT,
  W9_ESIGN_NOTICE,
  formatTin,
  isTaxClassification,
  isTinKind,
  maskedTin,
  normalizeTin,
  signatureMatchesName,
  suggestsEin,
  taxClassificationLabel,
  tinLast4,
  validateTin,
  validateW9,
  type W9Draft,
} from "../lib/tin";
import { renderW9Pdf } from "../lib/w9Pdf";

const ROOT = join(__dirname, "..");
let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, name: string, detail?: string) => {
  if (cond) pass++;
  else fails.push(detail ? `${name} — ${detail}` : name);
};
const eq = <T,>(actual: T, expected: T, name: string) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
const throws = (name: string, run: () => unknown, match?: RegExp) => {
  try {
    run();
    fails.push(`${name} — did NOT throw`);
  } catch (e) {
    const msg = (e as Error).message;
    if (match && !match.test(msg)) fails.push(`${name} — threw, but message was "${msg}"`);
    else pass++;
  }
};

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const withEnv = <T,>(env: Record<string, string | undefined>, run: () => T): T => {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    before[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return run();
  } finally {
    for (const k of Object.keys(env)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
};

// ── 1. NO PLAINTEXT FALLBACK ────────────────────────────────────────────────
// The single most important property. A value this sensitive landing in the
// database readable because an environment variable was forgotten is the exact
// failure this module exists to prevent.
console.log("[1] no plaintext fallback");
{
  withEnv({ [FIELD_KEY_ENV]: undefined, [FIELD_RETIRED_KEYS_ENV]: undefined }, () => {
    ok(!fieldCryptoConfigured(), "1.1 with no key, the module reports itself unconfigured");
    throws("1.2 and encrypting REFUSES rather than returning plaintext", () => encryptField("123456789"), /not set/);
    throws("1.3 and decrypting refuses too", () => decryptField("v1:1:AAAA:AAAA:AAAA"), /not set/);
    const st = fieldCryptoStatus();
    ok(!st.configured, "1.4 status says unconfigured");
    ok(/not set/.test(st.problem ?? ""), "1.5 and names the variable to set");
  });

  // A key that is PRESENT but malformed must not count as configured, or a
  // route would collect a tax id and then fail at the write.
  withEnv({ [FIELD_KEY_ENV]: "1:not-base64-at-all!!!", [FIELD_RETIRED_KEYS_ENV]: undefined }, () => {
    ok(!fieldCryptoConfigured(), "1.6 a malformed key is NOT 'configured'");
    ok((fieldCryptoStatus().problem ?? "").length > 0, "1.7 and the problem is reported");
  });
  withEnv({ [FIELD_KEY_ENV]: Buffer.alloc(16).toString("base64") }, () => {
    ok(!fieldCryptoConfigured(), "1.8 a 16-byte key is refused — AES-256 needs 32");
    ok(/32 bytes/.test(fieldCryptoStatus().problem ?? ""), "1.9 and the message says so, since that's the common mistake");
  });
  withEnv({ [FIELD_KEY_ENV]: "   " }, () => {
    ok(!fieldCryptoConfigured(), "1.10 whitespace is not a key");
  });
}

// ── 2. The crypto itself ────────────────────────────────────────────────────
console.log("\n[2] AES-256-GCM");
{
  withEnv({ [FIELD_KEY_ENV]: `1:${KEY_A}`, [FIELD_RETIRED_KEYS_ENV]: undefined }, () => {
    const TIN = "123456789";
    const ct = encryptField(TIN);

    eq(decryptField(ct), TIN, "2.1 a value round-trips");
    ok(isEncryptedField(ct), "2.2 and looks encrypted");
    ok(!ct.includes(TIN), "2.3 the stored value does NOT contain the plaintext");
    eq(ct.split(":").length, 5, "2.4 five colon-separated parts");
    eq(ct.split(":")[0], "v1", "2.5 version-prefixed, so a future format can change safely");
    eq(ct.split(":")[1], "1", "2.6 and names the key that wrote it, which is what makes rotation possible");

    // A fresh IV per value. Reusing one under GCM is catastrophic.
    const again = encryptField(TIN);
    ok(again !== ct, "2.7 encrypting the same value twice gives different ciphertext (fresh IV)");
    eq(decryptField(again), TIN, "2.8 and both decrypt");
    const ivs = new Set(Array.from({ length: 50 }, () => encryptField(TIN).split(":")[2]));
    eq(ivs.size, 50, "2.9 fifty encryptions give fifty distinct IVs");

    // Authentication: tampering must fail, not return nonsense.
    const parts = ct.split(":");
    const ct2 = Buffer.from(parts[3], "base64");
    ct2[0] ^= 0xff;
    throws(
      "2.10 a tampered ciphertext is REFUSED, not silently decrypted to garbage",
      () => decryptField([parts[0], parts[1], parts[2], ct2.toString("base64"), parts[4]].join(":")),
      /could not be decrypted/,
    );
    const tag = Buffer.from(parts[4], "base64");
    tag[0] ^= 0xff;
    throws("2.11 a tampered auth tag is refused", () =>
      decryptField([parts[0], parts[1], parts[2], parts[3], tag.toString("base64")].join(":")),
    );
    const iv = Buffer.from(parts[2], "base64");
    iv[0] ^= 0xff;
    throws("2.12 a tampered IV is refused", () =>
      decryptField([parts[0], parts[1], iv.toString("base64"), parts[3], parts[4]].join(":")),
    );

    throws("2.13 a malformed stored value is refused", () => decryptField("nonsense"), /format/);
    throws("2.14 as is a value with the wrong part count", () => decryptField("v1:1:a:b"), /format/);
    throws("2.15 and one claiming an unknown format version", () => decryptField("v9:1:a:b:c"), /format/);
    throws("2.16 encrypting nothing is refused", () => encryptField(""));
    throws("2.17 and an absurdly long value is capped", () => encryptField("9".repeat(5000)), /too long/);

    ok(!isEncryptedField(""), "2.18 an empty string is not an encrypted field");
    ok(!isEncryptedField("123456789"), "2.19 nor is a bare tax id");
    ok(!isEncryptedField(null), "2.20 nor null");
  });

  // A bare key with no id defaults to id 1, so first-time setup needs no
  // ceremony.
  withEnv({ [FIELD_KEY_ENV]: KEY_A, [FIELD_RETIRED_KEYS_ENV]: undefined }, () => {
    const ct = encryptField("987654321");
    eq(ct.split(":")[1], "1", "2.21 a key with no id is treated as id 1");
    eq(decryptField(ct), "987654321", "2.22 and round-trips");
  });
}

// ── 3. Key rotation ─────────────────────────────────────────────────────────
console.log("\n[3] key rotation");
{
  // Written under key 1…
  const underA = withEnv({ [FIELD_KEY_ENV]: `1:${KEY_A}`, [FIELD_RETIRED_KEYS_ENV]: undefined }, () =>
    encryptField("111223333"),
  );

  // …then key 2 takes over and key 1 is retired.
  withEnv({ [FIELD_KEY_ENV]: `2:${KEY_B}`, [FIELD_RETIRED_KEYS_ENV]: `1:${KEY_A}` }, () => {
    eq(decryptField(underA), "111223333", "3.1 a value written under the old key still decrypts after rotation");
    const underB = encryptField("111223333");
    eq(underB.split(":")[1], "2", "3.2 new values are written under the NEW key");
    eq(decryptField(underB), "111223333", "3.3 and decrypt");
    ok(needsReencryption(underA), "3.4 the old value is reported as needing re-encryption");
    ok(!needsReencryption(underB), "3.5 the new one is not");
    const st = fieldCryptoStatus();
    eq(st.activeKeyId, "2", "3.6 status names the active key");
    eq(st.retiredKeyIds, ["1"], "3.7 and the retired ones");
    ok(st.configured, "3.8 and reports configured");
  });

  // Dropping the old key on rotation is the classic mistake, and the error has
  // to say what happened.
  withEnv({ [FIELD_KEY_ENV]: `2:${KEY_B}`, [FIELD_RETIRED_KEYS_ENV]: undefined }, () => {
    throws(
      "3.9 a value whose key was dropped fails with an explanation, not a generic error",
      () => decryptField(underA),
      /No encryption key with id "1"/,
    );
    ok(
      /FIELD_ENCRYPTION_KEYS_RETIRED/.test((() => {
        try {
          decryptField(underA);
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      })()),
      "3.10 and tells the operator where to put the old key",
    );
  });

  // The WRONG key must fail authentication rather than return nonsense.
  withEnv({ [FIELD_KEY_ENV]: `1:${KEY_B}`, [FIELD_RETIRED_KEYS_ENV]: undefined }, () => {
    throws("3.11 the wrong key under the right id is refused by the auth tag", () => decryptField(underA));
  });

  // A retired entry that reuses the active id must not shadow the active key.
  withEnv({ [FIELD_KEY_ENV]: `1:${KEY_A}`, [FIELD_RETIRED_KEYS_ENV]: `1:${KEY_B}` }, () => {
    eq(decryptField(underA), "111223333", "3.12 a retired key cannot shadow the active key with the same id");
  });
  withEnv({ [FIELD_KEY_ENV]: `1:${KEY_A}`, [FIELD_RETIRED_KEYS_ENV]: "" }, () => {
    eq(decryptField(underA), "111223333", "3.13 an empty retired list is harmless");
  });
}

// ── 4. No message ever carries the value ────────────────────────────────────
console.log("\n[4] errors never carry the secret");
{
  const TIN = "456789123";
  const captured: string[] = [];
  withEnv({ [FIELD_KEY_ENV]: `1:${KEY_A}` }, () => {
    const ct = encryptField(TIN);
    const parts = ct.split(":");
    const broken = Buffer.from(parts[3], "base64");
    broken[0] ^= 0xff;
    for (const attempt of [
      () => decryptField("nonsense"),
      () => decryptField("v1:1:a:b:c"),
      () => decryptField([parts[0], parts[1], parts[2], broken.toString("base64"), parts[4]].join(":")),
      () => encryptField(""),
      () => encryptField("9".repeat(5000)),
    ]) {
      try {
        attempt();
      } catch (e) {
        captured.push((e as Error).message);
        captured.push((e as Error).stack ?? "");
      }
    }
  });
  ok(captured.length > 0, "4.1 the failures above produced error messages to inspect");
  ok(
    !captured.some((m) => m.includes(TIN)),
    "4.2 no error message or stack contains the tax id",
    captured.find((m) => m.includes(TIN)),
  );
  ok(
    !captured.some((m) => m.includes(KEY_A) || m.includes(KEY_B)),
    "4.3 and none contains the key",
  );
  ok(
    captured.every((m) => !/[0-9]{9}/.test(m)),
    "4.4 and none contains any nine-digit run at all",
  );
}

// ── 5. TIN rules ────────────────────────────────────────────────────────────
console.log("\n[5] tax id validation and masking");
{
  eq(normalizeTin("123-45-6789"), "123456789", "5.1 dashes are stripped");
  eq(normalizeTin(" 12 34 56789 "), "123456789", "5.2 so is whitespace");
  eq(normalizeTin("12-3456789"), "123456789", "5.3 and EIN punctuation");
  eq(normalizeTin(""), "", "5.4 an empty value normalizes to empty");

  eq(validateTin("123-45-6789", "SSN"), [], "5.5 a valid SSN passes");
  eq(validateTin("12-3456789", "EIN"), [], "5.6 a valid EIN passes");
  ok(validateTin("12345678", "SSN").length > 0, "5.7 eight digits is refused");
  ok(/nine digits/.test(validateTin("12345678", "SSN")[0]), "5.8 and says how many it has");
  ok(validateTin("1234567890", "SSN").length > 0, "5.9 ten digits is refused");
  ok(validateTin("111111111", "SSN").length > 0, "5.10 a repeated digit is refused");
  ok(validateTin("", "SSN").length > 0, "5.11 empty is refused");

  // SSA's own invalid ranges — these catch real typos and placeholders.
  ok(validateTin("000-45-6789", "SSN").length > 0, "5.12 an SSN starting 000 is refused");
  ok(validateTin("666-45-6789", "SSN").length > 0, "5.13 starting 666 is refused");
  ok(validateTin("900-45-6789", "SSN").length > 0, "5.14 starting 900 is refused");
  ok(validateTin("999-45-6789", "SSN").length > 0, "5.15 starting 999 is refused");
  ok(validateTin("123-00-6789", "SSN").length > 0, "5.16 a 00 group is refused");
  ok(validateTin("123-45-0000", "SSN").length > 0, "5.17 a 0000 serial is refused");
  eq(validateTin("899-45-6789", "SSN"), [], "5.18 but 899 is a legitimate area and passes");

  ok(validateTin("00-3456789", "EIN").length > 0, "5.19 an EIN starting 00 is refused");
  // The IRS prefix list is deliberately NOT enforced — it changes, and a stale
  // copy would reject a real EIN, which is worse than accepting a typo the IRS
  // bounces at filing.
  eq(validateTin("07-3456789", "EIN"), [], "5.20 an unusual-but-plausible EIN prefix is accepted, by design");

  eq(tinLast4("123-45-6789"), "6789", "5.21 last four digits");
  eq(formatTin("123456789", "SSN"), "123-45-6789", "5.22 an SSN formats with two dashes");
  eq(formatTin("123456789", "EIN"), "12-3456789", "5.23 an EIN with one");
  eq(formatTin("123", "SSN"), "123", "5.24 a partial value is left alone rather than mis-formatted");

  eq(maskedTin("6789", "SSN"), "•••-••-6789", "5.25 an SSN masks to the last four");
  eq(maskedTin("6789", "EIN"), "••-•••6789", "5.26 an EIN masks in its own shape");
  eq(maskedTin(null, "SSN"), "Not on file", "5.27 nothing on file says so");
  eq(maskedTin("678", "SSN"), "Not on file", "5.28 and a malformed last-four is not displayed as real");

  ok(isTinKind("SSN") && isTinKind("EIN"), "5.29 both kinds are recognised");
  ok(!isTinKind("ITIN") && !isTinKind(null), "5.30 anything else is not");
}

// ── 6. THE BUILD GUARD ──────────────────────────────────────────────────────
// A TIN-shaped field may exist only while the encryption that protects it
// exists, is the only way it is written, and is only read in one audited place.
console.log("\n[6] build guard — a tax id may only exist encrypted");
{
  const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e === ".git") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  };
  const strip = (x: string) =>
    x
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1)
      .replace(/^\s*\/\/\/.*$/gm, "");

  // (a) A PLAINTEXT tax-id field must not exist. `taxIdEncrypted`,
  //     `taxIdLast4` and `taxIdKind` are the three allowed names.
  // Anchored to the WHOLE field name. A substring search is useless here:
  // "businessName" contains "ssn" and "settings" contains "tin", so a
  // substring guard cries wolf on a dozen innocent columns and then gets
  // disabled by whoever is next — which is how a guard stops guarding.
  const tinFields = [
    ...schema.matchAll(/^\s*((?:taxId|tin|ssn|socialSecurity|federalTaxId|payeeTaxId|taxpayerId)[A-Za-z0-9]*)\s+\w/gim),
  ].map((m) => m[1]);
  const allowed = new Set(["taxIdEncrypted", "taxIdLast4", "taxIdKind"]);
  const bad = tinFields.filter((f) => !allowed.has(f));
  eq(bad, [], "6.1 the schema declares no PLAINTEXT tax-id field");
  ok(tinFields.includes("taxIdEncrypted"), "6.2 and the encrypted one does exist, so this guard is not vacuous");

  // (b) Encryption must exist for it.
  const libFiles = walk(join(ROOT, "lib"));
  const hasCrypto = libFiles.some((f) => {
    const src = readFileSync(f, "utf8");
    return /createCipheriv|createDecipheriv/.test(src) && /aes-256-gcm/.test(src);
  });
  ok(hasCrypto, "6.3 AES-256-GCM field encryption exists in lib/", "a tax-id field without encryption must fail the build");

  // (c) decryptField is called from exactly ONE module.
  const appAndLib = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))];
  const decryptCallers = appAndLib
    .filter((f) => !f.endsWith("lib/fieldCrypto.ts"))
    .filter((f) => /\bdecryptField\s*\(/.test(strip(readFileSync(f, "utf8"))))
    .map((f) => f.replace(ROOT + "/", ""));
  eq(decryptCallers, ["lib/contractorTin.ts"], "6.4 decryptField is called from exactly one module");

  // (d) That module audits BEFORE it decrypts, and a failed audit stops it.
  const tinModule = readFileSync(join(ROOT, "lib/contractorTin.ts"), "utf8");
  const revealBody = tinModule.slice(tinModule.indexOf("export async function revealTin"));
  const auditAt = revealBody.indexOf("await auditTin(");
  const decryptAt = revealBody.indexOf("decryptField(");
  ok(auditAt > -1 && decryptAt > -1 && auditAt < decryptAt, "6.5 the audit is written BEFORE the decryption");
  ok(
    /throw new TinError\(\s*\n?\s*"That couldn't be recorded in the audit trail/.test(tinModule),
    "6.6 and a failed audit REFUSES the read rather than allowing an unaudited one",
  );
  ok(
    !/writeBillingAudit/.test(strip(tinModule)),
    "6.7 it does not use the audit helper that swallows its own errors",
  );
  ok(
    /writeBillingAudit/.test(tinModule),
    "6.7b …and the comment explaining why is still there (so 6.7 isn't passing vacuously)",
  );

  // (e) Nothing in the TIN path logs.
  for (const f of ["lib/fieldCrypto.ts", "lib/tin.ts", "lib/contractorTin.ts", "lib/w9Pdf.ts"]) {
    const src = strip(readFileSync(join(ROOT, f), "utf8"));
    ok(!/console\.(log|info|warn|error|debug)\s*\(/.test(src), `6.8 ${f} contains no console call`);
  }

  // (f) A write must go through encryptField, and the service must check the
  //     result really is ciphertext.
  ok(/encryptField\(/.test(tinModule), "6.9 the store path encrypts");
  ok(/isEncryptedField\(encrypted\)/.test(tinModule), "6.10 and verifies the result is ciphertext before writing it");
  ok(/fieldCryptoConfigured\(\)/.test(tinModule), "6.11 and refuses up front when no key is configured");
  const writers = appAndLib.filter((f) =>
    /taxIdEncrypted\s*:/.test(strip(readFileSync(f, "utf8"))),
  ).map((f) => f.replace(ROOT + "/", ""));
  eq(writers, ["lib/contractorTin.ts"], "6.12 exactly one module writes the encrypted column");

  // (g) The database refuses plaintext too, as a backstop.
  const migration = readFileSync(
    join(ROOT, "prisma/migrations/20261027000000_staff_tax_forms_documents/migration.sql"),
    "utf8",
  );
  ok(/contractor_w9_taxid_is_ciphertext/.test(migration), "6.13 a CHECK constraint requires ciphertext in the column");
  ok(/contractor_w9_last4_is_four_digits/.test(migration), "6.14 and the last-four column holds four digits");
  ok(
    !/CREATE INDEX[^;]*taxIdEncrypted/.test(migration),
    "6.15 there is no index on the ciphertext — nothing should ever look a TIN up by value",
  );
}

// ── 7. The W-9 form ────────────────────────────────────────────────────────
console.log("\n[7] the W-9");
{
  const good: W9Draft = {
    legalName: "Dana Ruiz",
    businessName: "Ruiz Officiating LLC",
    taxClassification: "LLC_P",
    classificationNote: null,
    streetAddress: "14 Mill Road",
    city: "Dayton",
    state: "OH",
    zipCode: "45402",
    taxIdKind: "SSN",
    taxId: "123-45-6789",
    signedName: "Dana Ruiz",
  };
  eq(validateW9(good), [], "7.1 a complete W-9 validates");

  ok(validateW9({ ...good, legalName: " " }).length > 0, "7.2 a blank legal name is refused");
  ok(validateW9({ ...good, taxClassification: "NONSENSE" }).length > 0, "7.3 an unknown classification is refused");
  ok(
    validateW9({ ...good, taxClassification: "OTHER", classificationNote: null }).length > 0,
    '7.4 choosing "Other" without describing it is refused',
  );
  eq(validateW9({ ...good, taxClassification: "OTHER", classificationNote: "Co-op" }), [], "7.5 described, it passes");
  ok(validateW9({ ...good, zipCode: "4540" }).length > 0, "7.6 a four-digit ZIP is refused");
  eq(validateW9({ ...good, zipCode: "45402-1234" }), [], "7.7 ZIP+4 is accepted");
  ok(validateW9({ ...good, taxId: "000-00-0000" }).length > 0, "7.8 an invalid TIN is refused");
  ok(validateW9({ ...good, signedName: "" }).length > 0, "7.9 an unsigned form is refused");
  ok(validateW9({ ...good, streetAddress: "", city: "", state: "" }).length >= 3, "7.10 every missing field is reported at once");

  ok(/penalties of perjury/i.test(W9_CERTIFICATION_TEXT), "7.11 the certification says 'under penalties of perjury'");
  ok(/backup withholding/i.test(W9_CERTIFICATION_TEXT), "7.12 and covers backup withholding");
  ok(/U\.S\. citizen or other U\.S\. person/i.test(W9_CERTIFICATION_TEXT), "7.13 and U.S. person status");
  ok(/FATCA/i.test(W9_CERTIFICATION_TEXT), "7.14 and FATCA");
  ok(/electronic signature/i.test(W9_ESIGN_NOTICE), "7.15 the e-signature notice says what typing a name means");

  ok(signatureMatchesName("Dana Ruiz", "Dana Ruiz"), "7.16 an exact signature matches");
  ok(signatureMatchesName("dana ruiz", "Dana Ruiz"), "7.17 case doesn't matter");
  ok(signatureMatchesName("Dana O'Brien", "Dana OBrien"), "7.18 nor does punctuation — the same person either way");
  ok(!signatureMatchesName("Someone Else", "Dana Ruiz"), "7.19 a different name does not match");
  ok(!signatureMatchesName("", "Dana Ruiz"), "7.20 and an empty signature never matches");

  eq(TAX_CLASSIFICATIONS.length, 11, "7.21 all eleven W-9 classifications are offered");
  ok(isTaxClassification("S_CORP"), "7.22 a known classification is recognised");
  ok(!isTaxClassification("LLC"), "7.23 a vague one is not");
  eq(taxClassificationLabel("LLC_P"), "LLC taxed as a partnership", "7.24 labels read like the form");
  eq(taxClassificationLabel("nope"), "—", "7.25 and an unknown one renders as a dash");
  ok(suggestsEin("PARTNERSHIP"), "7.26 a partnership suggests an EIN");
  ok(!suggestsEin("INDIVIDUAL"), "7.27 an individual does not");
  ok(!suggestsEin("SOLE_PROPRIETOR"), "7.28 nor a sole proprietor, who may legitimately use either");

  // The PDF — the copy the IRS requires an electronic system to produce.
  const pdf = renderW9Pdf({
    legalName: good.legalName,
    businessName: good.businessName ?? null,
    taxClassification: good.taxClassification,
    classificationNote: null,
    streetAddress: good.streetAddress,
    city: good.city,
    state: good.state,
    zipCode: good.zipCode,
    taxIdKind: "SSN",
    taxIdFormatted: "123-45-6789",
    certificationText: W9_CERTIFICATION_TEXT,
    signedName: good.signedName,
    signedAt: new Date("2026-10-27T15:04:00Z"),
    ipAddress: "203.0.113.7",
  });
  ok(pdf.length > 2000, "7.29 the PDF renders with real content", `${pdf.length} bytes`);
  eq(pdf.slice(0, 5).toString(), "%PDF-", "7.30 and is a PDF");
  // A very long name must not throw — jsPDF wraps, and a contractor with a
  // long business name must still be able to submit.
  const long = renderW9Pdf({
    legalName: "A".repeat(180),
    businessName: "B".repeat(180),
    taxClassification: "OTHER",
    classificationNote: "C".repeat(180),
    streetAddress: "D".repeat(120),
    city: "E".repeat(60),
    state: "OH",
    zipCode: "45402",
    taxIdKind: "EIN",
    taxIdFormatted: "12-3456789",
    certificationText: W9_CERTIFICATION_TEXT,
    signedName: "F".repeat(150),
    signedAt: new Date("2026-10-27T00:00:00Z"),
    ipAddress: null,
  });
  ok(long.length > 2000, "7.31 and a form full of very long values still renders");
}

console.log(`\n${fails.length ? "✗" : "✓"} field-crypto: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
