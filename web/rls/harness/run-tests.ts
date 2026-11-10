/* ═══════════════════════════════════════════════════════════════════════════
 * Two-club RLS isolation proof.
 *
 * What this does, end to end, on a THROWAWAY local Postgres (never Supabase):
 *   1. Boots an embedded Postgres cluster in ./.pgdata (wiped each run).
 *   2. Applies every migration in web/prisma/migrations in order — including
 *      20260702000000_enable_rls — i.e. the exact SQL production will run.
 *   3. Creates the RLS-enforced `athletix_app` role (mirrors setup-app-role.sql).
 *   4. Seeds Club A and Club B (users, members, memberships, subscriptions,
 *      events, sessions, bookings, transactions, documents, signatures).
 *   5. Runs a cross-tenant matrix through the REAL wrapper
 *      (web/lib/tenantPrisma.ts → createTenantFactory / tenantTransactionOn /
 *      assertRlsEnforced): Club A must never READ, INSERT, UPDATE or DELETE
 *      Club B data — plus fail-closed, raw-SQL, concurrency and completeness
 *      checks.
 *
 * Run:  cd web/rls/harness && npm install && npm test
 * Exit code 0 = all proofs passed.
 * ═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pgpkg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  createTenantFactory,
  tenantTransactionOn,
  assertRlsEnforced,
} from "../../lib/tenantPrisma";

const { Pool, Client } = pgpkg;
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55433;
const SUPER = { user: "postgres", password: "pgpass" };
const APP = { user: "athletix_app", password: "apppass" };
const DB = "athletix_rls_test";

// ── tiny test runner ─────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function throws(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    ok(false, name, "expected an error but the operation SUCCEEDED");
  } catch (e: any) {
    const msg = `${e?.code ?? ""} ${e?.message ?? e}`;
    if (match && !match.test(msg)) ok(false, name, `wrong error: ${msg.slice(0, 200)}`);
    else ok(true, name);
  }
}

async function main() {
  // ── 1. throwaway cluster ───────────────────────────────────────────────────
  const dataDir = path.join(here, ".pgdata");
  fs.rmSync(dataDir, { recursive: true, force: true });
  const epg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: SUPER.user,
    password: SUPER.password,
    port: PORT,
    persistent: false,
  });
  await epg.initialise();
  await epg.start();
  console.log(`[harness] embedded postgres up on :${PORT}`);

  try {
    await epg.createDatabase(DB);

    // ── 2. apply the repo's real migrations, in order ─────────────────────────
    const su = new Client({ host: "localhost", port: PORT, database: DB, ...SUPER });
    su.on("error", () => {}); // teardown races must never mask a real failure
    await su.connect();
    const migRoot = path.join(here, "..", "..", "prisma", "migrations");
    const dirs = fs
      .readdirSync(migRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const d of dirs) {
      const sql = fs.readFileSync(path.join(migRoot, d, "migration.sql"), "utf8");
      try {
        await su.query(sql);
      } catch (e: any) {
        throw new Error(`migration ${d} failed: ${e.message}`);
      }
    }
    console.log(`[harness] applied ${dirs.length} migrations (incl. enable_rls)`);
    ok(
      dirs.some((d) => d.includes("enable_rls")),
      "T0.0 enable_rls migration present in web/prisma/migrations",
    );

    // ── 3. RLS-enforced app role (mirror of web/rls/setup-app-role.sql) ──────
    await su.query(`
      CREATE ROLE ${APP.user} LOGIN PASSWORD '${APP.password}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO ${APP.user};
      GRANT USAGE ON SCHEMA app TO ${APP.user};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP.user};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP.user};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${APP.user};
    `);

    // ── 4. completeness: EVERY public table must have RLS enabled ────────────
    const rlsRows = (
      await su.query(
        `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
    ).rows as Array<{ tablename: string; rowsecurity: boolean }>;
    const ALLOWED_NO_RLS = new Set(["_prisma_migrations"]);
    const uncovered = rlsRows.filter((r) => !r.rowsecurity && !ALLOWED_NO_RLS.has(r.tablename));
    ok(
      uncovered.length === 0,
      `T0.1 RLS enabled on all ${rlsRows.length} public tables`,
      uncovered.map((u) => u.tablename).join(", "),
    );

    // ── 5. clients ────────────────────────────────────────────────────────────
    const sysPool = new Pool({ host: "localhost", port: PORT, database: DB, ...SUPER });
    const appPool = new Pool({ host: "localhost", port: PORT, database: DB, ...APP });
    sysPool.on("error", () => {});
    appPool.on("error", () => {});
    const sys = new PrismaClient({ adapter: new PrismaPg(sysPool) } as any);
    const appBase = new PrismaClient({ adapter: new PrismaPg(appPool) } as any);
    const forClub = createTenantFactory(appBase);
    const A = forClub("club_a");
    const B = forClub("club_b");

    // ── 6. seed two clubs via the system client (owner role bypasses RLS) ────
    for (const [c, p] of [
      ["club_a", "a"],
      ["club_b", "b"],
    ] as const) {
      await sys.club.create({ data: { id: c, name: `Club ${p.toUpperCase()}`, slug: c } });
      await sys.user.create({
        data: {
          id: `u_${p}1`, clubId: c, email: `owner@${c}.test`, passwordHash: "x",
          firstName: "Owner", lastName: p.toUpperCase(), role: "OWNER",
        },
      });
      await sys.membership.create({ data: { id: `plan_${p}1`, clubId: c, name: `${p} plan` } });
      await sys.member.create({
        data: { id: `m_${p}1`, clubId: c, firstName: "Kid", lastName: p.toUpperCase(), status: "ACTIVE" },
      });
      await sys.memberSubscription.create({
        data: { id: `sub_${p}1`, memberId: `m_${p}1`, membershipId: `plan_${p}1`, optionLabel: "monthly", price: 100 },
      });
      await sys.event.create({
        data: {
          id: `e_${p}1`, clubId: c, type: "CLASS", name: `${p} practice`,
          startsAt: new Date("2026-08-01T17:00:00Z"), endsAt: new Date("2026-08-01T18:00:00Z"),
        },
      });
      await sys.eventSession.create({
        data: {
          id: `es_${p}1`, eventId: `e_${p}1`,
          startsAt: new Date("2026-08-01T17:00:00Z"), endsAt: new Date("2026-08-01T18:00:00Z"),
        },
      });
      await sys.booking.create({ data: { id: `bk_${p}1`, eventId: `e_${p}1`, memberId: `m_${p}1` } });
      await sys.transaction.create({ data: { id: `tx_${p}1`, clubId: c, amount: 50 } });
      await sys.document.create({ data: { id: `doc_${p}1`, clubId: c, title: `${p} waiver`, type: "WAIVER" } });
      await sys.documentSignature.create({
        data: { id: `sig_${p}1`, documentId: `doc_${p}1`, memberId: `m_${p}1`, signerUserId: `u_${p}1`, signerName: "Owner" },
      });
    }
    console.log("[harness] seeded club_a + club_b");

    // ── 7. wrapper sanity: enforcement + positive controls ───────────────────
    console.log("\n[assertRlsEnforced]");
    let enforcedOk = true;
    try {
      await assertRlsEnforced({ $queryRaw: appBase.$queryRaw.bind(appBase) as any });
    } catch {
      enforcedOk = false;
    }
    ok(enforcedOk, "T1.0 app role passes assertRlsEnforced (non-owner, NOBYPASSRLS)");
    await throws(
      "T1.1 system/owner role FAILS assertRlsEnforced (would silently bypass RLS)",
      () => assertRlsEnforced({ $queryRaw: sys.$queryRaw.bind(sys) as any }),
      /RLS NOT ENFORCED/,
    );

    console.log("\n[positive controls — Club A on its own data]");
    ok((await A.member.findMany()).every((m: any) => m.clubId === "club_a"), "T2.0 A reads its own members");
    ok((await A.member.count()) === 1, "T2.1 A sees exactly its 1 member");
    const own = await A.member.create({
      data: { id: "m_a2", clubId: "club_a", firstName: "New", lastName: "Kid" },
    });
    ok(own.id === "m_a2", "T2.2 A can create its own member");
    ok(
      (await A.member.update({ where: { id: "m_a2" }, data: { notes: "hi" } })).notes === "hi",
      "T2.3 A can update its own member",
    );
    await A.member.delete({ where: { id: "m_a2" } });
    ok((await A.member.count()) === 1, "T2.4 A can delete its own member");
    const clubsSeen = await A.club.findMany();
    ok(clubsSeen.length === 1 && clubsSeen[0].id === "club_a", "T2.5 A sees only its own club row");

    // ── 8. READ isolation ─────────────────────────────────────────────────────
    console.log("\n[READ isolation]");
    ok((await A.member.findUnique({ where: { id: "m_b1" } })) === null, "T3.0 A cannot findUnique B's member");
    ok((await B.member.findUnique({ where: { id: "m_a1" } })) === null, "T3.1 B cannot findUnique A's member");
    ok((await A.member.count({ where: { clubId: "club_b" } })) === 0, "T3.2 A count of B members = 0");
    ok((await A.event.findMany()).every((e: any) => e.clubId === "club_a"), "T3.3 A events scoped");
    ok((await A.transaction.count()) === 1, "T3.4 A sees only its transactions");
    ok((await A.club.findUnique({ where: { id: "club_b" } })) === null, "T3.5 A cannot read Club B's row");
    // child tables (no clubId column — scoped via parent policies)
    ok((await A.eventSession.findMany()).every((s: any) => s.eventId === "e_a1"), "T3.6 child: event_sessions scoped via events");
    ok((await A.booking.findMany()).every((b: any) => b.eventId === "e_a1"), "T3.7 child: bookings scoped via events");
    ok((await A.memberSubscription.count()) === 1, "T3.8 child: member_subscriptions scoped via members");
    ok((await A.documentSignature.count()) === 1, "T3.9 child: document_signatures scoped via documents");
    // raw SQL through the tenant wrapper is scoped too
    const raw = await (A as any).$queryRaw`SELECT count(*)::int AS n FROM members`;
    ok(raw[0].n === 1, "T3.10 $queryRaw through tenant client is RLS-scoped");
    // include/join path
    const evs = await A.event.findMany({ include: { bookings: true } });
    ok(
      evs.length === 1 && evs[0].bookings.every((b: any) => b.memberId === "m_a1"),
      "T3.11 relation include stays in-tenant",
    );

    // ── 9. INSERT isolation ───────────────────────────────────────────────────
    console.log("\n[INSERT isolation]");
    await throws(
      "T4.0 A cannot INSERT a member into Club B",
      () => A.member.create({ data: { id: "evil1", clubId: "club_b", firstName: "X", lastName: "Y" } }),
      /row-level security|42501/i,
    );
    await throws(
      "T4.1 A cannot INSERT a booking onto B's event/member (child WITH CHECK)",
      () => A.booking.create({ data: { id: "evil2", eventId: "e_b1", memberId: "m_b1" } }),
      /row-level security|42501|foreign key/i,
    );
    await throws(
      "T4.2 A cannot INSERT a booking mixing its event with B's member",
      () => A.booking.create({ data: { id: "evil3", eventId: "e_a1", memberId: "m_b1" } }),
      /row-level security|42501|foreign key/i,
    );
    await throws(
      "T4.3 A cannot INSERT a subscription for B's member",
      () =>
        A.memberSubscription.create({
          data: { id: "evil4", memberId: "m_b1", membershipId: "plan_b1", optionLabel: "x" },
        }),
      /row-level security|42501|foreign key/i,
    );
    await throws(
      "T4.4 A cannot INSERT a transaction into Club B",
      () => A.transaction.create({ data: { id: "evil5", clubId: "club_b", amount: 1 } }),
      /row-level security|42501/i,
    );

    // ── 10. UPDATE isolation ──────────────────────────────────────────────────
    console.log("\n[UPDATE isolation]");
    await throws(
      "T5.0 A cannot UPDATE B's member by id",
      () => A.member.update({ where: { id: "m_b1" }, data: { notes: "pwned" } }),
      /P2025|not found/i,
    );
    ok(
      (await A.member.updateMany({ where: { clubId: "club_b" }, data: { notes: "pwned" } })).count === 0,
      "T5.1 A updateMany over Club B touches 0 rows",
    );
    await throws(
      "T5.2 A cannot re-home its own member into Club B (WITH CHECK on new row)",
      () => A.member.update({ where: { id: "m_a1" }, data: { clubId: "club_b" } }),
      /row-level security|42501/i,
    );
    await throws(
      "T5.3 A cannot UPDATE Club B's club row",
      () => A.club.update({ where: { id: "club_b" }, data: { name: "pwned" } }),
      /P2025|not found/i,
    );
    ok(
      (await sys.member.findUniqueOrThrow({ where: { id: "m_b1" } })).notes === null,
      "T5.4 verify via system client: B's member untouched",
    );

    // ── 11. DELETE isolation ──────────────────────────────────────────────────
    console.log("\n[DELETE isolation]");
    await throws(
      "T6.0 A cannot DELETE B's member by id",
      () => A.member.delete({ where: { id: "m_b1" } }),
      /P2025|not found/i,
    );
    ok((await A.transaction.deleteMany({ where: { clubId: "club_b" } })).count === 0, "T6.1 A deleteMany over B = 0 rows");
    ok((await A.booking.deleteMany({ where: { id: "bk_b1" } })).count === 0, "T6.2 A cannot delete B's booking (child)");
    ok((await sys.member.count()) === 2, "T6.3 verify via system client: both members still exist");
    ok((await sys.booking.count()) === 2, "T6.4 verify via system client: both bookings still exist");

    // ── 12. fail-closed + injection + pooling ─────────────────────────────────
    console.log("\n[fail-closed / hardening]");
    ok((await appBase.member.findMany()).length === 0, "T7.0 app role with NO tenant set sees 0 rows (fail closed)");
    await throws(
      "T7.1 app role with NO tenant set cannot write at all",
      () => appBase.member.create({ data: { id: "evil6", clubId: "club_a", firstName: "X", lastName: "Y" } }),
      /row-level security|42501/i,
    );
    ok((await appBase.club.findMany()).length === 0, "T7.2 no tenant → no clubs visible");
    const evil = forClub("club_a'; DROP TABLE members;--");
    ok((await evil.member.findMany()).length === 0, "T7.3 clubId is parameterized — injection attempt = empty tenant, tables intact");
    ok((await sys.member.count()) === 2, "T7.4 members table survived injection attempt");
    ok(
      (() => { try { forClub(""); return false; } catch { return true; } })(),
      "T7.5 forClub('') throws (no silent unscoped client)",
    );
    // 40 interleaved queries on the same pool: the transaction-local GUC must
    // never leak between A and B across pooled connections.
    const mixed = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 === 0 ? A : B).member.findMany().then((rows: any[]) => ({
          want: i % 2 === 0 ? "club_a" : "club_b",
          got: rows.map((r) => r.clubId),
        })),
      ),
    );
    ok(
      mixed.every((m) => m.got.length === 1 && m.got[0] === m.want),
      "T7.6 40 interleaved A/B queries on one pool never cross tenants",
    );

    // ── 13. interactive transactions via tenantTransactionOn ─────────────────
    console.log("\n[tenantTransaction]");
    const txCount = await tenantTransactionOn(appBase as any, "club_a", async (tx: any) => {
      await tx.member.create({ data: { id: "m_a3", clubId: "club_a", firstName: "Tx", lastName: "Kid" } });
      return tx.member.count();
    });
    ok(txCount === 2, "T8.0 tenantTransaction: create + read inside one scoped tx");
    ok((await sys.member.findUnique({ where: { id: "m_a3" } }))?.clubId === "club_a", "T8.1 tx write committed to the right club");
    await throws(
      "T8.2 tenantTransaction for A cannot write into B",
      () =>
        tenantTransactionOn(appBase as any, "club_a", async (tx: any) => {
          await tx.member.create({ data: { id: "evil7", clubId: "club_b", firstName: "X", lastName: "Y" } });
        }),
      /row-level security|42501/i,
    );
    const bView = await tenantTransactionOn(appBase as any, "club_b", async (tx: any) => tx.member.findMany());
    ok(bView.every((m: any) => m.clubId === "club_b") && bView.length === 1, "T8.3 tenantTransaction for B sees only B");

    // ── 14. the accounting ledger (Phase 1, 2026-10-20) ─────────────────────
    // Proves club A cannot READ or WRITE club B's books, for all six gl_*
    // tables. The ledger is the one surface where a cross-tenant leak is not
    // just a privacy breach but a wrong number on somebody's tax return, so
    // it gets its own section rather than relying on T0.1's completeness check.
    console.log("\n[ledger — cross-club isolation]");

    // Seed a minimal chart + one balanced entry per club, via the system client.
    for (const [c, p] of [["club_a", "a"], ["club_b", "b"]] as const) {
      await sys.legalEntity.create({
        data: { id: `ent_${p}1`, clubId: c, name: `${p.toUpperCase()} Entity`, entityType: "LLC" },
      });
      await sys.glAccount.create({
        data: {
          id: `gla_${p}_cash`, clubId: c, number: "1000", name: "Operating Checking",
          type: "ASSET", normalBalance: "DEBIT", sortOrder: 0,
        },
      });
      await sys.glAccount.create({
        data: {
          id: `gla_${p}_rev`, clubId: c, number: "4000", name: "Membership Revenue",
          type: "INCOME", normalBalance: "CREDIT", sortOrder: 0,
        },
      });
      await sys.glJournalEntry.create({
        data: {
          id: `gle_${p}1`, clubId: c, entryDate: new Date("2026-10-01T00:00:00Z"),
          memo: `${p} dues`, legalEntityId: `ent_${p}1`, sourceType: "MANUAL", status: "POSTED",
          lines: {
            create: [
              { id: `gll_${p}1`, clubId: c, accountId: `gla_${p}_cash`, debitCents: 10_000, legalEntityId: `ent_${p}1`, lineNumber: 0 },
              { id: `gll_${p}2`, clubId: c, accountId: `gla_${p}_rev`, creditCents: 10_000, legalEntityId: `ent_${p}1`, lineNumber: 1 },
            ],
          },
        },
      });
      await sys.glEntryAttachment.create({
        data: {
          id: `glat_${p}1`, clubId: c, entryId: `gle_${p}1`, fileId: `file_${p}1`,
          fileName: `${p}-invoice.pdf`, mimeType: "application/pdf", sizeBytes: 1234,
        },
      });
      await sys.glLockDate.create({
        data: { id: `gllk_${p}1`, clubId: c, legalEntityId: `ent_${p}1`, lockedThrough: new Date("2026-09-30T00:00:00Z") },
      });
      await sys.glAuditLog.create({
        data: { id: `glaud_${p}1`, clubId: c, objectType: "ENTRY", objectId: `gle_${p}1`, action: "CREATE", actorName: "Seed" },
      });
      // Phase 2 needs a bank connection + account per club: bank_accounts
      // gained a glAccountId FK whose policy this exercises.
      await sys.plaidConnection.create({
        data: { id: `pc_${p}1`, clubId: c, accessToken: "tok", itemId: `item_${p}1`, label: `${p} bank` },
      });
      await sys.bankAccount.create({
        data: {
          id: `ba_${p}1`, clubId: c, plaidConnectionId: `pc_${p}1`, accountId: `acct_${p}1`,
          name: "Checking", type: "depository", glAccountId: `gla_${p}_cash`,
        },
      });
    }

    // Positive controls — A really can see its own books, so a later "0 rows"
    // means isolation rather than an empty table.
    ok((await A.glAccount.count()) === 2, "T9.0 A sees its own 2 accounts");
    ok((await A.glJournalEntry.count()) === 1, "T9.1 A sees its own 1 entry");
    ok((await A.glJournalLine.count()) === 2, "T9.2 A sees its own 2 lines");
    ok((await A.glEntryAttachment.count()) === 1, "T9.3 A sees its own attachment");
    ok((await A.glLockDate.count()) === 1, "T9.4 A sees its own lock date");
    ok((await A.glAuditLog.count()) === 1, "T9.5 A sees its own audit row");

    // READ isolation.
    ok((await A.glAccount.findMany()).every((r: any) => r.clubId === "club_a"), "T9.6 A's accounts are all A's");
    ok((await A.glAccount.findUnique({ where: { id: "gla_b_cash" } })) === null, "T9.7 A cannot read B's account");
    ok((await A.glJournalEntry.findUnique({ where: { id: "gle_b1" } })) === null, "T9.8 A cannot read B's journal entry");
    ok((await A.glJournalLine.findUnique({ where: { id: "gll_b1" } })) === null, "T9.9 A cannot read B's journal LINE");
    ok((await A.glEntryAttachment.findUnique({ where: { id: "glat_b1" } })) === null, "T9.10 A cannot read B's attachment");
    ok((await A.glLockDate.findUnique({ where: { id: "gllk_b1" } })) === null, "T9.11 A cannot read B's lock date");
    ok((await A.glAuditLog.findUnique({ where: { id: "glaud_b1" } })) === null, "T9.12 A cannot read B's audit row");
    ok((await A.glAccount.count({ where: { clubId: "club_b" } })) === 0, "T9.13 A counting B's accounts gets 0");
    ok((await A.glJournalLine.count({ where: { clubId: "club_b" } })) === 0, "T9.14 A counting B's lines gets 0");

    // A groupBy is how the balance summary reads the ledger — it must not
    // aggregate across tenants, which would silently mix two clubs' money
    // into one number.
    const aSums = await A.glJournalLine.groupBy({ by: ["accountId"], _sum: { debitCents: true, creditCents: true } });
    ok(
      aSums.length === 2 && aSums.every((g: any) => g.accountId.startsWith("gla_a_")),
      "T9.15 a groupBy aggregate never crosses tenants",
    );
    const rawLines = await A.$queryRaw<{ n: bigint }[]>`SELECT count(*)::int AS n FROM gl_journal_lines`;
    ok(Number(rawLines[0].n) === 2, "T9.16 raw SQL through the tenant client is RLS-scoped too");

    // WRITE isolation — the WITH CHECK half of each policy.
    await throws(
      "T9.17 A cannot INSERT an account into club B",
      () =>
        A.glAccount.create({
          data: { id: "evil_acct", clubId: "club_b", number: "9999", name: "Evil", type: "ASSET", normalBalance: "DEBIT" },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T9.18 A cannot INSERT a journal entry into club B",
      () =>
        A.glJournalEntry.create({
          data: { id: "evil_entry", clubId: "club_b", entryDate: new Date("2026-10-01T00:00:00Z"), sourceType: "MANUAL" },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T9.19 A cannot INSERT a line into club B",
      () =>
        A.glJournalLine.create({
          data: { id: "evil_line", clubId: "club_b", entryId: "gle_b1", accountId: "gla_b_cash", debitCents: 1, creditCents: 0 },
        }),
      /row-level security|42501/i,
    );
    // ── The FK-crossing family ───────────────────────────────────────────────
    // A clubId-only policy does NOT stop these: the clubId check passes, and
    // Postgres FK checks deliberately bypass RLS. T9.20 FAILED on the first
    // cut of the migration (A really could hang a line off B's entry, which
    // the entry-detail view would then render inside B's own entry). The
    // policies now verify every FK target is in the same club — see §8 of
    // 20261020000000_gl_ledger_core.
    await throws(
      "T9.20 A cannot INSERT a line onto B's ENTRY while claiming its own club",
      () =>
        A.glJournalLine.create({
          data: { id: "evil_line2", clubId: "club_a", entryId: "gle_b1", accountId: "gla_a_cash", debitCents: 1, creditCents: 0 },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T9.20b A cannot post its own line to B's ACCOUNT (would leak B's account on A's entry)",
      () =>
        A.glJournalLine.create({
          data: { id: "evil_line3", clubId: "club_a", entryId: "gle_a1", accountId: "gla_b_cash", debitCents: 1, creditCents: 0 },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T9.20c A cannot tag its own line with B's ENTITY",
      () =>
        A.glJournalLine.create({
          data: {
            id: "evil_line4", clubId: "club_a", entryId: "gle_a1", accountId: "gla_a_cash",
            debitCents: 1, creditCents: 0, legalEntityId: "ent_b1",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T9.20d A cannot attach a document to B's entry",
      () =>
        A.glEntryAttachment.create({
          data: {
            id: "evil_att", clubId: "club_a", entryId: "gle_b1", fileId: "f_x",
            fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1,
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T9.20e A cannot put its own entry under B's entity",
      () =>
        A.glJournalEntry.create({
          data: {
            id: "evil_entry2", clubId: "club_a", entryDate: new Date("2026-10-02T00:00:00Z"),
            sourceType: "MANUAL", legalEntityId: "ent_b1",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T9.20f A cannot nest its own account under B's account",
      () =>
        A.glAccount.create({
          data: {
            id: "evil_child", clubId: "club_a", number: "1001", name: "Child",
            type: "ASSET", normalBalance: "DEBIT", parentId: "gla_b_cash",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T9.20g A cannot set a lock date naming B's entity",
      () =>
        A.glLockDate.create({
          data: { id: "evil_lock2", clubId: "club_a", legalEntityId: "ent_b1", lockedThrough: new Date("2026-12-31T00:00:00Z") },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    // Positive control: the SAME shapes must still work within one club, or the
    // hardened policy has broken legitimate posting.
    const okLine = await A.glJournalLine.create({
      data: {
        id: "good_line", clubId: "club_a", entryId: "gle_a1", accountId: "gla_a_cash",
        debitCents: 500, creditCents: 0, legalEntityId: "ent_a1", lineNumber: 2,
      },
    });
    ok(okLine.id === "good_line", "T9.20h …but A CAN post a line on its own entry, account and entity");
    const okAtt = await A.glEntryAttachment.create({
      data: {
        id: "good_att", clubId: "club_a", entryId: "gle_a1", fileId: "f_a2",
        fileName: "ok.pdf", mimeType: "application/pdf", sizeBytes: 2,
      },
    });
    ok(okAtt.id === "good_att", "T9.20i …and CAN attach a document to its own entry");
    const okChild = await A.glAccount.create({
      data: {
        id: "good_child", clubId: "club_a", number: "1001", name: "Petty Cash",
        type: "ASSET", normalBalance: "DEBIT", parentId: "gla_a_cash",
      },
    });
    ok(okChild.parentId === "gla_a_cash", "T9.20j …and CAN nest a sub-account under its own parent");
    await A.glJournalLine.delete({ where: { id: "good_line" } });
    await A.glEntryAttachment.delete({ where: { id: "good_att" } });
    await A.glAccount.delete({ where: { id: "good_child" } });
    await throws(
      "T9.21 A cannot INSERT a lock date for club B — closing another club's books",
      () =>
        A.glLockDate.create({
          data: { id: "evil_lock", clubId: "club_b", legalEntityId: "ent_b1", lockedThrough: new Date("2026-12-31T00:00:00Z") },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T9.22 A cannot forge an audit row in club B",
      () =>
        A.glAuditLog.create({
          data: { id: "evil_audit", clubId: "club_b", objectType: "ENTRY", objectId: "gle_b1", action: "VOID" },
        }),
      /row-level security|42501/i,
    );

    // UPDATE / DELETE isolation.
    await throws(
      "T9.23 A cannot UPDATE B's account by id",
      () => A.glAccount.update({ where: { id: "gla_b_cash" }, data: { name: "Hijacked" } }),
      /not found|no record|row-level security/i,
    );
    ok(
      (await A.glAccount.updateMany({ where: { clubId: "club_b" }, data: { name: "Hijacked" } })).count === 0,
      "T9.24 A's updateMany over B touches 0 rows",
    );
    await throws(
      "T9.25 A cannot re-home its own account into club B (WITH CHECK on the new row)",
      () => A.glAccount.update({ where: { id: "gla_a_cash" }, data: { clubId: "club_b" } }),
      /row-level security|42501/i,
    );
    await throws(
      "T9.26 A cannot move its own journal entry into club B",
      () => A.glJournalEntry.update({ where: { id: "gle_a1" }, data: { clubId: "club_b" } }),
      /row-level security|42501/i,
    );
    ok(
      (await A.glLockDate.updateMany({ where: { clubId: "club_b" }, data: { lockedThrough: new Date("2027-01-01T00:00:00Z") } })).count === 0,
      "T9.27 A cannot move B's lock date",
    );
    ok((await A.glJournalLine.deleteMany({ where: { clubId: "club_b" } })).count === 0, "T9.28 A cannot delete B's lines");
    ok((await A.glJournalEntry.deleteMany({ where: { id: "gle_b1" } })).count === 0, "T9.29 A cannot delete B's entry");
    ok((await A.glAuditLog.deleteMany({ where: { clubId: "club_b" } })).count === 0, "T9.30 A cannot delete B's audit rows");

    // Verify through the system client that B's books are untouched after all
    // of the above — the assertions prove the writes were refused, this proves
    // nothing leaked through anyway.
    ok((await sys.glAccount.count({ where: { clubId: "club_b" } })) === 2, "T9.31 system check: B still has exactly 2 accounts");
    ok((await sys.glAccount.findUnique({ where: { id: "gla_b_cash" } }))?.name === "Operating Checking", "T9.32 system check: B's account name is unchanged");
    ok((await sys.glJournalLine.count({ where: { clubId: "club_b" } })) === 2, "T9.33 system check: B still has both lines");
    ok((await sys.glAuditLog.count({ where: { clubId: "club_b" } })) === 1, "T9.34 system check: B's audit row survived");
    ok((await sys.glAccount.count({ where: { clubId: "club_a" } })) === 2, "T9.35 system check: A's own accounts are intact");

    // Fail closed with no tenant set.
    ok((await appBase.glAccount.findMany()).length === 0, "T9.36 app role with NO tenant sees 0 accounts (fail closed)");
    ok((await appBase.glJournalLine.findMany()).length === 0, "T9.37 and 0 journal lines");
    await throws(
      "T9.38 app role with NO tenant cannot write a journal entry at all",
      () =>
        appBase.glJournalEntry.create({
          data: { id: "evil_no_tenant", clubId: "club_a", entryDate: new Date("2026-10-01T00:00:00Z"), sourceType: "MANUAL" },
        }),
      /row-level security|42501/i,
    );

    // ── 15. Phase 2 tables: payout_matches, gl_reconciliations, gl_deposits ──
    // payout_matches had NO policy at all until Phase 2 (it is one of the 27
    // T0.1 reports). The other two are new. All three are FK-aware where they
    // have an FK, because Phase 1's harness proved a clubId-only policy lets
    // one club point a row at another's record — Postgres FK checks bypass RLS.
    console.log("\n[Phase 2 — payouts, reconciliations, deposits]");

    for (const [c, p] of [["club_a", "a"], ["club_b", "b"]] as const) {
      await sys.payoutMatch.create({
        data: { id: `pm_${p}1`, clubId: c, stripePayoutId: `po_${p}1`, amount: 500, bankTransactionId: `plaid_${p}1` },
      });
      await sys.glReconciliation.create({
        data: {
          id: `rec_${p}1`, clubId: c, accountId: `gla_${p}_cash`,
          periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2026-10-31T00:00:00Z"),
          statementEndingCents: 10000,
        },
      });
      await sys.glDeposit.create({
        data: {
          id: `dep_${p}1`, clubId: c, accountId: `gla_${p}_cash`,
          depositDate: new Date("2026-10-15T00:00:00Z"), amountCents: 7500, entryId: `gle_${p}1`,
        },
      });
    }

    // Positive controls, so a later "0 rows" means isolation and not emptiness.
    ok((await A.payoutMatch.count()) === 1, "T10.0 A sees its own payout match");
    ok((await A.glReconciliation.count()) === 1, "T10.1 A sees its own reconciliation");
    ok((await A.glDeposit.count()) === 1, "T10.2 A sees its own deposit");

    // Reads.
    ok((await A.payoutMatch.findUnique({ where: { id: "pm_b1" } })) === null, "T10.3 A cannot read B's payout match");
    ok((await A.glReconciliation.findUnique({ where: { id: "rec_b1" } })) === null, "T10.4 A cannot read B's reconciliation");
    ok((await A.glDeposit.findUnique({ where: { id: "dep_b1" } })) === null, "T10.5 A cannot read B's deposit");
    ok((await A.payoutMatch.count({ where: { clubId: "club_b" } })) === 0, "T10.6 A counting B's payout matches gets 0");

    // Writes into the other club.
    await throws(
      "T10.7 A cannot INSERT a payout match into club B",
      () => A.payoutMatch.create({ data: { id: "evil_pm", clubId: "club_b", stripePayoutId: "po_evil", amount: 1 } }),
      /row-level security|42501/i,
    );
    await throws(
      "T10.8 A cannot INSERT a reconciliation into club B",
      () =>
        A.glReconciliation.create({
          data: {
            id: "evil_rec", clubId: "club_b", accountId: "gla_b_cash",
            periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2026-10-31T00:00:00Z"),
            statementEndingCents: 1,
          },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T10.9 A cannot INSERT a deposit into club B",
      () =>
        A.glDeposit.create({
          data: { id: "evil_dep", clubId: "club_b", accountId: "gla_b_cash", depositDate: new Date("2026-10-15T00:00:00Z"), amountCents: 1 },
        }),
      /row-level security|42501/i,
    );

    // ── The FK-crossing family again, for the new tables ────────────────────
    await throws(
      "T10.10 A cannot reconcile B's ACCOUNT while claiming its own club",
      () =>
        A.glReconciliation.create({
          data: {
            id: "evil_rec2", clubId: "club_a", accountId: "gla_b_cash",
            periodStart: new Date("2026-11-01T00:00:00Z"), periodEnd: new Date("2026-11-30T00:00:00Z"),
            statementEndingCents: 1,
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T10.11 A cannot deposit into B's ACCOUNT",
      () =>
        A.glDeposit.create({
          data: { id: "evil_dep2", clubId: "club_a", accountId: "gla_b_cash", depositDate: new Date("2026-10-15T00:00:00Z"), amountCents: 1 },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T10.12 A cannot attach its deposit to B's ENTRY",
      () =>
        A.glDeposit.create({
          data: {
            id: "evil_dep3", clubId: "club_a", accountId: "gla_a_cash",
            depositDate: new Date("2026-10-15T00:00:00Z"), amountCents: 1, entryId: "gle_b1",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    // gl_journal_lines gained a reconciliationId FK in this migration — its
    // policy had to be widened, and this is what proves it was.
    await throws(
      "T10.13 A cannot claim its line was cleared in B's RECONCILIATION",
      () =>
        A.glJournalLine.create({
          data: {
            id: "evil_line_rec", clubId: "club_a", entryId: "gle_a1", accountId: "gla_a_cash",
            debitCents: 1, creditCents: 0, reconciliationId: "rec_b1",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    // bank_accounts gained a glAccountId FK; its policy was clubId-only before.
    await throws(
      "T10.14 A cannot point its bank account at B's GL ACCOUNT",
      () =>
        A.bankAccount.create({
          data: {
            id: "evil_bank", clubId: "club_a", plaidConnectionId: "pc_a1", accountId: "acct_evil",
            glAccountId: "gla_b_cash",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );

    // Positive controls: the same shapes must still work inside one club.
    const okRec = await A.glReconciliation.create({
      data: {
        id: "good_rec", clubId: "club_a", accountId: "gla_a_cash",
        periodStart: new Date("2026-11-01T00:00:00Z"), periodEnd: new Date("2026-11-30T00:00:00Z"),
        statementEndingCents: 5000,
      },
    });
    ok(okRec.id === "good_rec", "T10.15 …but A CAN reconcile its own account");
    const okRecLine = await A.glJournalLine.create({
      data: {
        id: "good_line_rec", clubId: "club_a", entryId: "gle_a1", accountId: "gla_a_cash",
        debitCents: 1, creditCents: 0, reconciliationId: "good_rec", clearedAt: new Date(), lineNumber: 9,
      },
    });
    ok(okRecLine.reconciliationId === "good_rec", "T10.16 …and CAN clear a line into its own reconciliation");
    await A.glJournalLine.delete({ where: { id: "good_line_rec" } });
    await A.glReconciliation.delete({ where: { id: "good_rec" } });

    // Update / delete isolation.
    ok(
      (await A.glReconciliation.updateMany({ where: { clubId: "club_b" }, data: { status: "FINISHED" } })).count === 0,
      "T10.17 A cannot finish B's reconciliation",
    );
    ok((await A.glDeposit.deleteMany({ where: { clubId: "club_b" } })).count === 0, "T10.18 A cannot delete B's deposits");
    ok((await A.payoutMatch.deleteMany({ where: { clubId: "club_b" } })).count === 0, "T10.19 A cannot delete B's payout matches");
    await throws(
      "T10.20 A cannot re-home its reconciliation into club B",
      () => A.glReconciliation.update({ where: { id: "rec_a1" }, data: { clubId: "club_b" } }),
      /row-level security|42501/i,
    );

    // System check: B is untouched.
    ok((await sys.glReconciliation.count({ where: { clubId: "club_b" } })) === 1, "T10.21 system check: B still has its reconciliation");
    ok((await sys.glReconciliation.findUnique({ where: { id: "rec_b1" } }))?.status === "OPEN", "T10.22 system check: still OPEN");
    ok((await sys.glDeposit.count({ where: { clubId: "club_b" } })) === 1, "T10.23 system check: B still has its deposit");
    ok((await sys.payoutMatch.count({ where: { clubId: "club_b" } })) === 1, "T10.24 system check: B still has its payout match");

    // Fail closed with no tenant.
    ok((await appBase.glReconciliation.findMany()).length === 0, "T10.25 no tenant → 0 reconciliations (fail closed)");
    ok((await appBase.glDeposit.findMany()).length === 0, "T10.26 …and 0 deposits");
    ok((await appBase.payoutMatch.findMany()).length === 0, "T10.27 …and 0 payout matches");

    // ── 16. Phase 3's tables (2026-10-22) ───────────────────────────────────
    // Five new tables, plus RLS newly added to six finance/reports tables that
    // had none. The fixed-asset register and the month close both carry FKs
    // into gl_accounts and legal_entities, and Postgres FK checks deliberately
    // bypass RLS — so a clubId-only policy would let club A point its asset at
    // club B's account. That is what T11.8 onwards proves it cannot.
    console.log("\n[Phase 3 tables — cross-club isolation]");

    for (const [c, p] of [["club_a", "a"], ["club_b", "b"]] as const) {
      await sys.glAccount.create({
        data: {
          id: `gla_${p}_accum`, clubId: c, number: "1590", name: "Accumulated Depreciation",
          type: "ASSET", normalBalance: "CREDIT", isContra: true, sortOrder: 0,
        },
      });
      await sys.glAccount.create({
        data: {
          id: `gla_${p}_dep`, clubId: c, number: "6800", name: "Depreciation Expense",
          type: "EXPENSE", normalBalance: "DEBIT", sortOrder: 0,
        },
      });
      await sys.glFixedAsset.create({
        data: {
          id: `asset_${p}1`, clubId: c, name: `${p} mats`, costCents: 1_200_000,
          inServiceDate: new Date("2027-01-15T00:00:00Z"), usefulLifeMonths: 60,
          legalEntityId: `ent_${p}1`, assetAccountId: `gla_${p}_cash`,
          accumDepAccountId: `gla_${p}_accum`, depExpenseAccountId: `gla_${p}_dep`,
        },
      });
      await sys.glMonthClose.create({
        data: {
          id: `close_${p}1`, clubId: c, legalEntityId: `ent_${p}1`,
          periodMonth: new Date("2027-01-01T00:00:00Z"), status: "CLOSED",
        },
      });
      await sys.glOpeningImport.create({
        data: { id: `open_${p}1`, clubId: c, fileName: `${p}-tb.csv`, rows: {}, mapping: {} },
      });
      await sys.qboHistoryFile.create({
        data: { id: `qbf_${p}1`, clubId: c, fileName: `${p}-gl.csv`, kind: "GENERAL_LEDGER", rowCount: 1 },
      });
      await sys.qboHistoryRow.create({
        data: {
          id: `qbr_${p}1`, clubId: c, fileId: `qbf_${p}1`, txDate: new Date("2026-05-01T00:00:00Z"),
          name: `${p} vendor`, account: "Rent", amountCents: 250_000, rowIndex: 0,
        },
      });
      await sys.plaidTransaction.create({
        data: {
          id: `pt_${p}1`, clubId: c, plaidConnectionId: `pc_${p}1`, plaidTransactionId: `ptx_${p}1`,
          accountId: `acct_${p}1`, amount: 100, date: new Date("2027-02-01T00:00:00Z"), name: `${p} row`,
        },
      });
      await sys.stripeReconciliation.create({
        data: { id: `sr_${p}1`, clubId: c, stripeSubscriptionId: `sub_${p}1`, stripeCustomerId: `cus_${p}1` },
      });
    }

    // Positive controls first, so a later "0 rows" means isolation and not an
    // empty table.
    ok((await A.glFixedAsset.count()) === 1, "T11.0 A sees its own fixed asset");
    ok((await A.glMonthClose.count()) === 1, "T11.1 A sees its own month close");
    ok((await A.glOpeningImport.count()) === 1, "T11.2 A sees its own opening import");
    ok((await A.qboHistoryFile.count()) === 1, "T11.3 A sees its own archived file");
    ok((await A.qboHistoryRow.count()) === 1, "T11.4 A sees its own archived row");
    ok((await A.plaidTransaction.count()) === 1, "T11.5 A sees its own bank row");
    ok((await A.stripeReconciliation.count()) === 1, "T11.6 A sees its own Stripe reconciliation");

    // Reads across the tenant.
    ok((await A.glFixedAsset.findUnique({ where: { id: "asset_b1" } })) === null, "T11.7 A cannot read B's asset");
    ok((await A.glMonthClose.findUnique({ where: { id: "close_b1" } })) === null, "T11.8 A cannot read B's month close");
    ok((await A.glOpeningImport.findUnique({ where: { id: "open_b1" } })) === null, "T11.9 A cannot read B's opening import");
    ok((await A.qboHistoryFile.findUnique({ where: { id: "qbf_b1" } })) === null, "T11.10 A cannot read B's archived file");
    ok((await A.qboHistoryRow.findUnique({ where: { id: "qbr_b1" } })) === null, "T11.11 A cannot read B's archived row");
    ok((await A.plaidTransaction.findUnique({ where: { id: "pt_b1" } })) === null, "T11.12 A cannot read B's bank row");
    ok(
      (await A.stripeReconciliation.findUnique({ where: { id: "sr_b1" } })) === null,
      "T11.13 A cannot read B's Stripe reconciliation",
    );
    ok((await A.qboHistoryRow.count({ where: { clubId: "club_b" } })) === 0, "T11.14 A counting B's archive gets 0");

    // Writes into the other club.
    await throws(
      "T11.15 A cannot INSERT an asset into club B",
      () =>
        A.glFixedAsset.create({
          data: {
            id: "evil_asset", clubId: "club_b", name: "evil", costCents: 1,
            inServiceDate: new Date("2027-01-01T00:00:00Z"), usefulLifeMonths: 1,
            assetAccountId: "gla_b_cash", accumDepAccountId: "gla_b_accum", depExpenseAccountId: "gla_b_dep",
          },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T11.16 A cannot close a month in club B",
      () =>
        A.glMonthClose.create({
          data: {
            id: "evil_close", clubId: "club_b", legalEntityId: "ent_b1",
            periodMonth: new Date("2027-02-01T00:00:00Z"), status: "CLOSED",
          },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T11.17 A cannot INSERT an opening import into club B",
      () => A.glOpeningImport.create({ data: { id: "evil_open", clubId: "club_b", fileName: "x", rows: {}, mapping: {} } }),
      /row-level security|42501/i,
    );
    await throws(
      "T11.18 A cannot INSERT an archived file into club B",
      () => A.qboHistoryFile.create({ data: { id: "evil_qbf", clubId: "club_b", fileName: "x", kind: "OTHER", rowCount: 0 } }),
      /row-level security|42501/i,
    );
    await throws(
      "T11.19 A cannot INSERT an archived row into club B",
      () => A.qboHistoryRow.create({ data: { id: "evil_qbr", clubId: "club_b", fileId: "qbf_b1", rowIndex: 0 } }),
      /row-level security|42501/i,
    );
    await throws(
      "T11.20 A cannot INSERT a bank row into club B",
      () =>
        A.plaidTransaction.create({
          data: {
            id: "evil_pt", clubId: "club_b", plaidConnectionId: "pc_b1", plaidTransactionId: "ptx_evil",
            accountId: "acct_b1", amount: 1, date: new Date("2027-02-01T00:00:00Z"), name: "evil",
          },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T11.21 A cannot INSERT a Stripe reconciliation into club B",
      () =>
        A.stripeReconciliation.create({
          data: { id: "evil_sr", clubId: "club_b", stripeSubscriptionId: "sub_evil", stripeCustomerId: "cus_evil" },
        }),
      /row-level security|42501/i,
    );

    // ── THE FK-CROSSING FAMILY ──────────────────────────────────────────────
    // Each of these claims club A — so a clubId-only policy would let it
    // through — while pointing a foreign key at club B. Postgres FK checks
    // bypass RLS, which is exactly why the policies carry FK-aware WITH CHECK
    // conditions, and exactly what these assertions prove.
    await throws(
      "T11.22 A cannot point its asset at B's ASSET ACCOUNT",
      () =>
        A.glFixedAsset.create({
          data: {
            id: "evil_asset2", clubId: "club_a", name: "x", costCents: 1,
            inServiceDate: new Date("2027-01-01T00:00:00Z"), usefulLifeMonths: 1,
            assetAccountId: "gla_b_cash", accumDepAccountId: "gla_a_accum", depExpenseAccountId: "gla_a_dep",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T11.23 …nor at B's ACCUMULATED DEPRECIATION account",
      () =>
        A.glFixedAsset.create({
          data: {
            id: "evil_asset3", clubId: "club_a", name: "x", costCents: 1,
            inServiceDate: new Date("2027-01-01T00:00:00Z"), usefulLifeMonths: 1,
            assetAccountId: "gla_a_cash", accumDepAccountId: "gla_b_accum", depExpenseAccountId: "gla_a_dep",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T11.24 …nor at B's DEPRECIATION EXPENSE account",
      () =>
        A.glFixedAsset.create({
          data: {
            id: "evil_asset4", clubId: "club_a", name: "x", costCents: 1,
            inServiceDate: new Date("2027-01-01T00:00:00Z"), usefulLifeMonths: 1,
            assetAccountId: "gla_a_cash", accumDepAccountId: "gla_a_accum", depExpenseAccountId: "gla_b_dep",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T11.25 …nor at B's LEGAL ENTITY",
      () =>
        A.glFixedAsset.create({
          data: {
            id: "evil_asset5", clubId: "club_a", name: "x", costCents: 1,
            inServiceDate: new Date("2027-01-01T00:00:00Z"), usefulLifeMonths: 1,
            legalEntityId: "ent_b1", assetAccountId: "gla_a_cash",
            accumDepAccountId: "gla_a_accum", depExpenseAccountId: "gla_a_dep",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T11.26 A cannot close its OWN month against B's LEGAL ENTITY",
      () =>
        A.glMonthClose.create({
          data: {
            id: "evil_close2", clubId: "club_a", legalEntityId: "ent_b1",
            periodMonth: new Date("2027-03-01T00:00:00Z"), status: "CLOSED",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T11.27 A cannot file an archived row under B's FILE",
      () => A.qboHistoryRow.create({ data: { id: "evil_qbr2", clubId: "club_a", fileId: "qbf_b1", rowIndex: 0 } }),
      /row-level security|foreign key|23503|42501/i,
    );
    await throws(
      "T11.28 A cannot attach a bank row to B's PLAID CONNECTION",
      () =>
        A.plaidTransaction.create({
          data: {
            id: "evil_pt2", clubId: "club_a", plaidConnectionId: "pc_b1", plaidTransactionId: "ptx_evil2",
            accountId: "acct_evil", amount: 1, date: new Date("2027-02-01T00:00:00Z"), name: "evil",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );

    // Positive controls: the same shapes must still work inside one club, or
    // the policies are too tight and the feature is broken rather than safe.
    const okAsset = await A.glFixedAsset.create({
      data: {
        id: "good_asset", clubId: "club_a", name: "A scoreboard", costCents: 50_000,
        inServiceDate: new Date("2027-01-01T00:00:00Z"), usefulLifeMonths: 36,
        legalEntityId: "ent_a1", assetAccountId: "gla_a_cash",
        accumDepAccountId: "gla_a_accum", depExpenseAccountId: "gla_a_dep",
      },
    });
    ok(okAsset.id === "good_asset", "T11.29 …but A CAN register an asset against its own accounts");
    await A.glFixedAsset.delete({ where: { id: "good_asset" } });

    const okRow = await A.qboHistoryRow.create({
      data: { id: "good_qbr", clubId: "club_a", fileId: "qbf_a1", name: "A vendor", amountCents: 100, rowIndex: 1 },
    });
    ok(okRow.id === "good_qbr", "T11.30 …and CAN file an archived row under its own file");
    await A.qboHistoryRow.delete({ where: { id: "good_qbr" } });

    // Update / delete isolation.
    ok(
      (await A.glFixedAsset.updateMany({ where: { clubId: "club_b" }, data: { costCents: 1 } })).count === 0,
      "T11.31 A cannot rewrite B's asset cost",
    );
    ok(
      (await A.glMonthClose.updateMany({ where: { clubId: "club_b" }, data: { status: "OPEN" } })).count === 0,
      "T11.32 A cannot reopen B's closed month",
    );
    ok(
      (await A.qboHistoryRow.deleteMany({ where: { clubId: "club_b" } })).count === 0,
      "T11.33 A cannot delete B's archive",
    );
    ok(
      (await A.plaidTransaction.updateMany({ where: { clubId: "club_b" }, data: { suspectedDuplicateOf: "x" } })).count === 0,
      "T11.34 A cannot flag B's bank rows as duplicates",
    );
    await throws(
      "T11.35 A cannot re-home its asset into club B",
      () => A.glFixedAsset.update({ where: { id: "asset_a1" }, data: { clubId: "club_b" } }),
      /row-level security|42501/i,
    );

    // System check: B is untouched by all of the above.
    ok((await sys.glFixedAsset.count({ where: { clubId: "club_b" } })) === 1, "T11.36 system check: B still has its asset");
    ok(
      (await sys.glMonthClose.findUnique({ where: { id: "close_b1" } }))?.status === "CLOSED",
      "T11.37 system check: B's month is still closed",
    );
    ok((await sys.qboHistoryRow.count({ where: { clubId: "club_b" } })) === 1, "T11.38 system check: B still has its archive");
    ok(
      (await sys.plaidTransaction.findUnique({ where: { id: "pt_b1" } }))?.suspectedDuplicateOf === null,
      "T11.39 system check: B's bank row is still unflagged",
    );

    // Fail closed with no tenant set.
    ok((await appBase.glFixedAsset.findMany()).length === 0, "T11.40 no tenant → 0 assets (fail closed)");
    ok((await appBase.glMonthClose.findMany()).length === 0, "T11.41 …and 0 month closes");
    ok((await appBase.glOpeningImport.findMany()).length === 0, "T11.42 …and 0 opening imports");
    ok((await appBase.qboHistoryFile.findMany()).length === 0, "T11.43 …and 0 archived files");
    ok((await appBase.qboHistoryRow.findMany()).length === 0, "T11.44 …and 0 archived rows");
    ok((await appBase.plaidTransaction.findMany()).length === 0, "T11.45 …and 0 bank rows");
    ok((await appBase.stripeReconciliation.findMany()).length === 0, "T11.46 …and 0 Stripe reconciliations");

    // ── 17. Phase 12.1's tables (2026-10-27) ────────────────────────────────
    // contractor_w9_submissions holds ENCRYPTED TAX IDS, so a cross-tenant
    // read here is not a privacy annoyance but somebody else's social security
    // number. The staff document tables carry FKs into documents and users,
    // and Postgres FK checks bypass RLS — which is what T12.14 onwards proves
    // the FK-aware policies catch.
    console.log("\n[Phase 12.1 tables — cross-club isolation]");

    for (const [c, p] of [["club_a", "a"], ["club_b", "b"]] as const) {
      await sys.contractor.create({
        data: { id: `con_${p}1`, clubId: c, name: `${p} referee`, email: `${p}ref@example.com` },
      });
      await sys.contractorW9Submission.create({
        data: {
          id: `w9_${p}1`,
          clubId: c,
          contractorId: `con_${p}1`,
          legalName: `${p.toUpperCase()} Referee`,
          taxClassification: "INDIVIDUAL",
          streetAddress: "1 Road",
          city: "Town",
          state: "OH",
          zipCode: "45402",
          taxIdKind: "SSN",
          // Shaped like real ciphertext so the CHECK constraint accepts it.
          taxIdEncrypted: `v1:1:${p}aaaaaaaaaaaa:${p}bbbbbbbbbbbb:${p}cccccccccccc`,
          taxIdLast4: "6789",
          certificationText: "Under penalties of perjury…",
          signedName: `${p.toUpperCase()} Referee`,
        },
      });
      await sys.document.create({
        data: { id: `sdoc_${p}1`, clubId: c, title: `${p} handbook`, type: "POLICY", audience: "STAFF", version: 1 },
      });
      await sys.staffDocumentAssignment.create({
        data: { id: `sas_${p}1`, clubId: c, documentId: `sdoc_${p}1`, scope: "ALL" },
      });
      await sys.staffDocumentSignature.create({
        data: {
          id: `ssig_${p}1`,
          clubId: c,
          documentId: `sdoc_${p}1`,
          staffUserId: `u_${p}1`,
          signerName: `Owner ${p.toUpperCase()}`,
          documentVersion: 1,
        },
      });
    }

    // Positive controls, so a later "0 rows" means isolation and not emptiness.
    ok((await A.contractorW9Submission.count()) === 1, "T12.0 A sees its own W-9 submission");
    ok((await A.staffDocumentAssignment.count()) === 1, "T12.1 A sees its own assignment");
    ok((await A.staffDocumentSignature.count()) === 1, "T12.2 A sees its own staff signature");

    // Reads across the tenant — the one that matters most.
    ok(
      (await A.contractorW9Submission.findUnique({ where: { id: "w9_b1" } })) === null,
      "T12.3 A cannot read B's W-9 submission — this one is somebody's tax ID",
    );
    ok((await A.staffDocumentAssignment.findUnique({ where: { id: "sas_b1" } })) === null, "T12.4 A cannot read B's assignment");
    ok((await A.staffDocumentSignature.findUnique({ where: { id: "ssig_b1" } })) === null, "T12.5 A cannot read B's staff signature");
    ok((await A.contractorW9Submission.count({ where: { clubId: "club_b" } })) === 0, "T12.6 A counting B's W-9s gets 0");
    // Not even the ciphertext leaks.
    ok(
      (await A.contractorW9Submission.findMany({ select: { taxIdEncrypted: true } })).every((r) =>
        r.taxIdEncrypted.startsWith("v1:1:a"),
      ),
      "T12.7 and the only ciphertext A can see is its own",
    );

    // Writes into the other club.
    await throws(
      "T12.8 A cannot INSERT a W-9 into club B",
      () =>
        A.contractorW9Submission.create({
          data: {
            id: "evil_w9", clubId: "club_b", contractorId: "con_b1", legalName: "x",
            taxClassification: "INDIVIDUAL", streetAddress: "1", city: "x", state: "OH", zipCode: "45402",
            taxIdKind: "SSN", taxIdEncrypted: "v1:1:aaaa:bbbb:cccc", taxIdLast4: "0001",
            certificationText: "x", signedName: "x",
          },
        }),
      /row-level security|42501/i,
    );
    await throws(
      "T12.9 A cannot INSERT an assignment into club B",
      () => A.staffDocumentAssignment.create({ data: { id: "evil_sas", clubId: "club_b", documentId: "sdoc_b1", scope: "ALL" } }),
      /row-level security|42501/i,
    );
    await throws(
      "T12.10 A cannot INSERT a staff signature into club B",
      () =>
        A.staffDocumentSignature.create({
          data: { id: "evil_ssig", clubId: "club_b", documentId: "sdoc_b1", staffUserId: "u_b1", signerName: "x" },
        }),
      /row-level security|42501/i,
    );

    // ── THE FK-CROSSING FAMILY ──────────────────────────────────────────────
    // Each claims club A — so a clubId-only policy would admit it — while
    // pointing a foreign key at club B.
    await throws(
      "T12.11 A cannot attach its W-9 to B's CONTRACTOR",
      () =>
        A.contractorW9Submission.create({
          data: {
            id: "evil_w92", clubId: "club_a", contractorId: "con_b1", legalName: "x",
            taxClassification: "INDIVIDUAL", streetAddress: "1", city: "x", state: "OH", zipCode: "45402",
            taxIdKind: "SSN", taxIdEncrypted: "v1:1:aaaa:bbbb:cccc", taxIdLast4: "0002",
            certificationText: "x", signedName: "x",
          },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T12.12 A cannot assign B's DOCUMENT",
      () => A.staffDocumentAssignment.create({ data: { id: "evil_sas2", clubId: "club_a", documentId: "sdoc_b1", scope: "ALL" } }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T12.13 A cannot assign a document to B's STAFF MEMBER",
      () =>
        A.staffDocumentAssignment.create({
          data: { id: "evil_sas3", clubId: "club_a", documentId: "sdoc_a1", scope: "STAFF", staffUserId: "u_b1" },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T12.14 A cannot record a signature against B's DOCUMENT",
      () =>
        A.staffDocumentSignature.create({
          data: { id: "evil_ssig2", clubId: "club_a", documentId: "sdoc_b1", staffUserId: "u_a1", signerName: "x" },
        }),
      /row-level security|foreign key|42501|23503/i,
    );
    await throws(
      "T12.15 nor claim B's STAFF MEMBER signed its own document",
      () =>
        A.staffDocumentSignature.create({
          data: { id: "evil_ssig3", clubId: "club_a", documentId: "sdoc_a1", staffUserId: "u_b1", signerName: "x" },
        }),
      /row-level security|foreign key|42501|23503/i,
    );

    // Positive controls: the same shapes must still work inside one club, or
    // the policies are too tight and the feature is broken rather than safe.
    // Phase 12 shipped a policy that refused EVERY insert and looked like
    // perfect isolation, because only its positive control failed.
    const okW9 = await A.contractorW9Submission.create({
      data: {
        id: "good_w9", clubId: "club_a", contractorId: "con_a1", legalName: "A Referee",
        taxClassification: "SOLE_PROPRIETOR", streetAddress: "2 Road", city: "Town", state: "OH",
        zipCode: "45402", taxIdKind: "EIN", taxIdEncrypted: "v1:1:dddddddddddd:eeeeeeeeeeee:ffffffffffff",
        taxIdLast4: "4321", certificationText: "Under penalties of perjury…", signedName: "A Referee",
      },
    });
    ok(okW9.id === "good_w9", "T12.16 …but A CAN file a W-9 against its own contractor");
    await A.contractorW9Submission.delete({ where: { id: "good_w9" } });

    const okSig = await A.staffDocumentSignature.create({
      data: {
        id: "good_ssig", clubId: "club_a", documentId: "sdoc_a1", staffUserId: "u_a1",
        signerName: "A Owner", documentVersion: 2,
      },
    });
    ok(okSig.documentVersion === 2, "T12.17 …and CAN record its own staff signature, at a new version");
    await A.staffDocumentSignature.delete({ where: { id: "good_ssig" } });

    // The CHECK constraint: a PLAINTEXT tax id must be refused by the database
    // itself, not only by the service.
    await throws(
      "T12.18 the database REFUSES a plaintext tax id, whatever the service does",
      () =>
        A.contractorW9Submission.create({
          data: {
            id: "plaintext_w9", clubId: "club_a", contractorId: "con_a1", legalName: "x",
            taxClassification: "INDIVIDUAL", streetAddress: "1", city: "x", state: "OH", zipCode: "45402",
            taxIdKind: "SSN", taxIdEncrypted: "123456789", taxIdLast4: "6789",
            certificationText: "x", signedName: "x",
          },
        }),
      /check constraint|23514/i,
    );
    await throws(
      "T12.19 and a last-four that isn't four digits",
      () =>
        A.contractorW9Submission.create({
          data: {
            id: "badlast4_w9", clubId: "club_a", contractorId: "con_a1", legalName: "x",
            taxClassification: "INDIVIDUAL", streetAddress: "1", city: "x", state: "OH", zipCode: "45402",
            taxIdKind: "SSN", taxIdEncrypted: "v1:1:aaaa:bbbb:cccc", taxIdLast4: "123456789",
            certificationText: "x", signedName: "x",
          },
        }),
      /check constraint|23514/i,
    );

    // Update / delete isolation.
    ok(
      (await A.contractorW9Submission.updateMany({ where: { clubId: "club_b" }, data: { taxIdLast4: "0000" } })).count === 0,
      "T12.20 A cannot rewrite B's W-9",
    );
    ok(
      (await A.staffDocumentSignature.deleteMany({ where: { clubId: "club_b" } })).count === 0,
      "T12.21 A cannot delete B's staff signatures",
    );
    await throws(
      "T12.22 A cannot re-home its W-9 into club B",
      () => A.contractorW9Submission.update({ where: { id: "w9_a1" }, data: { clubId: "club_b" } }),
      /row-level security|42501/i,
    );

    // System check: B is untouched.
    ok((await sys.contractorW9Submission.count({ where: { clubId: "club_b" } })) === 1, "T12.23 system check: B still has its W-9");
    ok(
      (await sys.contractorW9Submission.findUnique({ where: { id: "w9_b1" } }))?.taxIdLast4 === "6789",
      "T12.24 system check: unchanged",
    );
    ok((await sys.staffDocumentSignature.count({ where: { clubId: "club_b" } })) === 1, "T12.25 system check: B still has its signature");

    // Fail closed with no tenant.
    ok((await appBase.contractorW9Submission.findMany()).length === 0, "T12.26 no tenant → 0 W-9 submissions (fail closed)");
    ok((await appBase.staffDocumentAssignment.findMany()).length === 0, "T12.27 …and 0 assignments");
    ok((await appBase.staffDocumentSignature.findMany()).length === 0, "T12.28 …and 0 staff signatures");

    await sys.$disconnect().catch(() => {});
    await appBase.$disconnect().catch(() => {});
    await sysPool.end().catch(() => {});
    await appPool.end().catch(() => {});
    await su.end().catch(() => {});
  } catch (e) {
    console.error("\n[harness] test-phase error:", e);
    fail++;
    failures.push(`fatal: ${(e as Error)?.message}`);
  } finally {
    await epg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  if (fail > 0) {
    console.log("Failures:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[harness] fatal:", e);
  process.exit(1);
});
