// The registration number a parent reads out over the phone (plan.md §5.2.3).
//
// Deterministic from the row id, so the same registration always derives the
// same code and a backfill is a pure function of data we already have — no
// counter, no sequence, no second source of truth. The row id remains the real
// key; this is the human-facing projection of it.
//
// Crockford base32 (no I, L, O, U) so a code read aloud or typed from a phone
// screen can't be misheard as a different one, and so it never accidentally
// spells a word. Eight characters = 32^8 ≈ 1.1e12 values; the partial unique
// index on event_registrations.confirmationCode is what makes a collision an
// error instead of a silent duplicate, and `salt` is how the caller retries.
//
// PURE — no prisma, no crypto import, no IO.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 8;

/**
 * 64-bit FNV-1a over the id (plus an optional salt), split into two 32-bit
 * halves so we stay inside safe integer math without BigInt.
 */
function hash64(input: string): [number, number] {
  let hi = 0x811c9dc5;
  let lo = 0x1000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
    lo = Math.imul(lo ^ ((c << 3) | (i & 7)), 0x01000193) >>> 0;
  }
  return [hi, lo];
}

export function confirmationCodeFor(id: string, salt = 0): string {
  const [hi, lo] = hash64(salt === 0 ? id : `${id}#${salt}`);
  let out = "";
  let a = hi;
  let b = lo;
  for (let i = 0; i < LENGTH; i++) {
    // Alternate halves so both contribute to every code.
    const src = i % 2 === 0 ? a : b;
    out += ALPHABET[src & 31];
    if (i % 2 === 0) a = a >>> 5;
    else b = b >>> 5;
    if (a === 0) a = hi ^ (i + 1);
    if (b === 0) b = lo ^ (i + 1);
  }
  return out;
}

/** True for a string this module could have produced. */
export function isConfirmationCode(v: unknown): boolean {
  return typeof v === "string" && v.length === LENGTH && [...v].every((c) => ALPHABET.includes(c));
}
