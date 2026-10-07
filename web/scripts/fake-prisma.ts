/**
 * A small in-memory stand-in for the Prisma client, for tests that have to run
 * real library code end to end without a database (scripts/class-topup-tests.ts,
 * scripts/class-staff-server-tests.ts). NOT a test itself.
 *
 * It implements just what those libraries use — findMany / findFirst /
 * findUnique / count / create / createMany(skipDuplicates) / update /
 * updateMany / upsert / deleteMany, `where` with equality, in / notIn / gt(e) /
 * lt(e) / not, OR, to-one and to-many (`some`) relation filters, `select` with
 * relations and `_count`, single-level `orderBy`, unique keys, and
 * $transaction — and it THROWS on anything it does not understand, so a query
 * the fake cannot answer fails the test loudly instead of passing by accident.
 * A plain `create` that violates a unique key throws, like the database would.
 *
 * Use:  const db = makeFakeDb({ relations, uniques });  installFakePrisma(db.client);
 *       then `require` the library under test (so it picks up the stub).
 */
import Module from "node:module";
import { Prisma } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any; // fixture rows are free-form
export type Relation = { model: string; kind: "one" | "many"; fk: string };
export type FakeConfig = {
  /** relations[model][field] — for `one`, fk is on this model; for `many`, fk is on the other model. */
  relations: Record<string, Record<string, Relation>>;
  /** uniques[model] = list of unique column sets. */
  uniques?: Record<string, string[][]>;
};

const isDate = (v: unknown): v is Date => v instanceof Date;
const same = (a: unknown, b: unknown) => (isDate(a) && isDate(b) ? a.getTime() === b.getTime() : a === b);
const cmp = (a: any, b: any) => (isDate(a) ? a.getTime() : a) - (isDate(b) ? b.getTime() : b);
const lt = (a: any, b: any) => (typeof a === "string" ? a < b : cmp(a, b) < 0);

