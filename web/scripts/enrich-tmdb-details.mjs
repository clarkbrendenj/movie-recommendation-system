/**
 * Bounded display-only enrichment; frozen models and title-details.json stay unchanged.
 * Credentials: TMDB_API_READ_TOKEN environment variable only. Never pass a token as an argument.
 * Example: node web/scripts/enrich-tmdb-details.mjs --type movies --limit 40 --max-requests 80 --max-seconds 90
 * Cache contains public responses and URLs only; Authorization headers are never persisted.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatTitle } from "../lib/title-format.mjs";
import { isValidImdbId, isValidTmdbId, matchesTmdbMovie, selectTmdbMovieMatch, selectTmdbTvMatch, tmdbDisplayDetails } from "../lib/tmdb-details.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
class BudgetReached extends Error {}
class EnrichmentError extends Error {}
const allowedFields = new Set(["posterUrl", "cast", "directors", "creators", "seasonCount", "seasonCountAsOf", "endYear", "tmdbId", "metadataSource", "creditsSource"]);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new EnrichmentError("A local metadata/cache JSON file is invalid or unavailable."); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node web/scripts/enrich-tmdb-details.mjs [--type movies|series|both] [--limit 40] [--max-requests 120] [--max-seconds 90]");
    console.log("Set TMDB_API_READ_TOKEN in the process environment. Output: web/public/catalog/title-details-tmdb.json. No credentials belong in arguments or files.");
    return;
  }
  const allowedOptions = new Set(["--type", "--limit", "--max-requests", "--max-seconds"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowedOptions.has(args[index]) || args[index + 1] === undefined) throw new EnrichmentError("Unsupported or missing option. Run with --help; credentials must only come from the environment.");
  }
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const type = option("--type", "both"), limit = Number(option("--limit", "40"));
  const maxRequests = Number(option("--max-requests", "120")), maxSeconds = Number(option("--max-seconds", "90"));
  if (!["movies", "series", "both"].includes(type) || !Number.isInteger(limit) || limit < 1 || limit > 200
      || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 500
      || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300) throw new EnrichmentError("Use a limit of 1–200 titles, 1–500 requests and 1–300 seconds, with movies, series or both.");
  const token = (process.env.TMDB_API_READ_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  if (!token || /\s/.test(token)) throw new EnrichmentError("Set TMDB_API_READ_TOKEN to your TMDB API Read Access Token before running. No network requests were made.");

  const deadline = Date.now() + maxSeconds * 1000;
  const cacheDir = path.join(root, "data/title_details/tmdb");
  const outputPath = path.join(root, "web/public/catalog/title-details-tmdb.json");
  const stats = { requests: 0, cacheHits: 0, checked: 0, matched: 0, skipped: 0, networkFailures: 0, budgetExhausted: false };
  let lastRequest = 0;

  async function get(endpoint) {
    const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
    if (url.origin !== "https://api.themoviedb.org" || !url.pathname.startsWith("/3/") || url.searchParams.has("api_key")) throw new EnrichmentError("Invalid TMDB request path.");
    const file = path.join(cacheDir, `${createHash("sha256").update(url.href).digest("hex")}.json`);
    const saved = await readJson(file, null);
    if (saved?.url === url.href && saved.body && Date.now() - Date.parse(saved.fetchedAt) < 30 * 86400000) { stats.cacheHits++; return saved; }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stats.requests >= maxRequests || Date.now() >= deadline) throw new BudgetReached();
      const delay = Math.max(0, 350 - (Date.now() - lastRequest));
      if (Date.now() + delay >= deadline) throw new BudgetReached();
      await sleep(delay);
      stats.requests++; lastRequest = Date.now();
      let response;
      try {
        response = await fetch(url, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - Date.now()))) });
      } catch { stats.networkFailures++; return null; }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new EnrichmentError("TMDB rejected application authentication. Check TMDB_API_READ_TOKEN; the credential was not logged or saved."); }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        const retryDelay = Math.min(10000, Math.max(1000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1500));
        if (Date.now() + retryDelay >= deadline) throw new BudgetReached();
        await sleep(retryDelay); continue;
      }
      if (!response.ok) { await response.body?.cancel(); return null; }
      let body;
      try { body = await response.json(); } catch { stats.networkFailures++; return null; }
      const envelope = { url: url.href, fetchedAt: new Date().toISOString(), body };
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(envelope) + "\n");
      return envelope;
    }
    return null;
  }

  const movieMetadata = await readJson(path.join(root, "web/public/model/metadata.json"));
  const tvMetadata = await readJson(path.join(root, "web/public/tv-model/metadata.json"));
  const localDetails = await readJson(path.join(root, "web/public/catalog/title-details.json"), { items: {} });
  const excluded = new Set((await readJson(path.join(root, "web/public/catalog/movie-unit-exclusions.json"))).excludedItems.map(item => item.movieId));
  const movies = movieMetadata.movies.filter(item => !excluded.has(item.movieId)).map(item => ({ ...item, mediaType: "movie" }));
  const series = tvMetadata.items.filter(item => item.eligible && item.candidate && item.mediaType === "series");
  const byId = new Map([...movies, ...series].map(item => [String(item.movieId), item]));
  const previous = await readJson(outputPath, { version: 1, items: {} });
  const items = {};
  if (previous.version === 1 && previous.items && typeof previous.items === "object") {
    for (const [id, details] of Object.entries(previous.items)) {
      if (byId.has(id) && details && typeof details === "object") items[id] = Object.fromEntries(Object.entries(details).filter(([field]) => allowedFields.has(field)));
    }
  }
  const links = new Map();
  const rows = (await readFile(path.join(root, "data/raw/ml-latest-small/links.csv"), "utf8")).trim().replace(/^\uFEFF/, "").split(/\r?\n/);
  if (rows.shift() !== "movieId,imdbId,tmdbId") throw new EnrichmentError("Unexpected MovieLens links.csv columns; no guessed crosswalk was used.");
  for (const row of rows) {
    const [movieId, rawImdb, rawTmdb] = row.split(","), imdbId = /^[0-9]{1,10}$/.test(rawImdb || "") ? `tt${rawImdb.padStart(7, "0")}` : "";
    const tmdbId = /^[0-9]+$/.test(rawTmdb || "") ? Number(rawTmdb) : undefined;
    if (isValidImdbId(imdbId)) links.set(Number(movieId), { imdbId, ...(isValidTmdbId(tmdbId) ? { tmdbId } : {}) });
  }
  const rankedMovies = movies.sort((a, b) => b.popularity - a.popularity || a.movieId - b.movieId);
  const rankedSeries = series.sort((a, b) => b.popularity - a.popularity || a.movieId - b.movieId);
  let candidates;
  if (type === "movies") candidates = rankedMovies;
  else if (type === "series") candidates = rankedSeries;
  else {
    candidates = [];
    for (let index = 0; index < Math.max(rankedMovies.length, rankedSeries.length); index++) {
      if (rankedMovies[index]) candidates.push(rankedMovies[index]);
      if (rankedSeries[index]) candidates.push(rankedSeries[index]);
    }
  }

  let imageOptions;
  try {
    const config = (await get("configuration"))?.body?.images;
    if (!config || !Array.isArray(config.poster_sizes)) throw new EnrichmentError("TMDB image configuration is unavailable within this budget.");
    const posterSize = config.poster_sizes.includes("w342") ? "w342" : config.poster_sizes.includes("w500") ? "w500" : null;
    if (!posterSize || config.secure_base_url !== "https://image.tmdb.org/t/p/") throw new EnrichmentError("TMDB returned an unsupported image base or poster size.");
    imageOptions = { imageBaseUrl: config.secure_base_url, posterSize };

    for (const item of candidates.slice(0, limit)) {
      if (Date.now() >= deadline) throw new BudgetReached();
      stats.checked++;
      let envelope = null;
      if (item.mediaType === "movie") {
        let identity = links.get(item.movieId);
        if (!identity) { stats.skipped++; continue; }
        if (!identity.tmdbId) {
          const found = await get(`find/${identity.imdbId}?external_source=imdb_id&language=en-US`);
          const match = selectTmdbMovieMatch(found?.body, identity);
          if (!match) { stats.skipped++; continue; }
          identity = { ...identity, tmdbId: match.id };
        }
        const response = await get(`movie/${identity.tmdbId}?append_to_response=credits&language=en-US`);
        if (response && matchesTmdbMovie(response.body, identity)) envelope = response;
      } else {
        const target = { title: localDetails.items[item.movieId]?.displayTitle || formatTitle(item), alternateTitle: item.alternateTitle, year: item.year };
        const queries = [...new Set([target.title, target.alternateTitle].filter(Boolean))];
        const results = [];
        let complete = true;
        for (const query of queries) {
          const search = await get(`search/tv?query=${encodeURIComponent(query)}&first_air_date_year=${item.year}&include_adult=false&language=en-US&page=1`);
          if (!search || Number(search.body?.total_pages) > 1 || !Array.isArray(search.body?.results)) { complete = false; break; }
          results.push(...search.body.results);
        }
        const match = complete ? selectTmdbTvMatch(results, target) : null;
        if (match) {
          const response = await get(`tv/${match.id}?append_to_response=aggregate_credits&language=en-US`);
          if (response?.body?.id === match.id && selectTmdbTvMatch([response.body], target)) envelope = response;
        }
      }
      if (!envelope) { stats.skipped++; continue; }
      items[item.movieId] = tmdbDisplayDetails(envelope.body, { mediaType: item.mediaType, ...imageOptions, asOf: envelope.fetchedAt.slice(0, 10) });
      stats.matched++;
      if (stats.checked % 10 === 0) console.log(`TMDB public titles checked ${stats.checked}/${limit}; matched ${stats.matched}; requests ${stats.requests}/${maxRequests}.`);
    }
  } catch (error) {
    if (!(error instanceof BudgetReached)) throw error;
    stats.budgetExhausted = true;
  }
  const output = { version: 1, provider: "TMDB", generatedAt: new Date().toISOString(), items };
  await writeFile(outputPath, JSON.stringify(output) + "\n");
  console.log(JSON.stringify({ ...stats, output: "web/public/catalog/title-details-tmdb.json", totalEnrichedTitles: Object.keys(items).length }));
}

main().catch(error => {
  console.error(error instanceof EnrichmentError ? error.message : "TMDB enrichment failed. No credentials were printed; check local metadata files and retry with a bounded budget.");
  process.exitCode = 1;
});
