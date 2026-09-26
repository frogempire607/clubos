"use client";

import { useParams } from "next/navigation";
import StaffProfile from "@/components/staff/StaffProfile";

// B21 — a staff member's profile, for owners and staff managers.
export default function StaffProfilePage() {
  const params = useParams<{ id: string }>();
  return <StaffProfile staffId={params.id} />;
}
