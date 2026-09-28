import { redirect } from "next/navigation";

// Contractors and guests now live on the one All staff list (Type filter:
// Contractors & guests). Keep this path working for bookmarks and older links.
export default function ContractorsRedirect() {
  redirect("/dashboard/staff?type=contractors");
}
