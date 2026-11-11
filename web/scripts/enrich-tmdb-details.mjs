/**
 * Bounded display-only enrichment; frozen models and title-details.json stay unchanged.
 * Credentials: TMDB_API_READ_TOKEN environment variable only. Never pass a token as an argument.
 * Example: node web/scripts/enrich-tmdb-details.mjs --type movies --limit 40 --max-requests 80 --max-seconds 90
 * Cache contains public responses and URLs only; Authorization headers are never persisted.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatTitle } from "../lib/title-format.mjs";
import { isValidImdbId, isValidTmdbId, matchesTmdbMovie, selectTmdbMovieMatch, selectTmdbTvMatch, tmdbDisplayDetails, selectTmdbPoster } from "../lib/tmdb-details.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
class BudgetReached extends Error {}
class EnrichmentError extends Error {}
class TransientFailure extends Error {}
const allowedFields = new Set(["posterUrl", "cast", "directors", "creators", "seasonCount", "seasonCountAsOf", "endYear", "tmdbId", "metadataSource", "creditsSource"]);
const stableStatuses = new Set(["poster", "matched-no-poster", "unmatched", "ambiguous"]);
const reasons = new Set(["network", "upstream", "rate-limited", "invalid-response", "identity-conflict", "incomplete-search", "no-exact-match", "missing-identity", "images-unavailable", "budget", "authentication"]);
const ttl = 30 * 86400000;

/** Pure resume rule. Transient failures are never treated as completed work. */
export function isRecentCompleted(outcome, now = Date.now()) {
  const checked = Date.parse(outcome?.checkedAt);
  const expires = outcome?.expiresAt ? Date.parse(outcome.expiresAt) : checked + ttl;
  return stableStatuses.has(outcome?.status) && Number.isFinite(checked) && checked <= now + 300000
    && Number.isFinite(expires) && now < Math.min(expires, checked + ttl);
}

/** Pure selection: apply offset before skipping completed IDs, then bound new work. */
export function pendingTitles(candidates, outcomes, { offset = 0, limit = 40, refresh = false, now = Date.now() } = {}) {
  return candidates.slice(offset).filter(item => refresh || !isRecentCompleted(outcomes[String(item.movieId)], now)).slice(0, limit);
}

