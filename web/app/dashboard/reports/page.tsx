"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BarChart3, Bell, Download } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import ReliabilityStrip from "@/components/reports/ReliabilityStrip";
import RangeDropdown, { type RangeKey } from "@/components/reports/RangeDropdown";
import SnapshotTab from "@/components/reports/SnapshotTab";
import RevenueTab from "@/components/reports/RevenueTab";
import CostsTab from "@/components/reports/CostsTab";
import PnlTab from "@/components/reports/PnlTab";
import MembershipTab from "@/components/reports/MembershipTab";
import UnitEconomicsTab from "@/components/reports/UnitEconomicsTab";
import CashFlowTab from "@/components/reports/CashFlowTab";
import AlertsDrawer from "@/components/reports/AlertsDrawer";

type TabKey =
  | "snapshot"
  | "revenue"
  | "costs"
  | "pnl"
  | "membership"
  | "unit_economics"
  | "cash_flow"
  | "imports";

const TABS: { key: TabKey; label: string }[] = [
  { key: "snapshot", label: "Snapshot" },
  { key: "revenue", label: "Revenue" },
  { key: "costs", label: "Costs" },
  { key: "pnl", label: "Profit & Loss" },
  { key: "membership", label: "Membership" },
  { key: "unit_economics", label: "Unit economics" },
  { key: "cash_flow", label: "Cash flow" },
  { key: "imports", label: "History & imports" },
];

