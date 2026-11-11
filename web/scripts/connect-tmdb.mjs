/** Masked-input companion. Never accepts a secret through argv or environment. */
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const expected = {
  name: "afterglow",
  account: "343544d8940678769ca0ac473363673b",
  database: "6bb2dc5f-04dc-49dc-bf56-27de20bb137e",
  origin: "https://afterglow.clarkbrendenj.workers.dev",
};
const configPath = path.join(webRoot, ".independent/wrangler.json");
const deploymentPath = path.join(webRoot, ".independent/deployment.json");
const wranglerCli = path.join(webRoot, "node_modules/wrangler/wrangler-dist/cli.js");
const messages = {
  10: "Afterglow setup verification failed. Check the existing deployment configuration and Node/Wrangler installation.",
  11: "Enter the TMDB API Read Access Token, not the API key. Nothing was stored.",
  12: "TMDB verification failed. Check the API Read Access Token and your connection, then try again. Nothing was stored.",
  13: "TMDB verified, but Cloudflare did not confirm storage. Check your existing Wrangler sign-in and try again.",
};

function fail(code) { const error = new Error("Connection step failed."); error.code = code; throw error; }

async function verifyTarget() {
  try {
    if (Number(process.versions.node.split(".")[0]) < 22) fail(10);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
    const bindings = config.d1_databases?.filter(binding => binding.binding === "DB");
    const url = new URL(deployment.url);
    if (config.name !== expected.name || config.account_id !== expected.account || bindings?.length !== 1
      || bindings[0].database_id !== expected.database || deployment.worker !== expected.name
      || deployment.accountId !== expected.account || deployment.databaseId !== expected.database
      || url.origin !== expected.origin || url.pathname !== "/" || url.search || url.hash || url.username || url.password
      || config.workers_dev === false || config.route !== undefined
      || (config.routes !== undefined && (!Array.isArray(config.routes) || config.routes.length !== 0))) fail(10);
    await access(wranglerCli, constants.R_OK);
  } catch { fail(10); }
}

async function readToken() {
  if (process.stdin.isTTY) fail(11);
  const chunks = [];
  let combined;
  let size = 0;
  try {
    for await (const value of process.stdin) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      chunks.push(chunk);
      size += chunk.length;
      if (size > 8192) fail(11);
    }
    combined = Buffer.concat(chunks);
    const token = combined.toString("utf8").trim();
    if (token.length < 40 || token.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(token)) fail(11);
    return token;
  } catch {
    fail(11);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    combined?.fill(0);
  }
}

async function verifyTmdb(token) {
  try {
    const response = await fetch("https://api.themoviedb.org/3/configuration", {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel(); fail(12); }
    const configuration = await response.json();
    if (configuration.images?.secure_base_url !== "https://image.tmdb.org/t/p/"
      || !Array.isArray(configuration.images.poster_sizes)
      || !configuration.images.poster_sizes.includes("original")) fail(12);
  } catch { fail(12); }
}

function storeWithWrangler(token) {
  // Keep normal OAuth discovery. Never put this token in env, command arguments,
  // debug logs, telemetry, temporary files, or forwarded Wrangler error output.
  const env = { ...process.env, CI: "true", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG: "none",
    WRANGLER_LOG_SANITIZE: "true", WRANGLER_SEND_METRICS: "false" };
  for (const key of ["TMDB_API_READ_TOKEN", "NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_TLS_REJECT_UNAUTHORIZED",
    "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL",
    "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "WRANGLER_API_ENVIRONMENT"]) delete env[key];
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-vm-modules", wranglerCli,
      "secret", "put", "TMDB_API_READ_TOKEN", "--config", ".independent/wrangler.json"], {
      cwd: webRoot, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 120000,
    });
    child.stdout.resume(); child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
    child.stdin.end(token + "\n");
  });
}

let token = "";
try {
  // Do not honor ambient insecure TLS settings for the token verification call.
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--check-target")) fail(10);
  await verifyTarget();
  if (args[0] === "--check-target") {
    console.log("Existing Afterglow deployment target verified.");
  } else {
    token = await readToken();
    await verifyTmdb(token);
    // Recheck the fixed destination immediately before the only write operation.
    await verifyTarget();
    if (!await storeWithWrangler(token)) fail(13);
    console.log("TMDB verified. The token is stored as an encrypted Cloudflare Worker secret for Afterglow.");
  }
} catch (error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 13;
  console.error(messages[code]);
  process.exitCode = code;
} finally {
  token = "";
}
