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
