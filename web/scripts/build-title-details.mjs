/** Build a display-only overlay. Offline by default; optional bounded public TVmaze lookup. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatTitle } from "../lib/title-format.mjs";
import { selectTvmazeMatch, tvmazeDisplayDetails } from "../lib/title-details.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes("--help")) {
  console.log("node web/scripts/build-title-details.mjs [--python PATH | --local-json PATH] [--tvmaze-limit 100] [--max-requests 200] [--max-seconds 120]");
  process.exit(0);
}
const limit = Number(option("--tvmaze-limit", 0)), maxRequests = Number(option("--max-requests", 200));
const maxSeconds = Number(option("--max-seconds", 120));
if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 600) throw new Error("Use a metadata network time budget of 1–600 seconds.");
const deadline = Date.now() + maxSeconds * 1000;
if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100 || !Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > 250) throw new Error("Use a TVmaze title limit of 0–100 and request budget of 0–250.");
const python = option("--python", path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
let localJson;
if (option("--local-json")) {
  localJson = await readFile(path.resolve(option("--local-json")), "utf8");
} else {
  const extracted = spawnSync(python, [fileURLToPath(new URL("./build-title-details.py", import.meta.url))], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  if (extracted.error) throw extracted.error;
  if (extracted.status !== 0) throw new Error(extracted.stderr || "Local credit extraction failed.");
  localJson = extracted.stdout;
}
const { items, titles } = JSON.parse(localJson);
for (const [id, item] of Object.entries(items)) item.displayTitle = formatTitle({ movieId: Number(id), title: titles[id] });
const tv = JSON.parse(await readFile(path.join(root, "web/public/tv-model/metadata.json"), "utf8")).items
  .filter(item => item.candidate && item.eligible).sort((a, b) => b.popularity - a.popularity || a.movieId - b.movieId);
const cacheDir = path.join(root, "data/title_details/tvmaze");
let requests = 0, matches = 0, posters = 0, lastRequest = 0;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function get(url, online) {
  const file = path.join(cacheDir, `${createHash("sha256").update(url).digest("hex")}.json`);
  try { const saved = JSON.parse(await readFile(file, "utf8")); if (saved.url === url) return saved.body; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!online || requests >= maxRequests || Date.now() >= deadline) return null;
  await mkdir(cacheDir, { recursive: true });
  for (let attempt = 0; attempt < 3 && requests < maxRequests && Date.now() < deadline; attempt++) {
    await wait(Math.max(0, 650 - (Date.now() - lastRequest)));
    requests++; lastRequest = Date.now();
    const response = await fetch(url, { headers: { "User-Agent": "Afterglow-public-catalog-metadata/1.0" }, signal: AbortSignal.timeout(12_000) });
    if (response.status === 429) { await response.body?.cancel(); await wait(2000 * (attempt + 1)); continue; }
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json();
    await writeFile(file, JSON.stringify({ url, fetchedAt: new Date().toISOString(), body }) + "\n");
    return body;
  }
  return null;
}
for (let index = 0; index < tv.length; index++) {
  const item = tv[index], details = items[item.movieId], online = index < limit;
  try {
    const candidates = await get(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(details.displayTitle)}`, online);
    const match = selectTvmazeMatch(candidates, { title: details.displayTitle, alternateTitle: item.alternateTitle, year: item.year });
    if (!match) continue;
    matches++;
    const seasons = await get(`https://api.tvmaze.com/shows/${match.id}/seasons`, online);
    Object.assign(details, tvmazeDisplayDetails(match, seasons));
    if (details.posterUrl) posters++;
  } catch (error) { console.warn(`TV metadata lookup skipped for source ${item.sourceId}: ${error.message}`); }
  if (online && (index + 1) % 10 === 0) console.log(`TV metadata checked ${index + 1}/${limit}; exact matches ${matches}; requests ${requests}/${maxRequests}.`);
}
const output = { version: 1, generatedAt: new Date().toISOString(), items };
const destination = path.join(root, "web/public/catalog/title-details.json");
await writeFile(destination, JSON.stringify(output) + "\n");
console.log(JSON.stringify({ output: "web/public/catalog/title-details.json", titles: Object.keys(items).length,
  cast: Object.values(items).filter(item => item.cast.length).length, directors: Object.values(items).filter(item => item.directors.length).length,
  matchedTvmaze: matches, realTvPosters: posters, networkRequests: requests, bytes: Buffer.byteLength(JSON.stringify(output)) }));
