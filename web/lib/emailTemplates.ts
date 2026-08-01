// Seed content + helpers for the 14 stock EmailTemplate rows (plan §3C).
//
// Templates are seeded LAZILY on the first fetch of the templates list
// per club. Rationale: adding a new club shouldn't do bulk writes, and
// running a global backfill would race with the schema deploy. On first
// open we upsert once and set isSystem=true so the owner can't destroy
// the reference copy (they can archive it, they can duplicate it, they
// can't hard-delete it).
//
// Every seeded template ships with a club-default HEADER (LogoBlock at
// top) and FOOTER (ContactBlock at bottom). Renders auto-insert the
// club's own logo + contact info at send time — see lib/emailRender.ts.
// Owners edit the body between; they don't have to keep re-adding the
// header/footer per template.
//
// Bodies are stored as EmailBlock[] JSON. On seed we compute bodyHtml
// so the templates page can preview immediately, but bodyHtml is a
// convenience snapshot — the CANONICAL representation is bodyJson.

import type { EmailBlock, HeadingBlock, ParagraphBlock, LogoBlock, ContactBlock, ButtonBlock } from "@/lib/emailBlocks";

export interface StockTemplate {
  kind: string;
  name: string;
  description: string;
  subject: string;
  previewText: string;
  blocks: EmailBlock[];
}

// The 14 stock kinds enumerated in plan §3C. Kind is stable — owners
// clone-and-rename to create their own variants; the kind on the clone
// switches to CUSTOM. Renaming the stock kind is deliberately hard.
export const STOCK_TEMPLATE_KINDS = [
  "GENERAL_ANNOUNCEMENT",
  "PRACTICE_CANCELLATION",
  "SCHEDULE_CHANGE",
  "EVENT_REGISTRATION",
  "CAMP_PROMOTION",
  "MEMBERSHIP_EXPIRATION",
  "PAYMENT_REMINDER",
  "MIGRATION_INVITATION",
  "WELCOME_EMAIL",
  "FREE_TRIAL_FOLLOWUP",
  "WEATHER_CLOSURE",
  "TOURNAMENT_INFORMATION",
  "FUNDRAISING_ANNOUNCEMENT",
  "BLANK",
] as const;

// Standard header — same across every stock template. width=160 with
// height auto so the logo preserves aspect ratio (see the M22-era logo
// aspect-ratio fix in lib/emailRender.ts). Rendering swaps in the
// club's own logo URL via publicClubLogoUrl(); if the club has no logo
// the AthletixOS wordmark is the fallback.
const HEADER: LogoBlock = { type: "logo", align: "left", width: 160 };

// Standard footer — name / email / phone / address. Renderers pull the
// values from Club.publicEmail || contactEmail, publicPhone || contactPhone,
// and mailing* per the M21 fallback contract, so nothing hardcoded here.
const FOOTER: ContactBlock = {
  type: "contact",
  fields: ["name", "email", "phone", "address"],
};

function heading(text: string, level: 1 | 2 | 3 = 1): HeadingBlock {
  return { type: "heading", level, text, align: "left" };
}
function para(text: string): ParagraphBlock {
  return { type: "paragraph", align: "left", runs: [{ kind: "text", text }] };
}
function button(text: string, href: string, color: "brand" | "charcoal" | "lime" | "orange" = "brand"): ButtonBlock {
  return { type: "button", text, href, align: "left", color };
}

function body(...middle: EmailBlock[]): EmailBlock[] {
  return [HEADER, ...middle, FOOTER];
}

