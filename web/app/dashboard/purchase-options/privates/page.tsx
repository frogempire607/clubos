import { redirect } from "next/navigation";

// This path used to re-export app/dashboard/privates/page.tsx, so one screen
// answered at two URLs and the sidebar only recognised this one. The bare path
// is canonical now (see lib/dashboardNav.ts); this stays as a redirect so old
// links, bookmarks and anything already sitting in an email keep working.
export default function PurchaseOptionsPrivatesRedirect() {
  redirect("/dashboard/privates");
}