export function makeFakeDb(cfg: FakeConfig) {
  const tables: Record<string, Row[]> = {};
  const calls: { model: string; method: string; args: any }[] = [];
  let seq = 0;
  const table = (m: string) => (tables[m] ??= []);
  const rel = (m: string, f: string): Relation | undefined => cfg.relations[m]?.[f];

  function scalarMatch(v: any, cond: any): boolean {
    if (cond === null) return v === null || v === undefined;
    if (isDate(cond) || typeof cond !== "object") return same(v, cond);
    for (const [op, x] of Object.entries(cond)) {
      if (op === "in") { if (!(x as any[]).some((y) => same(v, y))) return false; }
      else if (op === "notIn") { if ((x as any[]).some((y) => same(v, y))) return false; }
      else if (op === "equals") { if (!same(v, x)) return false; }
      else if (op === "not") { if (x === null ? v === null || v === undefined : same(v, x)) return false; }
      else if (op === "gte") { if (v == null || lt(v, x)) return false; }
      else if (op === "gt") { if (v == null || !lt(x, v)) return false; }
      else if (op === "lte") { if (v == null || lt(x, v)) return false; }
      else if (op === "lt") { if (v == null || !lt(v, x)) return false; }
      else if (op === "array_contains") { if (!Array.isArray(v) || !(x as any[]).every((y) => v.includes(y))) return false; }
      else throw new Error(`fake-prisma: unsupported filter operator "${op}"`);
    }
    return true;
  }

  function matches(model: string, row: Row, where: any): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === "OR") { if (!(cond as any[]).some((w) => matches(model, row, w))) return false; continue; }
      if (k === "AND") { if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(model, row, w))) return false; continue; }
      if (k === "NOT") { if (matches(model, row, cond)) return false; continue; }
      const r = rel(model, k);
      if (r) {
        if (r.kind === "one") {
          const other = table(r.model).find((o) => o.id === row[r.fk]);
          if (!other || !matches(r.model, other, cond)) return false;
        } else {
          const others = table(r.model).filter((o) => o[r.fk] === row.id);
          const c = cond as any;
          if (c.some !== undefined) { if (!others.some((o) => matches(r.model, o, c.some))) return false; }
          else if (c.none !== undefined) { if (others.some((o) => matches(r.model, o, c.none))) return false; }
          else throw new Error(`fake-prisma: unsupported relation filter on ${model}.${k}`);
        }
        continue;
      }
      // compound unique selector, e.g. classId_date: { classId, date }
      if (k.includes("_") && cond && typeof cond === "object" && !isDate(cond) && !(k in row)) {
        if (!Object.entries(cond as Row).every(([c, v]) => same(row[c], v))) return false;
        continue;
      }
      if (!scalarMatch(row[k], cond)) return false;
    }
    return true;
  }

  function order(rows: Row[], orderBy: any): Row[] {
    if (!orderBy) return rows;
    const list = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [f, dir] of list) {
        if (typeof dir !== "string") continue; // relation ordering: not needed by the tests
        const x = a[f], y = b[f];
        if (same(x, y)) continue;
        const less = typeof x === "string" ? x < y : cmp(x, y) < 0;
        return (less ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  }

  function shape(model: string, row: Row, args: any): Row {
    const sel = args?.select;
    const inc = args?.include;
    if (!sel) {
      const out: Row = { ...row };
      for (const [k, v] of Object.entries(inc ?? {})) if (v) out[k] = related(model, row, k, v);
      return out;
    }
    const out: Row = {};
    for (const [k, v] of Object.entries(sel)) {
      if (!v) continue;
      if (k === "_count") {
        out._count = {};
        for (const f of Object.keys((v as any).select ?? {})) {
          const r = rel(model, f);
          if (!r) throw new Error(`fake-prisma: _count on unknown relation ${model}.${f}`);
          out._count[f] = table(r.model).filter((o) => o[r.fk] === row.id).length;
        }
        continue;
      }
      out[k] = rel(model, k) ? related(model, row, k, v) : row[k] === undefined ? null : row[k];
    }
    return out;
  }

  function related(model: string, row: Row, field: string, args: any): any {
    const r = rel(model, field);
    if (!r) return row[field] === undefined ? null : row[field]; // an inline fixture value
    const sub = args === true ? undefined : args;
    if (r.kind === "one") {
      const other = table(r.model).find((o) => o.id === row[r.fk]);
      return other ? shape(r.model, other, sub) : null;
    }
    const others = table(r.model).filter((o) => o[r.fk] === row.id && matches(r.model, o, sub?.where));
    return order(others, sub?.orderBy).map((o) => shape(r.model, o, sub));
  }

  const clean = (data: Row): Row => {
    const out: Row = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      out[k] = v === Prisma.DbNull || v === Prisma.JsonNull ? null : v;
    }
    return out;
  };
  const uniqueClash = (model: string, data: Row, ignoreId?: string) =>
    (cfg.uniques?.[model] ?? []).some((cols) =>
      table(model).some((o) => o.id !== ignoreId && cols.every((c) => same(o[c], data[c]))));

  function insert(model: string, data: Row): Row {
    const row: Row = { ...clean(data) };
    if (row.id === undefined && model !== "clubScheduleSettings") row.id = `${model}_${++seq}`;
    if (row.createdAt === undefined) row.createdAt = new Date(Date.UTC(2026, 0, 1) + ++seq);
    table(model).push(row);
    return row;
  }

  function delegate(model: string) {
    const log = (method: string, args: any) => calls.push({ model, method, args });
    return {
      async findMany(args: any = {}) { log("findMany", args); return order(table(model).filter((r) => matches(model, r, args.where)), args.orderBy).map((r) => shape(model, r, args)); },
      async findFirst(args: any = {}) { log("findFirst", args); const r = order(table(model).filter((x) => matches(model, x, args.where)), args.orderBy)[0]; return r ? shape(model, r, args) : null; },
      async findUnique(args: any = {}) { log("findUnique", args); const r = table(model).find((x) => matches(model, x, args.where)); return r ? shape(model, r, args) : null; },
      async count(args: any = {}) { log("count", args); return table(model).filter((r) => matches(model, r, args.where)).length; },
      async create(args: any) {
        log("create", args);
        if (uniqueClash(model, clean(args.data))) throw new Error(`fake-prisma: unique constraint failed on ${model}`);
        return shape(model, insert(model, args.data), args);
      },
      async createMany(args: any) {
        log("createMany", args);
        let count = 0;
        for (const d of Array.isArray(args.data) ? args.data : [args.data]) {
          if (uniqueClash(model, clean(d))) {
            if (args.skipDuplicates) continue;
            throw new Error(`fake-prisma: unique constraint failed on ${model}`);
          }
          insert(model, d);
          count++;
        }
        return { count };
      },
      async update(args: any) {
        log("update", args);
        const r = table(model).find((x) => matches(model, x, args.where));
        if (!r) throw new Error(`fake-prisma: ${model}.update found no row`);
        Object.assign(r, clean(args.data));
        return shape(model, r, args);
      },
      async updateMany(args: any) {
        log("updateMany", args);
        const hit = table(model).filter((x) => matches(model, x, args.where));
        for (const r of hit) Object.assign(r, clean(args.data));
        return { count: hit.length };
      },
      async upsert(args: any) {
        log("upsert", args);
        const r = table(model).find((x) => matches(model, x, args.where));
        if (r) { Object.assign(r, clean(args.update)); return shape(model, r, args); }
        return shape(model, insert(model, args.create), args);
      },
      async delete(args: any) {
        log("delete", args);
        const r = table(model).find((x) => matches(model, x, args.where));
        if (!r) throw new Error(`fake-prisma: ${model}.delete found no row`);
        tables[model] = table(model).filter((x) => x !== r);
        return shape(model, r, args);
      },
      async deleteMany(args: any = {}) {
        log("deleteMany", args);
        const keep = table(model).filter((x) => !matches(model, x, args.where));
        const count = table(model).length - keep.length;
        tables[model] = keep;
        return { count };
      },
    };
  }

  const delegates: Record<string, ReturnType<typeof delegate>> = {};
  const client: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      if (prop === "$transaction") return async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(client));
      if (prop === "$disconnect") return async () => {};
      return (delegates[prop] ??= delegate(prop));
    },
  });

  return {
    client,
    tables,
    table,
    calls,
    /** Put fixture rows in a table (ids kept as given). */
    seed(model: string, rows: Row[]) { for (const r of rows) table(model).push({ ...r }); },
    /** Writes made since the last resetCalls(). */
    writes() { return calls.filter((c) => !/^(find|count)/.test(c.method)); },
    resetCalls() { calls.length = 0; },
  };
}

/** Route every `@/lib/prisma` import to the fake. Call BEFORE requiring the code under test. */
export function installFakePrisma(client: unknown, extra: Record<string, unknown> = {}) {
  const M = Module as unknown as { _load: (...a: unknown[]) => unknown };
  const orig = M._load;
  M._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, ...rest: unknown[]) {
    if (request === "@/lib/prisma" || request.endsWith("/lib/prisma") || (request === "./prisma" && /[\\/]lib[\\/]/.test(parent?.filename ?? ""))) {
      return { prisma: client, default: client };
    }
    for (const [name, mod] of Object.entries(extra)) {
      if (request === name || request.endsWith(name.replace(/^@/, ""))) return mod;
    }
    return orig.call(this, request, parent, ...rest);
  } as never;
}
