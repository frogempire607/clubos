import type { Prisma } from "@prisma/client";

export type CampaignRangeKey = "last_30" | "last_90" | "month" | "ytd";

export const LEAD_SOURCES = [
  { key: "CLIENT_PORTAL", label: "Client Portal" },
  { key: "ADDED_BY_STAFF", label: "Added by Staff" },
  { key: "WEBSITE", label: "Website" },
  { key: "INSTAGRAM", label: "Instagram" },
  { key: "FACEBOOK", label: "Facebook" },
  { key: "REFERRAL", label: "Referral" },
  { key: "MANUAL", label: "Manual" },
  { key: "UNKNOWN", label: "Unknown" },
] as const;

export const LEAD_STAGES = [
  { key: "NEW", label: "New" },
  { key: "WARM", label: "Warm" },
  { key: "HOT", label: "Hot" },
  { key: "WON", label: "Won" },
  { key: "LOST", label: "Lost" },
] as const;

export const CAMPAIGN_TYPES = [
  "Win Back",
  "Intro Offer",
  "Referral Push",
  "Tournament Promo",
  "Membership Drive",
  "Event Promotion",
  "Trial Conversion",
  "Attendance Recovery",
] as const;

export const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "SCHEDULED", "COMPLETED"] as const;

export type CampaignKpi = {
  key: string;
  label: string;
  value: number;
  format: "number" | "money";
  delta: number | null;
  helper: string;
};

export type SourceMetric = {
  key: string;
  label: string;
  count: number;
  recurringRevenue: number;
  totalRevenue: number;
  conversionRate: number;
};

export type StageMetric = {
  key: string;
  label: string;
  count: number;
  progressionRate: number;
};

export type CampaignSummary = {
  id: string;
  name: string;
  type: string;
  status: string;
  startAt: string | null;
  endAt: string | null;
  attributedRevenue: number;
  attributedLeads: number;
};

export type CampaignOverview = {
  range: {
    key: CampaignRangeKey;
    label: string;
    start: string;
    end: string;
  };
  kpis: CampaignKpi[];
  sources: SourceMetric[];
  stages: StageMetric[];
  campaigns: CampaignSummary[];
  notes: string[];
};

type RangeResult = {
  key: CampaignRangeKey;
  label: string;
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
};

type MemberRow = {
  id: string;
  status: string;
  joinedAt: Date;
  leadSource: string;
  leadStage: string;
};

type TransactionRow = {
  id: string;
  memberId: string | null;
  amount: Prisma.Decimal;
  type: string;
  category: string | null;
  createdAt: Date;
};

export function resolveCampaignRange(input: string | null): RangeResult {
  const key = (["last_30", "last_90", "month", "ytd"].includes(input || "")
    ? input
    : "last_30") as CampaignRangeKey;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (key === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { key, label: "This month", start, end: now, prevStart, prevEnd: start };
  }

  if (key === "last_90") {
    const start = new Date(today.getTime() - 90 * 86400000);
    const prevStart = new Date(today.getTime() - 180 * 86400000);
    return { key, label: "Last 90 days", start, end: now, prevStart, prevEnd: start };
  }

  if (key === "ytd") {
    const start = new Date(now.getFullYear(), 0, 1);
    const prevStart = new Date(now.getFullYear() - 1, 0, 1);
    return { key, label: "Year to date", start, end: now, prevStart, prevEnd: start };
  }

  const start = new Date(today.getTime() - 30 * 86400000);
  const prevStart = new Date(today.getTime() - 60 * 86400000);
  return { key: "last_30", label: "Last 30 days", start, end: now, prevStart, prevEnd: start };
}

export function normalizeLeadSource(value: string | null | undefined): string {
  const raw = (value || "UNKNOWN").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return LEAD_SOURCES.some((s) => s.key === raw) ? raw : "UNKNOWN";
}

export function inferLeadStage(member: Pick<MemberRow, "status" | "leadStage">, hasRevenue: boolean): string {
  const explicit = (member.leadStage || "").trim().toUpperCase();
  if (LEAD_STAGES.some((s) => s.key === explicit) && explicit !== "NEW") return explicit;
  if (member.status === "ACTIVE") return "WON";
  if (member.status === "INACTIVE") return "LOST";
  if (member.status === "PAUSED") return "WARM";
  return hasRevenue ? "HOT" : "NEW";
}

