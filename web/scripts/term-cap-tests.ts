/**
 * A commitment can never run past the membership's end date (2026-11).
 *
 *   npx tsx scripts/term-cap-tests.ts
 *
 * Colton Waite: 3 contract months gave a commitment 13 days AFTER the row ended.
 */
import { harness, src, dayFromNow } from "./_followup-harness";
import { capTermAtEnd } from "../lib/membershipOptions";

const { check, section, done } = harness();
const end = dayFromNow(60), later = dayFromNow(73), earlier = dayFromNow(30);

section("capTermAtEnd");
check("a term after the end is cut back to the end", capTermAtEnd(later, end)?.getTime() === end.getTime());
check("a term before the end is kept", capTermAtEnd(earlier, end)?.getTime() === earlier.getTime());
check("a term equal to the end is kept", capTermAtEnd(end, end)?.getTime() === end.getTime());
check("no end date → the term stands", capTermAtEnd(later, null)?.getTime() === later.getTime());
check("no term → null", capTermAtEnd(null, end) === null && capTermAtEnd(undefined, null) === null);
check("the result is never after the end, whatever goes in", [earlier, end, later].every((t) => capTermAtEnd(t, end)!.getTime() <= end.getTime()));

section("source guarantees");
{
  const lib = src("lib/cardActivation.ts");
  check("the saved-card row writer caps the term at the end date it writes", lib.includes("minimumTermEndsAt: capTermAtEnd(input.minimumTermEndsAt, cancelAtUnix ? new Date(cancelAtUnix * 1000) : null)"));
  check("…and writes that same end date on the row", lib.includes("...(cancelAtUnix ? { endDate: new Date(cancelAtUnix * 1000) } : {})"));
  const route = src("app/api/members/[id]/billing-admin/actions/route.ts");
  const act = route.slice(route.indexOf('if (data.action === "activate_card")'), route.indexOf('if (data.action === "sync_stripe")'));
  check("activate_card creates its row ONLY through that writer", act.includes("createSavedCardSubscription({") && !/memberSubscription\.create\(/.test(act));
  check("activate_card never writes minimumTermEndsAt itself afterwards", !/memberSubscription\.update(Many)?\([^)]*minimumTermEndsAt/.test(act));
}
done();
