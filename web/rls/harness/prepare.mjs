// Copies the repo's real schema into the harness and enables the
// driverAdapters preview (the harness talks to its throwaway Postgres through
// @prisma/adapter-pg, which needs no separate engine download). The repo's
// own schema/client are never modified.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "..", "prisma", "schema.prisma");
const outDir = path.join(here, "prisma");
fs.mkdirSync(outDir, { recursive: true });

let schema = fs.readFileSync(src, "utf8");
if (!schema.includes("engineType")) {
  // engineType = "client": pure-TS/WASM client, requires a driver adapter and
  // downloads no native engine. The repo's own generator block is untouched.
  schema = schema.replace(
    'provider = "prisma-client-js"',
    'provider = "prisma-client-js"\n  engineType = "client"',
  );
}
fs.writeFileSync(path.join(outDir, "schema.prisma"), schema);

try {
  execSync("npx prisma generate", {
    cwd: here,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
      DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
      PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: "1",
    },
  });
} catch (e) {
  // In network-restricted environments `prisma generate` can exit non-zero
  // AFTER emitting the client (it fails fetching auxiliary native engines the
  // harness never uses — the runtime path is WASM via @prisma/adapter-pg).
  // Only fail if the client truly wasn't generated.
  const clientDir = path.join(here, "node_modules", ".prisma", "client");
  if (!fs.existsSync(path.join(clientDir, "index.js"))) throw e;
  console.warn("[prepare] prisma generate warned (engine download blocked) — WASM client generated, continuing");
}
console.log("[prepare] harness schema + client ready");
