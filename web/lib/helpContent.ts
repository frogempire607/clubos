// Structured help/FAQ content. Pure data + a retrieval function so this can
// later back an AI assistant (the assistant would call the same `searchHelp`
// retrieval, then summarize). NO AI logic is implemented here — this is the
// knowledge base + keyword retrieval only.

export type HelpArticle = {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  body: string; // plain text; rendered with line breaks
};

export const HELP_CATEGORIES = [
  "Getting started",
  "Members",
  "Billing & payments",
  "Classes & events",
  "Attendance",
  "Financials & taxes",
  "Staff & permissions",
  "Migration",
  "Documents",
  "Troubleshooting",
] as const;

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "getting-started",
    title: "Setting up your club",
    category: "Getting started",
    keywords: ["setup", "start", "onboarding", "first", "begin", "new club"],
    body:
      "Work top-down: 1) Settings → Club profile (name, logo, colors). 2) Settings → Payments: connect Stripe so you can take card payments (cash works without it). 3) Create your memberships and pricing under Purchase Options. 4) Add classes and events. 5) Add or import members. The dashboard 'Setup progress' widget tracks what's left.",
  },
  {
    id: "add-members",
    title: "Adding and importing members",
    category: "Members",
    keywords: ["member", "add", "import", "csv", "roster", "prospect"],
    body:
      "Add one member from Members → + Add member. To bring a whole roster over, use Members → Import / Migrate — it accepts a flexible CSV (only a name is required) and can preserve legacy billing dates. Imported members are never auto-charged; they activate and add payment themselves via a secure link.",
  },
  {
    id: "memberships-billing",
    title: "Memberships, trials, and recurring billing",
    category: "Billing & payments",
    keywords: ["membership", "subscription", "recurring", "trial", "billing", "price", "plan"],
    body:
      "Create plans under Purchase Options → Memberships with one or more billing options (weekly/monthly/etc). Optional free trials hold the first Stripe charge until the trial ends. Assigning a membership manually flips the member to ACTIVE; canceling their last active subscription flips them back to INACTIVE.",
  },
  {
    id: "processing-fees",
    title: "Passing Stripe processing fees to customers",
    category: "Billing & payments",
    keywords: ["processing fee", "stripe fee", "surcharge", "pass fee", "2.9"],
    body:
      "AthletixOS charges 0% platform fee on every plan. If you want members to cover Stripe's processing fee, enable 'Pass processing fees to customer' on Settings → Payments. The fee is shown transparently at checkout with a clear breakdown before they pay.",
  },
  {
    id: "cash-payments",
    title: "Recording cash, comp, and invoice payments",
    category: "Financials & taxes",
    keywords: ["cash", "comp", "free", "invoice", "manual", "no stripe", "drop-in"],
    body:
      "Cash never requires Stripe. Record it from Financials → Money In → Record payment, or at the door from Attendance (Cash / Comp). Choose Cash, Comp/Free, or Invoice (unpaid). Reports separate Card/online, Cash/check, Comp/free, and Invoiced(unpaid) so your numbers stay honest. Comp is tracked but never counted as revenue.",
  },
  {
    id: "non-member-attendance",
    title: "Charging non-members at attendance",
    category: "Attendance",
    keywords: ["drop-in", "trial", "guest", "non-member", "walk-in", "attendance fee"],
    body:
      "On a class session, search the person (or + Add a brand-new member to create a quick prospect), then use 'Cash / Comp' to record a drop-in, trial, guest, or custom one-time charge — Cash, Comp/Free, or Invoice. 'Register (card)' takes a Stripe payment instead. Every option also records attendance.",
  },
  {
    id: "financial-os",
    title: "Financial OS: entities, receipts, and tax summaries",
    category: "Financials & taxes",
    keywords: ["financial", "tax", "report", "receipt", "entity", "p&l", "expenses", "donations", "accountant"],
    body:
      "Financials is a lightweight money tracker (not full accounting). Tag transactions and expenses to a legal entity, attach receipts to expenses, and use the Tax Summary tab for P&L, revenue/expenses by category, donations, contractor payments, and a year-end CSV package. These are tax-ready summaries to share with your accountant — AthletixOS does not file taxes.",
  },
  {
    id: "donations",
    title: "Tracking donations for a nonprofit entity",
    category: "Financials & taxes",
    keywords: ["donation", "donor", "nonprofit", "foundation", "restricted", "sponsorship", "giving"],
    body:
      "If a legal entity's type is Nonprofit, use Financials → Donations to record gifts with donor name/email, fund/purpose, restricted vs unrestricted, and sponsorships. Attach receipts and export a donor CSV / year-end giving summary.",
  },
  {
    id: "staff-permissions",
    title: "Staff roles and permissions",
    category: "Staff & permissions",
    keywords: ["staff", "permission", "role", "access", "restrict", "coach login"],
    body:
      "Invite staff from Staff → Directory. Each staff member has 10 configurable permissions (members, attendance, classes, events, schedule, messaging, documents, finances, reports, staff). The sidebar and pages they see are filtered to what they're allowed. Owners always have full access. Permission changes take effect the next time that staff member logs in.",
  },
  {
    id: "contractors",
    title: "Guest coaches and contractors",
    category: "Staff & permissions",
    keywords: ["contractor", "guest coach", "referee", "1099", "w9", "payout"],
    body:
      "Staff → Guest & Contractors holds lightweight records (no login) for referees, guest clinicians, photographers, etc. Log payments, attach a W-9, export payment history for accounting, and optionally convert a contractor into a full staff account later.",
  },
  {
    id: "schedule-occurrence",
    title: "Editing one class occurrence (substitute coach, time change)",
    category: "Classes & events",
    keywords: ["schedule", "substitute", "sub coach", "cancel class", "one occurrence", "recurring"],
    body:
      "On Staff → Schedule, edit a single class with scope 'This occurrence', 'This & following', or 'Entire series' — like a calendar app. Use it to swap a coach for one practice, change a time, add a note, or cancel one session without touching the whole recurring series. Attendance and per-occurrence edits are preserved when the series regenerates.",
  },
  {
    id: "documents",
    title: "Waivers, policies, and signatures",
    category: "Documents",
    keywords: ["document", "waiver", "sign", "signature", "policy", "guardian"],
    body:
      "Create required documents under Documents with an optional re-sign frequency. Members (or guardians for minors) sign in their portal; the Signatures audit modal shows who signed, when, IP, and validity. Guardian-required docs block minors from self-signing.",
  },
  {
    id: "global-search",
    title: "Using global search",
    category: "Getting started",
    keywords: ["search", "find", "shortcut", "command", "cmd k"],
    body:
      "Use the search bar at the top of the dashboard (or press ⌘K / Ctrl+K) to jump to members, staff, classes, events, products, memberships, documents, and messages. Results deep-link straight to the right page. Your recent searches are remembered on this device.",
  },
  {
    id: "stripe-troubleshooting",
    title: "Payments aren't going through",
    category: "Troubleshooting",
    keywords: ["stripe", "payment failed", "not working", "checkout", "webhook", "connect"],
    body:
      "Check Settings → Payments shows Stripe 'Connected' with charges + payouts enabled. Use Settings → Diagnostics to see the env checklist and recent webhook events. Cash/comp/invoice always work without Stripe — only card/online needs Connect.",
  },
];

// Keyword + text retrieval. Returns articles ranked by relevance. This is the
// exact retrieval an AI assistant would call before answering.
export function searchHelp(query: string, limit = 8): HelpArticle[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);

  const scored = HELP_ARTICLES.map((a) => {
    const title = a.title.toLowerCase();
    const body = a.body.toLowerCase();
    const kw = a.keywords.join(" ").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 5;
      if (kw.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }
    if (title.includes(q)) score += 4;
    return { a, score };
  })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.a);

  return scored;
}
