import { redirect } from "next/navigation";

// This was an older copy of Staff → Availability (same data, different screen,
// titled "Staff Schedule"). Keep the path working for bookmarks. (B20)
export default function ScheduleRedirect() {
  redirect("/dashboard/staff/availability");
}