/** Retain only fixed public outcome fields for IDs in the eligible catalog. */
export function sanitizeOutcomes(raw, eligibleIds) {
  const result = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [id, value] of Object.entries(raw)) {
    if (!eligibleIds.has(id) || !value || typeof value !== "object"
        || (!stableStatuses.has(value.status) && value.status !== "transient") || !Number.isFinite(Date.parse(value.checkedAt))) continue;
    result[id] = { status: value.status, checkedAt: new Date(value.checkedAt).toISOString(), provider: "TMDB",
      ...(Number.isFinite(Date.parse(value.expiresAt)) ? { expiresAt: new Date(value.expiresAt).toISOString() } : {}),
      ...(reasons.has(value.reason) ? { reason: value.reason } : {}),
      ...(isValidTmdbId(value.providerId) ? { providerId: value.providerId } : {}),
      ...(value.imagesChecked === true ? { imagesChecked: true } : {}) };
  }
  return result;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new EnrichmentError("A local metadata/cache JSON file is invalid or unavailable."); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node web/scripts/enrich-tmdb-details.mjs [--type movies|series|both] [--offset 0] [--limit 40] [--max-requests 120] [--max-seconds 90] [--refresh]");
    console.log("Set TMDB_API_READ_TOKEN in the process environment. Output: web/public/catalog/title-details-tmdb.json. No credentials belong in arguments or files.");
    return;
  }
  const allowedOptions = new Set(["--type", "--offset", "--limit", "--max-requests", "--max-seconds"]);
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === "--refresh") { index--; continue; }
    if (!allowedOptions.has(args[index]) || args[index + 1] === undefined) throw new EnrichmentError("Unsupported or missing option. Run with --help; credentials must only come from the environment.");
  }
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const type = option("--type", "both"), limit = Number(option("--limit", "40"));
  const offset = Number(option("--offset", "0")), refresh = args.includes("--refresh");
  const maxRequests = Number(option("--max-requests", "120")), maxSeconds = Number(option("--max-seconds", "90"));
  if (!["movies", "series", "both"].includes(type) || !Number.isInteger(offset) || offset < 0 || offset > 8533 || !Number.isInteger(limit) || limit < 1 || limit > 200
      || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 500
      || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300) throw new EnrichmentError("Use offset 0–8533, a limit of 1–200 titles, 1–500 requests and 1–300 seconds, with movies, series or both.");
  const token = (process.env.TMDB_API_READ_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  if (!token || /\s/.test(token)) throw new EnrichmentError("Set TMDB_API_READ_TOKEN to your TMDB API Read Access Token before running. No network requests were made.");

  const deadline = Date.now() + maxSeconds * 1000;
  const cacheDir = path.join(root, "data/title_details/tmdb");
  const outputPath = path.join(root, "web/public/catalog/title-details-tmdb.json");
  const stats = { requests: 0, cacheHits: 0, checked: 0, matched: 0, skipped: 0, networkFailures: 0, budgetExhausted: false };
  let lastRequest = 0, evidenceDates = null;

  async function get(endpoint) {
    const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
    if (url.origin !== "https://api.themoviedb.org" || !url.pathname.startsWith("/3/") || url.searchParams.has("api_key")) throw new EnrichmentError("Invalid TMDB request path.");
    const file = path.join(cacheDir, `${createHash("sha256").update(url.href).digest("hex")}.json`);
    const saved = await readJson(file, null);
    const age = Date.now() - Date.parse(saved?.fetchedAt);
    if (saved?.url === url.href && saved.body && age >= 0 && age < ttl) { stats.cacheHits++; evidenceDates?.push(Date.parse(saved.fetchedAt)); return saved; }
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
      } catch { stats.networkFailures++; throw new TransientFailure("network"); }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new EnrichmentError("TMDB rejected application authentication. Check TMDB_API_READ_TOKEN; the credential was not logged or saved."); }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        const retryDelay = Math.min(10000, Math.max(1000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1500));
        if (Date.now() + retryDelay >= deadline) throw new BudgetReached();
        await sleep(retryDelay); continue;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        const fetchedAt = new Date().toISOString(); evidenceDates?.push(Date.parse(fetchedAt));
        return { notFound: true, fetchedAt, body: null };
      }
      if (!response.ok) { await response.body?.cancel(); stats.networkFailures++; throw new TransientFailure("upstream"); }
      let body;
      try { body = await response.json(); } catch { stats.networkFailures++; throw new TransientFailure("invalid-response"); }
      const envelope = { url: url.href, fetchedAt: new Date().toISOString(), body };
      evidenceDates?.push(Date.parse(envelope.fetchedAt));
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(envelope) + "\n");
      return envelope;
    }
    stats.networkFailures++;
    throw new TransientFailure("rate-limited");
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
  const outcomes = sanitizeOutcomes(previous.outcomes, new Set(byId.keys()));
  if (previous.version === 1 && previous.items && typeof previous.items === "object") {
    for (const [id, details] of Object.entries(previous.items)) {
      if (byId.has(id) && details && typeof details === "object") items[id] = Object.fromEntries(Object.entries(details).filter(([field]) => allowedFields.has(field)));
    }
  }
  async function checkpoint() {
    const output = { version: 1, provider: "TMDB", generatedAt: new Date().toISOString(), items, outcomes };
    // Only a leaf file is replaced. Run one enrichment job at a time.
    const temporary = path.join(path.dirname(outputPath), `.title-details-tmdb.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(output) + "\n");
    await rename(temporary, outputPath);
  }
  function recordOutcome(id, status, reason, extra = {}) {
    const checked = Date.now(), sourceTime = evidenceDates?.length ? Math.min(...evidenceDates) : checked;
    outcomes[String(id)] = { status, checkedAt: new Date(checked).toISOString(), provider: "TMDB",
      ...(stableStatuses.has(status) ? { expiresAt: new Date(Math.min(checked + ttl, sourceTime + ttl)).toISOString() } : {}),
      ...(reason ? { reason } : {}), ...extra };
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

  const pending = pendingTitles(candidates, outcomes, { offset, limit, refresh });
  const skippedRecent = refresh ? 0 : candidates.slice(offset).filter(item => isRecentCompleted(outcomes[String(item.movieId)])).length;
  let imageOptions;
  try {
    if (!pending.length) {
      console.log("No pending titles in this range; recent completed outcomes were retained.");
      return;
    }
    const config = (await get("configuration"))?.body?.images;
    if (!config || !Array.isArray(config.poster_sizes)) throw new EnrichmentError("TMDB image configuration is unavailable within this budget.");
    const posterSize = config.poster_sizes.includes("w342") ? "w342" : config.poster_sizes.includes("w500") ? "w500" : null;
    if (!posterSize || config.secure_base_url !== "https://image.tmdb.org/t/p/") throw new EnrichmentError("TMDB returned an unsupported image base or poster size.");
    imageOptions = { imageBaseUrl: config.secure_base_url, posterSize };

    for (const item of pending) {
      if (Date.now() >= deadline) throw new BudgetReached();
      stats.checked++;
      evidenceDates = [];
      let envelope = null;
      let noMatchStatus = "unmatched", noMatchReason = "no-exact-match";
      try {
      if (item.mediaType === "movie") {
        let identity = links.get(item.movieId);
        if (!identity) { noMatchReason = "missing-identity"; }
        else {
        if (!identity.tmdbId) {
          const found = await get(`find/${identity.imdbId}?external_source=imdb_id&language=en-US`);
          const match = selectTmdbMovieMatch(found?.body, identity);
          if (match) identity = { ...identity, tmdbId: match.id };
          else if (Array.isArray(found?.body?.movie_results) && found.body.movie_results.length > 1) noMatchStatus = "ambiguous";
        }
        if (identity.tmdbId) {
        const response = await get(`movie/${identity.tmdbId}?append_to_response=credits&language=en-US`);
        if (response && matchesTmdbMovie(response.body, identity)) envelope = response;
        else if (!response?.notFound) { noMatchStatus = "ambiguous"; noMatchReason = "identity-conflict"; }
        }
        }
      } else {
        const target = { title: localDetails.items[item.movieId]?.displayTitle || formatTitle(item), alternateTitle: item.alternateTitle, year: item.year };
        const queries = [...new Set([target.title, target.alternateTitle].filter(Boolean))];
        const results = [];
        let complete = true;
        for (const query of queries) {
          const search = await get(`search/tv?query=${encodeURIComponent(query)}&first_air_date_year=${item.year}&include_adult=false&language=en-US&page=1`);
          if (search?.notFound) continue;
          if (!Array.isArray(search?.body?.results)) throw new TransientFailure("invalid-response");
          results.push(...search.body.results);
          const pages = Number(search.body.total_pages) || 1;
          if (!Number.isInteger(pages) || pages < 1 || pages > 5) { complete = false; break; }
          for (let page = 2; page <= pages; page++) {
            const next = await get(`search/tv?query=${encodeURIComponent(query)}&first_air_date_year=${item.year}&include_adult=false&language=en-US&page=${page}`);
            if (!Array.isArray(next?.body?.results)) throw new TransientFailure("invalid-response");
            results.push(...next.body.results);
          }
        }
        const match = complete ? selectTmdbTvMatch(results, target) : null;
        if (!complete) { noMatchStatus = "ambiguous"; noMatchReason = "incomplete-search"; }
        else if (!match && new Set(results.filter(result => selectTmdbTvMatch([result], target)).map(result => result.id)).size > 1) noMatchStatus = "ambiguous";
        if (match) {
          const response = await get(`tv/${match.id}?append_to_response=aggregate_credits&language=en-US`);
          if (response?.body?.id === match.id && selectTmdbTvMatch([response.body], target)) envelope = response;
          else if (!response?.notFound) { noMatchStatus = "ambiguous"; noMatchReason = "identity-conflict"; }
        }
      }
      if (!envelope) {
        stats.skipped++; delete items[item.movieId]; recordOutcome(item.movieId, noMatchStatus, noMatchReason); continue;
      }
      const displayOptions = { mediaType: item.mediaType, ...imageOptions, asOf: envelope.fetchedAt.slice(0, 10) };
      let display = tmdbDisplayDetails(envelope.body, displayOptions), imagesChecked = false;
      if (!display.posterUrl) {
        // Same verified ID, all image languages; the helper prefers English.
        const images = await get(`${item.mediaType === "movie" ? "movie" : "tv"}/${envelope.body.id}/images`);
        if (images?.notFound) throw new TransientFailure("images-unavailable");
        if (images?.body?.id !== envelope.body.id || !Array.isArray(images.body.posters)) throw new TransientFailure("invalid-response");
        imagesChecked = true;
        const posterPath = selectTmdbPoster(images.body, envelope.body.id);
        if (posterPath) display = tmdbDisplayDetails({ ...envelope.body, poster_path: posterPath }, displayOptions);
      }
      items[item.movieId] = display;
      recordOutcome(item.movieId, display.posterUrl ? "poster" : "matched-no-poster", undefined, { providerId: envelope.body.id, ...(imagesChecked ? { imagesChecked: true } : {}) });
      stats.matched++;
      } catch (error) {
        if (error instanceof TransientFailure) { stats.skipped++; recordOutcome(item.movieId, "transient", error.message); }
        else { recordOutcome(item.movieId, "transient", error instanceof BudgetReached ? "budget"
          : error instanceof EnrichmentError && error.message.startsWith("TMDB rejected") ? "authentication" : "invalid-response"); throw error; }
      } finally {
        evidenceDates = null;
        if (stats.checked % 10 === 0) {
          await checkpoint();
          console.log(`TMDB public titles checked ${stats.checked}/${pending.length}; matched ${stats.matched}; requests ${stats.requests}/${maxRequests}. Checkpoint saved.`);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetReached)) throw error;
    stats.budgetExhausted = true;
  } finally {
    await checkpoint();
  }
  const recentCompleted = Object.values(outcomes).filter(value => isRecentCompleted(value)).length;
  console.log(JSON.stringify({ ...stats, offset, skippedRecent, recentCompleted, totalEligibleTitles: byId.size,
    output: "web/public/catalog/title-details-tmdb.json", totalEnrichedTitles: Object.keys(items).length,
    nextOffset: candidates.findIndex(item => !isRecentCompleted(outcomes[String(item.movieId)])) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof EnrichmentError ? error.message : "TMDB enrichment failed. No credentials were printed; check local metadata files and retry with a bounded budget.");
  process.exitCode = 1;
});
