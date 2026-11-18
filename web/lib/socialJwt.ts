// The token maths for Sign in with Google / Apple, on node:crypto alone (no
// JWT library is a dependency of this app).
//
//   verifyIdToken   check a provider's signed id_token against its published
//                   keys: signature, issuer, audience, expiry, nonce.
//   signEs256Jwt    make the short ES256 token Apple wants as a "client secret".
//
// No network here: the caller passes the provider's keys in.

import { createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify, type JsonWebKey } from "crypto";

export type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

export type IdTokenCheck = {
  issuers: string[];
  audience: string;
  nonce: string;
  now: Date;
  /** Clock skew allowed, seconds. */
  leewaySec?: number;
};

export type IdTokenResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: "MALFORMED" | "ALG" | "NO_KEY" | "SIGNATURE" | "ISSUER" | "AUDIENCE" | "EXPIRED" | "NONCE" };

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function verifyIdToken(idToken: string | null | undefined, keys: Jwk[], check: IdTokenCheck): IdTokenResult {
  if (!idToken || typeof idToken !== "string") return { ok: false, reason: "MALFORMED" };
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (!header || !claims) return { ok: false, reason: "MALFORMED" };

  // RS256 only. Both providers sign with it; accepting whatever the token's
  // own header asks for ("none", HS256 with the public key as the secret) is
  // the classic way this check gets bypassed.
  if (header.alg !== "RS256") return { ok: false, reason: "ALG" };
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return { ok: false, reason: "NO_KEY" };

  let valid = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    valid = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "SIGNATURE" };

  if (typeof claims.iss !== "string" || !check.issuers.includes(claims.iss)) return { ok: false, reason: "ISSUER" };
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === check.audience : Array.isArray(aud) && aud.length === 1 && aud[0] === check.audience;
  if (!audOk) return { ok: false, reason: "AUDIENCE" };
  const leeway = check.leewaySec ?? 60;
  const nowSec = Math.floor(check.now.getTime() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + leeway < nowSec) return { ok: false, reason: "EXPIRED" };
  if (typeof claims.iat === "number" && claims.iat - leeway > nowSec) return { ok: false, reason: "EXPIRED" };
  if (typeof claims.nonce !== "string" || claims.nonce !== check.nonce) return { ok: false, reason: "NONCE" };
  return { ok: true, claims };
}

/** A PEM pasted into an environment variable often has its newlines turned into "\n". */
export function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n").trim() : pem.trim();
}

export function signEs256Jwt(input: { header: Record<string, unknown>; payload: Record<string, unknown>; privateKeyPem: string }): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const data = `${enc({ alg: "ES256", typ: "JWT", ...input.header })}.${enc(input.payload)}`;
  const key = createPrivateKey(normalizePem(input.privateKeyPem));
  // JWTs carry the raw r||s signature, not the DER wrapping node emits by default.
  const sig = cryptoSign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

/** Apple's "client secret": who we are (team), which key, for which Services ID. */
export function appleClientSecret(input: { teamId: string; keyId: string; servicesId: string; privateKeyPem: string; now: Date }): string {
  const iat = Math.floor(input.now.getTime() / 1000);
  return signEs256Jwt({
    header: { kid: input.keyId },
    payload: { iss: input.teamId, iat, exp: iat + 5 * 60, aud: "https://appleid.apple.com", sub: input.servicesId },
    privateKeyPem: input.privateKeyPem,
  });
}
