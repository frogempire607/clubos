// Should Stripe be asked to send this event again? PURE.
//
// The webhook used to answer "got it" (200) to EVERY failure, so that a bug in
// our code could not make Stripe hammer us for three days. The cost was that a
// passing problem — the database unreachable for a few seconds, a dropped
// connection to Stripe — was treated the same way: the payment event was
// thrown away and never recorded.
//
// Now a failure that is about the CONNECTION is answered with an error, and
// Stripe retries with its own back-off until it gets through. A failure that
// is about the DATA or the CODE would fail the same way every time, so it is
// still answered 200 and left on the event log with its error message.
//
// Retrying is safe because the handler is written to be repeated: payments
// are recorded once per PaymentIntent (lib/transactionOnce.ts), subscription
// money once per invoice, and the follow-up writes are all "set to", not
// "add to". The one visible side effect of a retry is that a confirmation
// email can be sent twice.

/** Prisma error codes that mean "could not reach or finish with the database". */
const TRANSIENT_PRISMA_CODES = new Set([
  "P1001", // can't reach database server
  "P1002", // database server timed out
  "P1008", // operation timed out
  "P1017", // server closed the connection
  "P2024", // timed out fetching a connection from the pool
  "P2028", // transaction API error (expired / closed)
  "P2034", // write conflict or deadlock — retry the transaction
]);

/** Stripe SDK error types that are about reaching Stripe, not about the request. */
const TRANSIENT_STRIPE_TYPES = new Set(["StripeConnectionError", "StripeAPIError", "StripeRateLimitError"]);

const TRANSIENT_NODE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

type Loose = { code?: unknown; type?: unknown; name?: unknown; message?: unknown; cause?: unknown };

export function isTransientFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Loose;
  const code = typeof e.code === "string" ? e.code : "";
  if (TRANSIENT_PRISMA_CODES.has(code) || TRANSIENT_NODE_CODES.has(code)) return true;
  const type = typeof e.type === "string" ? e.type : "";
  if (TRANSIENT_STRIPE_TYPES.has(type)) return true;
  const name = typeof e.name === "string" ? e.name : "";
  // Prisma could not start a connection at all, or its engine went away.
  if (name === "PrismaClientInitializationError" || name === "PrismaClientRustPanicError") return true;
  // A wrapped network error (fetch failed → cause: ECONNRESET).
  if (e.cause && e.cause !== err) return isTransientFailure(e.cause);
  return false;
}

/** The status the webhook answers a failed event with. */
export function webhookFailureStatus(err: unknown): 200 | 500 {
  return isTransientFailure(err) ? 500 : 200;
}