export function buildCampaignOverview(params: {
  range: RangeResult;
  members: MemberRow[];
  currentTransactions: TransactionRow[];
  previousTransactions: TransactionRow[];
  historicalTransactions: TransactionRow[];
  campaigns: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    startAt: Date | null;
    endAt: Date | null;
    attributions: Array<{ memberId: string | null; revenueAmount: Prisma.Decimal | null; transaction: { amount: Prisma.Decimal } | null }>;
  }>;
}): CampaignOverview {
  const { range, members, currentTransactions, previousTransactions, historicalTransactions, campaigns } = params;
  const membersById = new Map(members.map((member) => [member.id, member]));
  const currentMemberIds = new Set(currentTransactions.map((tx) => tx.memberId).filter(Boolean) as string[]);
  const previousMemberIds = new Set(previousTransactions.map((tx) => tx.memberId).filter(Boolean) as string[]);
  const historicalMemberIds = new Set(historicalTransactions.map((tx) => tx.memberId).filter(Boolean) as string[]);

  const currentRevenue = sumTransactions(currentTransactions);
  const previousRevenue = sumTransactions(previousTransactions);
  const newLeads = members.filter((member) => inRange(member.joinedAt, range.start, range.end)).length;
  const previousLeads = members.filter((member) => inRange(member.joinedAt, range.prevStart, range.prevEnd)).length;

  const introOffersSold = currentTransactions.filter((tx) => {
    const label = `${tx.type} ${tx.category || ""}`.toLowerCase();
    const member = tx.memberId ? membersById.get(tx.memberId) : null;
    return label.includes("intro") || (member ? inRange(member.joinedAt, range.start, range.end) : false);
  }).length;
  const previousIntroOffersSold = previousTransactions.filter((tx) => {
    const label = `${tx.type} ${tx.category || ""}`.toLowerCase();
    const member = tx.memberId ? membersById.get(tx.memberId) : null;
    return label.includes("intro") || (member ? inRange(member.joinedAt, range.prevStart, range.prevEnd) : false);
  }).length;

  const firstTimeBookings = Array.from(currentMemberIds).filter((memberId) => !historicalMemberIds.has(memberId)).length;
  const clientsWonBack = Array.from(currentMemberIds).filter((memberId) => {
    const member = membersById.get(memberId);
    return member && member.joinedAt < range.start && !previousMemberIds.has(memberId);
  }).length;

  const sourceRows = LEAD_SOURCES.map((source) => {
    const sourceMembers = members.filter((member) => normalizeLeadSource(member.leadSource) === source.key);
    const ids = new Set(sourceMembers.map((member) => member.id));
    const txs = currentTransactions.filter((tx) => tx.memberId && ids.has(tx.memberId));
    const recurringTxs = txs.filter((tx) => {
      const label = `${tx.type} ${tx.category || ""}`.toLowerCase();
      return label.includes("membership") || label.includes("subscription") || label.includes("recurring");
    });
    const converted = sourceMembers.filter((member) => member.status === "ACTIVE" || currentMemberIds.has(member.id)).length;

    return {
      key: source.key,
      label: source.label,
      count: sourceMembers.length,
      recurringRevenue: roundCurrency(sumTransactions(recurringTxs)),
      totalRevenue: roundCurrency(sumTransactions(txs)),
      conversionRate: sourceMembers.length ? Math.round((converted / sourceMembers.length) * 100) : 0,
    };
  });

  const stageRows = LEAD_STAGES.map((stage, index) => {
    const count = members.filter((member) => inferLeadStage(member, currentMemberIds.has(member.id)) === stage.key).length;
    const previousCount = index === 0 ? members.length : stageRowsSafeCount(members, currentMemberIds, index - 1);
    return {
      key: stage.key,
      label: stage.label,
      count,
      progressionRate: previousCount ? Math.round((count / previousCount) * 100) : 0,
    };
  });

  const campaignRows = campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    type: campaign.type,
    status: campaign.status,
    startAt: campaign.startAt?.toISOString() ?? null,
    endAt: campaign.endAt?.toISOString() ?? null,
    attributedRevenue: roundCurrency(
      campaign.attributions.reduce((total, attribution) => {
        return total + Number(attribution.revenueAmount ?? attribution.transaction?.amount ?? 0);
      }, 0),
    ),
    attributedLeads: new Set(campaign.attributions.map((a) => a.memberId).filter(Boolean)).size,
  }));

  const marketingRevenue = sourceRows
    .filter((source) => source.key !== "UNKNOWN")
    .reduce((total, source) => total + source.totalRevenue, 0);

  return {
    range: {
      key: range.key,
      label: range.label,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    kpis: [
      {
        key: "new_leads",
        label: "New Leads",
        value: newLeads,
        format: "number",
        delta: percentDelta(newLeads, previousLeads),
        helper: "Members added in this period.",
      },
      {
        key: "intro_offers_sold",
        label: "Intro Offers Sold",
        value: introOffersSold,
        format: "number",
        delta: percentDelta(introOffersSold, previousIntroOffersSold),
        helper: "Intro-labeled purchases plus new-client first purchases.",
      },
      {
        key: "first_time_bookings",
        label: "First Time Bookings",
        value: firstTimeBookings,
        format: "number",
        delta: null,
        helper: "Members with their first successful payment in this period.",
      },
      {
        key: "clients_won_back",
        label: "Clients Won Back",
        value: clientsWonBack,
        format: "number",
        delta: null,
        helper: "Returning clients with new revenue after a quiet previous period.",
      },
      {
        key: "marketing_revenue",
        label: "Marketing Revenue",
        value: roundCurrency(marketingRevenue || currentRevenue),
        format: "money",
        delta: percentDelta(currentRevenue, previousRevenue),
        helper: "Attributed to known sources, falling back to current revenue until campaigns are linked.",
      },
    ],
    sources: sourceRows,
    stages: stageRows,
    campaigns: campaignRows,
    notes: [
      "Lead source and stage fields are now stored on members for future owner editing.",
      "Campaign attribution records can link campaigns to members and transactions without tying the feature to email only.",
      "SMS and push are shown as future-ready channels, not live delivery systems.",
    ],
  };
}

function inRange(value: Date, start: Date, end: Date): boolean {
  return value >= start && value < end;
}

function sumTransactions(rows: TransactionRow[]): number {
  return rows.reduce((total, tx) => total + Number(tx.amount), 0);
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

function stageRowsSafeCount(members: MemberRow[], currentMemberIds: Set<string>, index: number): number {
  const stage = LEAD_STAGES[index];
  if (!stage) return members.length;
  return members.filter((member) => inferLeadStage(member, currentMemberIds.has(member.id)) === stage.key).length;
}
