"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BarChart3, Download } from "lucide-react";
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
              disabled
              title="CSV / PDF export ships with P&L in Phase 2.5.4"
              className="h-9 min-h-[44px] sm:min-h-9 flex items-center gap-1.5 px-3 border border-app-border rounded-lg bg-surface text-sm text-text-muted opacity-60"
            >
              <Download size={14} strokeWidth={2} />
              Export
            </button>
          </div>
        }
      />

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
      {tab !== "snapshot" && tab !== "revenue" && tab !== "costs" && tab !== "pnl" && tab !== "membership" && tab !== "unit_economics" && <TabPlaceholder tabKey={tab} />}
    </div>
  );
}

function TabPlaceholder({ tabKey }: { tabKey: Exclude<TabKey, "snapshot" | "revenue" | "costs" | "pnl" | "membership" | "unit_economics"> }) {
  const messages: Record<Exclude<TabKey, "snapshot" | "revenue" | "costs" | "pnl" | "membership" | "unit_economics">, { title: string; sub: string; phase: string }> = {
    cash_flow: { title: "Cash flow coming soon", sub: "Waterfall, operating/investing/financing, forecast.", phase: "Phase 2.5.7" },
    imports: { title: "Import wizard coming soon", sub: "Seven-step CSV importer for pre-AthletixOS history.", phase: "Phase 2.5.10" },
  };
  const m = messages[tabKey];
  return (
    <EmptyState
      icon={<BarChart3 size={26} strokeWidth={1.75} />}
      title={m.title}
      description={`${m.sub} (${m.phase})`}
      className="bg-surface border border-app-border rounded-xl"
    />
  );
}