export const STOCK_TEMPLATES: StockTemplate[] = [
  {
    kind: "GENERAL_ANNOUNCEMENT",
    name: "General Announcement",
    description: "A flexible starting point for any club-wide update.",
    subject: "An update from {{club_name}}",
    previewText: "News from your club.",
    blocks: body(
      heading("Hi {{member_first_name}},"),
      para("Write your message here. Use blocks above to add lists, buttons, or links."),
      para("Thanks,\nThe {{club_name}} team"),
    ),
  },
  {
    kind: "PRACTICE_CANCELLATION",
    name: "Practice Cancellation",
    description: "Sent when a single practice or session is called off.",
    subject: "{{class_name}} is canceled tonight",
    previewText: "No practice tonight, back on schedule next session.",
    blocks: body(
      heading("Practice canceled"),
      para("Hi {{member_first_name}}, tonight's {{class_name}} is canceled. Regular schedule resumes next session."),
      para("Sorry for the short notice — see you soon."),
    ),
  },
  {
    kind: "SCHEDULE_CHANGE",
    name: "Schedule Change",
    description: "Announce a schedule change or program adjustment.",
    subject: "Schedule update — {{class_name}}",
    previewText: "New times starting soon.",
    blocks: body(
      heading("Heads up — the schedule is changing"),
      para("Hi {{member_first_name}}, {{class_name}} is moving. Here are the new details:"),
      { type: "list", style: "bulleted", items: [
        [{ kind: "text", text: "New time: (fill in)" }],
        [{ kind: "text", text: "Effective: (fill in)" }],
        [{ kind: "text", text: "Location: (fill in)" }],
      ] },
      para("Reply to this email with questions."),
    ),
  },
  {
    kind: "EVENT_REGISTRATION",
    name: "Event Registration",
    description: "Invite members to register for an upcoming event.",
    subject: "Register now — {{event_name}}",
    previewText: "Grab your spot before it fills.",
    blocks: body(
      heading("{{event_name}}"),
      para("Hi {{member_first_name}}, registration is open. Spots are limited — reserve yours now."),
      button("Register now", "{{registration_link}}"),
      para("Full details are on the registration page."),
    ),
  },
  {
    kind: "CAMP_PROMOTION",
    name: "Camp Promotion",
    description: "Promote an upcoming camp, clinic, or intensive.",
    subject: "Coming soon: {{event_name}} — sign up now",
    previewText: "Small groups, real coaching, quick sellout.",
    blocks: body(
      heading("Coming soon — {{event_name}}"),
      para("Hi {{member_first_name}}, we're running {{event_name}} with {{coach_name}}. Small groups, real coaching, quick sellout every year."),
      button("Reserve your spot", "{{registration_link}}"),
      para("Any questions? Reply to this email or call the club."),
    ),
  },
  {
    kind: "MEMBERSHIP_EXPIRATION",
    name: "Membership Expiration",
    description: "Remind a member their membership is ending soon.",
    subject: "Your {{membership_name}} ends {{membership_end_date}}",
    previewText: "Renew to keep training without interruption.",
    blocks: body(
      heading("Hi {{guardian_first_name}},"),
      para("{{athlete_first_name}}'s {{membership_name}} expires on {{membership_end_date}}. Renew to keep training without a gap."),
      button("Renew now", "{{payment_link}}"),
      para("Questions? Reply here — we'll take care of it."),
    ),
  },
  {
    kind: "PAYMENT_REMINDER",
    name: "Payment Reminder",
    description: "Nudge a payer about an outstanding balance.",
    subject: "A friendly reminder — outstanding balance",
    previewText: "Quick note about your account.",
    blocks: body(
      heading("Hi {{guardian_first_name}},"),
      para("This is a friendly reminder that {{athlete_first_name}}'s account has an outstanding balance of {{outstanding_balance}}."),
      button("Pay now", "{{payment_link}}"),
      para("If you've already sent payment, thank you — you can ignore this note."),
    ),
  },
  {
    kind: "MIGRATION_INVITATION",
    name: "Migration Invitation",
    description: "Invite a member to complete their profile in the new system.",
    subject: "Set up your {{club_name}} account",
    previewText: "One quick step and you're done.",
    blocks: body(
      heading("Welcome to your new club portal"),
      para("Hi {{member_first_name}}, we've moved to a new system. Set up your account in about two minutes — no re-enrollment, no changes to your billing."),
      button("Set up your account", "{{migration_link}}"),
      para("This link is unique to you. Please don't forward it."),
    ),
  },
  {
    kind: "WELCOME_EMAIL",
    name: "Welcome Email",
    description: "Introduce a new member to the club.",
    subject: "Welcome to {{club_name}}",
    previewText: "Everything you need to get started.",
    blocks: body(
      heading("Welcome to {{club_name}}"),
      para("Hi {{member_first_name}}, we're glad you're here. Here's what to expect in your first week:"),
      { type: "list", style: "numbered", items: [
        [{ kind: "text", text: "Check the schedule and book your first class." }],
        [{ kind: "text", text: "Meet your coach: {{coach_name}}." }],
        [{ kind: "text", text: "Reach out any time — we're at the number and address below." }],
      ] },
      para("See you at the gym."),
    ),
  },
  {
    kind: "FREE_TRIAL_FOLLOWUP",
    name: "Free Trial Follow-Up",
    description: "Follow up with a trial member and invite them to sign up.",
    subject: "How was your trial at {{club_name}}?",
    previewText: "Ready to keep going?",
    blocks: body(
      heading("How was your first session?"),
      para("Hi {{member_first_name}}, thanks for training with us. When you're ready to sign up, we've got you."),
      button("See memberships", "{{registration_link}}"),
      para("Have questions? Reply here — we'll answer today."),
    ),
  },
  {
    kind: "WEATHER_CLOSURE",
    name: "Weather Closure",
    description: "Notify members of a weather-related closure.",
    subject: "{{club_name}} is closed today",
    previewText: "Stay safe — regular schedule resumes tomorrow.",
    blocks: body(
      heading("The club is closed today"),
      para("Hi {{member_first_name}}, we're closed today due to weather. Regular schedule resumes tomorrow."),
      para("Stay warm and safe."),
    ),
  },
  {
    kind: "TOURNAMENT_INFORMATION",
    name: "Tournament Information",
    description: "Share tournament logistics with registered athletes.",
    subject: "Tournament info — {{event_name}}",
    previewText: "Everything you need to know before Saturday.",
    blocks: body(
      heading("{{event_name}} — logistics"),
      para("Hi {{guardian_first_name}}, here's what {{athlete_first_name}} needs to know for {{event_name}}:"),
      { type: "list", style: "bulleted", items: [
        [{ kind: "text", text: "Arrive by: (fill in)" }],
        [{ kind: "text", text: "Bring: (fill in)" }],
        [{ kind: "text", text: "Weigh-in / check-in: (fill in)" }],
        [{ kind: "text", text: "Team meeting: (fill in)" }],
      ] },
      para("Coach on-site: {{coach_name}}. Text with questions."),
    ),
  },
  {
    kind: "FUNDRAISING_ANNOUNCEMENT",
    name: "Fundraising Announcement",
    description: "Kick off a fundraiser or ask for support.",
    subject: "Support {{club_name}} — new fundraiser is live",
    previewText: "Every dollar goes back to the athletes.",
    blocks: body(
      heading("Help us keep it going"),
      para("Hi {{member_first_name}}, we've launched a fundraiser and every dollar goes back to the athletes."),
      button("Contribute", "{{payment_link}}"),
      para("Thank you for being part of this club."),
    ),
  },
  {
    kind: "BLANK",
    name: "Blank Template",
    description: "Start from scratch — header + footer only.",
    subject: "",
    previewText: "",
    blocks: body(
      para("Write your message here…"),
    ),
  },
];

// System templates the seeder writes as isSystem=true. Owner can archive
// but not hard-delete these; the templates page always offers "Duplicate"
// so a system template becomes a CUSTOM copy the owner can edit freely.
export function isStockKind(kind: string): boolean {
  return (STOCK_TEMPLATE_KINDS as readonly string[]).includes(kind);
}
