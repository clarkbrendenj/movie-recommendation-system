/** Generate a direct Cloudflare deployment config; never reads Sites credentials. */
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
if (args.includes("--help")) {
  console.log("node scripts/prepare-independent.mjs --database-id <D1 UUID> [--name afterglow] [--account-id <Cloudflare account ID>]");
  process.exit(0);
}
const databaseId = option("--database-id");
const name = option("--name") || "afterglow";
const accountId = option("--account-id");
if (!databaseId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId)
    || databaseId === "00000000-0000-4000-8000-000000000000") {
  throw new Error("Provide the real D1 database UUID returned by `wrangler d1 create afterglow-db`.");
}
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Use a lowercase Worker name containing letters, digits and hyphens.");
if (accountId && !/^[0-9a-f]{32}$/i.test(accountId)) throw new Error("Invalid Cloudflare account ID.");
await access(path.join(root, "dist/server/index.js"));
const built = JSON.parse(await readFile(path.join(root, "dist/server/wrangler.json"), "utf8"));
const config = {
  name,
  ...(accountId ? { account_id: accountId } : {}),
  main: "../dist/server/index.js",
  compatibility_date: built.compatibility_date,
  compatibility_flags: built.compatibility_flags,
  no_bundle: true,
  rules: built.rules,
  assets: { binding: "ASSETS", directory: "../dist/client" },
  d1_databases: [{ binding: "DB", database_name: "afterglow-db", database_id: databaseId, migrations_dir: "../drizzle" }],
  observability: { enabled: true },
};
await mkdir(path.join(root, ".independent"), { recursive: true });
const output = path.join(root, ".independent/wrangler.json");
await writeFile(output, JSON.stringify(config, null, 2) + "\n");
console.log(`Prepared ${output}`);
console.log("No cloud resources were created or deployed. Apply D1 migrations and deploy with this config after authenticating to your own Cloudflare account.");
