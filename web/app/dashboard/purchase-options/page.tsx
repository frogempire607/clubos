import { redirect } from "next/navigation";

// Bare section path. Sends to the first child, which is the canonical bare
// /dashboard/memberships rather than the old purchase-options alias — chaining
// redirect → redirect would cost a second round trip for no reason.
export default function PurchaseOptionsPage() {
  redirect("/dashboard/memberships");
}
