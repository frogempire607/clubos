import { redirect } from "next/navigation";

// Approvals moved under Members → Approvals. Keep this path working for any
// bookmarks or older links.
export default function ApprovalsRedirect() {
  redirect("/dashboard/members/approvals");
}
