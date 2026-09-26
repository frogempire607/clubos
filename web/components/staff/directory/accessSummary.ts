// B21 — one plain-English line summarising a staff member's access, for the
// Staff directory rows. Pure (no React) so it can be tested with tsx.
//   "Full in 8 areas · edit staff schedule · view financials & payroll and reports"
import { PERMISSION_CATALOG, resolvePermissions, type PermissionLevel } from "@/lib/permissions";

const ORDER: PermissionLevel[] = ["full", "edit", "send", "view"];

export function accessSummary(role: string, rawPermissions: unknown): string {
  if (role === "OWNER") return "Full access (owner)";
  const perms = resolvePermissions((rawPermissions ?? null) as Record<string, unknown> | null);
  const parts: string[] = [];
  for (const level of ORDER) {
    const labels = PERMISSION_CATALOG.filter((p) => perms[p.key] === level).map((p) => p.label.toLowerCase());
    if (labels.length === 0) continue;
    if (labels.length >= 3) parts.push(`${level} in ${labels.length} areas`);
    else parts.push(`${level} ${labels.join(" and ")}`);
  }
  if (parts.length === 0) return "No access yet — set it on their profile";
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
