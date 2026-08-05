// The roster IS /dashboard/members now — see the note there.
//
// This route existed for one session, while the redesigned list lived beside
// the old one. It stays only as a redirect: anyone who bookmarked it during
// that window lands on the real list rather than a 404.

import { redirect } from "next/navigation";

export default function RosterRedirect() {
  redirect("/dashboard/members");
}
