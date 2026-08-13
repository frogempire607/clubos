// Fixtures for browser-testing the batch results screens.
//
// Three batches, chosen to cover the three states the list has to
// distinguish and the two lies the detail page must refuse to tell:
//
//   batch-clean     — a Resend send: trackable, some opens, nothing wrong
//   batch-problems  — a bounce + a provider failure + every skip reason
//   batch-draining  — half dispatched, half still QUEUED (the 3M path)
//   batch-untracked — SMTP-only: delivered, but NO open can ever arrive,
//                     so the page must say "not tracked", never "0% opened"
//
// Run against the throwaway local Postgres only:
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos npx tsx scripts/seed-email-results-browser-test.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const clubId = "club_local";
const ago = (mins: number) => new Date(Date.now() - mins * 60_000);

interface Spec {
  batch: string;
  subject: string;
  kind: string;
  minutesAgo: number;
  rows: Array<{
    email: string;
    memberId?: string;
    status: string;
    skippedReason?: string;
    error?: string;
    providerMessageId?: string;
    delivered?: boolean;
    opened?: boolean;
    openCount?: number;
    clicked?: boolean;
    bounced?: boolean;
  }>;
}

const SPECS: Spec[] = [
  {
    batch: "batch-clean",
    subject: "Summer schedule is live",
    kind: "BULK",
    minutesAgo: 60,
    rows: [
      { email: "ann@local.test", status: "SENT", providerMessageId: "pm-c1", delivered: true, opened: true, openCount: 3, clicked: true },
      { email: "ben@local.test", status: "SENT", providerMessageId: "pm-c2", delivered: true, opened: true },
      { email: "fern@local.test", status: "SENT", providerMessageId: "pm-c3", delivered: true },
      { email: "gus@local.test", status: "SENT", providerMessageId: "pm-c4", delivered: true },
    ],
  },
  {
    batch: "batch-problems",
    subject: "MS/HS price change — effective September",
    kind: "BULK",
    minutesAgo: 180,
    rows: [
      { email: "ann@local.test", status: "SENT", providerMessageId: "pm-p1", delivered: true, opened: true },
      { email: "bounce@local.test", status: "SENT", providerMessageId: "pm-p2", bounced: true },
      { email: "broken@local.test", status: "FAILED", error: "550 mailbox unavailable" },
      { email: "noemail@local.test", status: "SKIPPED", skippedReason: "NO_EMAIL" },
      { email: "optout@local.test", status: "SKIPPED", skippedReason: "OPTED_OUT" },
      { email: "bad@@local.test", status: "SKIPPED", skippedReason: "INVALID_ADDRESS" },
      { email: "ann@local.test", status: "SKIPPED", skippedReason: "DUPLICATE_IN_BATCH" },
    ],
  },
  {
    batch: "batch-draining",
    subject: "Tournament weekend logistics",
    kind: "BULK",
    minutesAgo: 4,
    rows: [
      { email: "ann@local.test", status: "SENT", providerMessageId: "pm-d1", delivered: true },
      { email: "ben@local.test", status: "SENT", providerMessageId: "pm-d2" },
      { email: "fern@local.test", status: "QUEUED" },
      { email: "gus@local.test", status: "QUEUED" },
      { email: "hal@local.test", status: "QUEUED" },
    ],
  },
  {
    batch: "batch-untracked",
    subject: "Gym closed Monday",
    kind: "BULK",
    minutesAgo: 600,
    rows: [
      { email: "ann@local.test", status: "SENT", delivered: true },
      { email: "ben@local.test", status: "SENT", delivered: true },
      { email: "fern@local.test", status: "SENT", delivered: true },
    ],
  },
];

async function main() {
  if (!process.env.DATABASE_URL?.includes("55432")) {
    throw new Error("Refusing to run outside the local throwaway Postgres (port 55432).");
  }

  const owner = await prisma.user.findFirst({
    where: { clubId, role: "OWNER" },
    select: { id: true },
  });

  await prisma.emailSend.deleteMany({
    where: { clubId, sendBatchId: { in: SPECS.map((s) => s.batch) } },
  });

  for (const spec of SPECS) {
    const at = ago(spec.minutesAgo);
    let i = 0;
    for (const r of spec.rows) {
      i++;
      await prisma.emailSend.create({
        data: {
          clubId,
          kind: spec.kind,
          recipientEmail: r.email,
          recipientMemberId: r.memberId ?? null,
          subject: spec.subject,
          bodyHtml: `<p>${spec.subject}</p>`,
          bodyText: spec.subject,
          fromName: "Frog Empire Wrestling",
          status: r.status,
          skippedReason: r.skippedReason ?? null,
          error: r.error ?? null,
          providerMessageId: r.providerMessageId ?? null,
          sendBatchId: spec.batch,
          dedupeKey: `${spec.batch}-${i}`,
          sentByUserId: owner?.id ?? null,
          queuedAt: at,
          sentAt: r.status === "SENT" ? at : null,
          deliveredAt: r.delivered ? new Date(at.getTime() + 30_000) : null,
          bouncedAt: r.bounced ? new Date(at.getTime() + 45_000) : null,
          openedAt: r.opened ? new Date(at.getTime() + 300_000) : null,
          openCount: r.openCount ?? (r.opened ? 1 : 0),
          clickedAt: r.clicked ? new Date(at.getTime() + 360_000) : null,
          clickCount: r.clicked ? 1 : 0,
        },
      });
    }
    console.log(`seeded ${spec.batch}: ${spec.rows.length} rows`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