export default function ReportsPage() {
  const router = useRouter();
  const search = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const t = search.get("tab");
    return (TABS.find((x) => x.key === t)?.key ?? "snapshot") as TabKey;
  });
  const [range, setRange] = useState<RangeKey>(() => {
    const r = search.get("range");
    return (r as RangeKey) ?? "month";
  });
  const [customFrom, setCustomFrom] = useState<string>(search.get("from") ?? "");
  const [customTo, setCustomTo] = useState<string>(search.get("to") ?? "");
  const [tierBlocked, setTierBlocked] = useState<{ message: string; upgradeTo: string | null } | null>(null);
  const [reliability, setReliability] = useState<{ sections: unknown[]; generatedAt?: string }>({ sections: [] });
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsBadge, setAlertsBadge] = useState<number | null>(null);

  const tabsRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    snapshot: null, revenue: null, costs: null, pnl: null, membership: null, unit_economics: null, cash_flow: null, imports: null,
  });

  // Persist tab + range in the URL query so links are shareable.
  useEffect(() => {
    const params = new URLSearchParams();
    if (tab !== "snapshot") params.set("tab", tab);
    if (range !== "month") params.set("range", range);
    if (range === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    const qs = params.toString();
    router.replace(qs ? `/dashboard/reports?${qs}` : "/dashboard/reports", { scroll: false });
  }, [tab, range, customFrom, customTo, router]);

  // Load reliability strip data.
  useEffect(() => {
    fetch("/api/reports/reliability")
      .then(async (r) => {
        if (r.status === 403) {
          const body = await r.json().catch(() => ({}));
          if (body.code === "UPGRADE_REQUIRED") setTierBlocked({ message: body.error, upgradeTo: body.upgradeRequired });
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d) => {
        if (d) setReliability({ sections: d.sections ?? [], generatedAt: d.generatedAt });
      });
    // Alerts badge — owner-only endpoint. Silently ignore 403 for staff.
    fetch("/api/reports/alerts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.alerts) {
          const triggered = (d.alerts as Array<{ state: string }>).filter((a) => a.state === "TRIGGERED").length;
          setAlertsBadge(triggered);
        }
      })
      .catch(() => {});
  }, []);

  // Scroll the active tab into view on mount (mobile horizontal-scroll bar).
  useEffect(() => {
    const el = tabRefs.current[tab];
    if (el && tabsRef.current) {
      const rect = el.getBoundingClientRect();
      const barRect = tabsRef.current.getBoundingClientRect();
      const outOfView = rect.left < barRect.left + 12 || rect.right > barRect.right - 12;
      if (outOfView) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [tab]);

  if (tierBlocked) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
        <PageHeader title="Reports" description="Revenue, members, and attendance at a glance" />
        <EmptyState
          icon={<BarChart3 size={26} strokeWidth={1.75} />}
          title="Reports require a paid plan"
          description={tierBlocked.message}
          action={{
            label: `Upgrade to ${tierBlocked.upgradeTo ? tierBlocked.upgradeTo.charAt(0).toUpperCase() + tierBlocked.upgradeTo.slice(1) : "Growth"} →`,
            href: "/dashboard/settings/billing",
          }}
          className="bg-surface border border-app-border rounded-xl"
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <PageHeader
        title="Reports"
        description="Owner-first answers about the health of your club."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <RangeDropdown
              value={range}
              onChange={setRange}
              customFrom={customFrom}
              customTo={customTo}
              onCustomChange={(f, t) => {
                setCustomFrom(f);
                setCustomTo(t);
              }}
            />
            <button
              type="button"
              onClick={() => setAlertsOpen(true)}
              className="relative h-9 min-h-[44px] sm:min-h-9 flex items-center gap-1.5 px-3 border border-app-border rounded-lg bg-surface text-sm text-text-primary hover:bg-app-bg"
            >
              <Bell size={14} strokeWidth={2} />
              Alerts
              {alertsBadge != null && alertsBadge > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-accent text-white text-[10px] font-bold tabular-nums">
                  {alertsBadge}
                </span>
              )}
            </button>
            <a
              href="/api/reports/pnl/export?format=pdf"
              className="h-9 min-h-[44px] sm:min-h-9 flex items-center gap-1.5 px-3 border border-app-border rounded-lg bg-surface text-sm text-text-primary hover:bg-app-bg"
              title="Export current P&L as PDF"
            >
              <Download size={14} strokeWidth={2} />
              Export
            </a>
          </div>
        }
      />
      <AlertsDrawer open={alertsOpen} onClose={() => setAlertsOpen(false)} />

      <ReliabilityStrip
        sections={reliability.sections as Parameters<typeof ReliabilityStrip>[0]["sections"]}
        generatedAt={reliability.generatedAt}
      />

      {/* Tabs bar. Horizontal scroll below lg. */}
      <div
        ref={tabsRef}
        className="bg-surface border border-app-border rounded-xl mb-5 p-1 flex gap-1 overflow-x-auto relative"
        style={{ scrollBehavior: "smooth" }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => { tabRefs.current[t.key] = el; }}
            onClick={() => setTab(t.key)}
            className={`text-xs sm:text-sm px-3 py-2 rounded-md whitespace-nowrap font-medium transition-colors min-h-[44px] sm:min-h-0 flex items-center ${
              tab === t.key
                ? "bg-charcoal text-white"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "snapshot" && <SnapshotTab range={range} customFrom={customFrom} customTo={customTo} />}
      {tab === "revenue" && <RevenueTab range={range} customFrom={customFrom} customTo={customTo} />}
      {tab === "costs" && <CostsTab range={range} customFrom={customFrom} customTo={customTo} />}
      {tab === "pnl" && <PnlTab range={range} customFrom={customFrom} customTo={customTo} />}
      {tab === "membership" && <MembershipTab range={range} customFrom={customFrom} customTo={customTo} />}
      {tab === "unit_economics" && <UnitEconomicsTab range={range} customFrom={customFrom} customTo={customTo} />}
      {tab === "cash_flow" && <CashFlowTab range={range} customFrom={customFrom} customTo={customTo} />}
      {tab !== "snapshot" && tab !== "revenue" && tab !== "costs" && tab !== "pnl" && tab !== "membership" && tab !== "unit_economics" && tab !== "cash_flow" && <TabPlaceholder tabKey={tab} />}
    </div>
  );
}

function TabPlaceholder({ tabKey }: { tabKey: Exclude<TabKey, "snapshot" | "revenue" | "costs" | "pnl" | "membership" | "unit_economics" | "cash_flow"> }) {
  // Only "imports" remains — every other tab is handled above.
  if (tabKey === "imports") {
    return (
      <EmptyState
        icon={<BarChart3 size={26} strokeWidth={1.75} />}
        title="History & imports"
        description="Bring your history over from your previous system. Nothing is written until step 6, and every import is rollback-safe for 30 days."
        action={{ label: "Open imports →", href: "/dashboard/reports/imports" }}
        className="bg-surface border border-app-border rounded-xl"
      />
    );
  }
  return null;
}
