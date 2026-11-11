/** Offline poster-reference audit. No token, network, database, or model changes. */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isRecentCompleted, sanitizeOutcomes } from "../web/scripts/enrich-tmdb-details.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("node scripts/audit-poster-coverage.mjs [--static-overlay PATH] [--tmdb-overlay PATH] [--include-ids]");
  console.log("Prints an offline JSON report; it does not fetch images or inspect runtime/provider caches.");
  process.exit(0);
}
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--include-ids") continue;
  if (!["--static-overlay", "--tmdb-overlay"].includes(args[index]) || !args[index + 1]) throw new Error("Unsupported option. Run with --help.");
  index++;
}
const option = (name, fallback) => args.includes(name) ? path.resolve(args[args.indexOf(name) + 1]) : path.join(root, fallback);
const staticPath = option("--static-overlay", "web/public/catalog/title-details.json");
const tmdbPath = option("--tmdb-overlay", "web/public/catalog/title-details-tmdb.json");
async function json(file, optional = false) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
}
function entries(overlay) {
  if (!overlay) return {};
  if (overlay.version !== 1 || !overlay.items || Array.isArray(overlay.items) || typeof overlay.items !== "object") throw new Error("Invalid overlay: expected version 1 and an items object.");
  return overlay.items;
}
function url(value) {
  if (typeof value !== "string") return null;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port ? parsed : null; }
  catch { return null; }
}
function sourceIdentity(record, mediaType, explicitSource = record?.metadataSource) {
  const source = url(explicitSource?.url);
  if (!source || typeof explicitSource?.name !== "string") return null;
  if (explicitSource.name === "TMDB" && source.hostname === "www.themoviedb.org") {
    const match = /^\/(movie|tv)\/([1-9][0-9]*)(?:\/|$)/.exec(source.pathname);
    if (!match || match[1] !== (mediaType === "movie" ? "movie" : "tv")) return null;
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id) || (record.tmdbId !== undefined && record.tmdbId !== id)) return null;
    return { provider: "TMDB", id };
  }
  if (explicitSource.name === "TVmaze" && source.hostname === "www.tvmaze.com" && mediaType === "series") {
    const match = /^\/shows\/([1-9][0-9]*)(?:\/|$)/.exec(source.pathname);
    if (!match) return null;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || (record.tvmazeId !== undefined && record.tvmazeId !== id)) return null;
    return { provider: "TVmaze", id };
  }
  return null;
}
function posterReference(record, mediaType) {
  const poster = url(record?.posterUrl);
  if (!poster || poster.search || poster.hash) return null;
  const identity = sourceIdentity(record, mediaType, record.posterSource || record.metadataSource);
  if (!identity) return null;
  if (identity.provider === "TMDB" && poster.hostname === "image.tmdb.org"
      && /^\/t\/p\/(w342|w500|original)\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(poster.pathname)) return { ...identity, key: `TMDB:${poster.pathname.split("/").at(-1)}` };
  if (identity.provider === "TVmaze" && poster.hostname === "static.tvmaze.com"
      && /^\/uploads\/images\//.test(poster.pathname)) return { ...identity, key: `TVmaze:${poster.pathname}` };
  return null;
}
function duplicates(map) { return [...map].filter(([, ids]) => ids.length > 1).map(([value, ids]) => ({ value, ids })); }
function add(map, key, id) { const values = map.get(key) || []; values.push(id); map.set(key, values); }
const [movieMetadata, tvMetadata, exclusionOverlay, staticOverlay, tmdbOverlay] = await Promise.all([
  json(path.join(root, "web/public/model/metadata.json")), json(path.join(root, "web/public/tv-model/metadata.json")),
  json(path.join(root, "web/public/catalog/movie-unit-exclusions.json")), json(staticPath), json(tmdbPath, true),
]);
const excluded = new Set(exclusionOverlay.excludedItems.map(item => item.movieId));
const catalog = [...movieMetadata.movies.filter(item => !excluded.has(item.movieId)).map(item => ({ movieId: item.movieId, mediaType: "movie" })),
  ...tvMetadata.items.filter(item => item.eligible && item.candidate && item.mediaType === "series").map(item => ({ movieId: item.movieId, mediaType: "series" }))];
const expected = new Map(catalog.map(item => [String(item.movieId), item.mediaType]));
if (expected.size !== catalog.length) throw new Error("Duplicate catalog identities: coverage denominator is ambiguous.");
const layers = { static: entries(staticOverlay), tmdb: entries(tmdbOverlay) };
const rawOutcomes = tmdbOverlay?.outcomes || {};
const outcomes = sanitizeOutcomes(rawOutcomes, new Set(expected.keys()));
const issues = { overlayUnknownIds: [], outcomeUnknownIds: Object.keys(rawOutcomes).filter(id => !expected.has(id)),
  invalidOutcomeIds: Object.keys(rawOutcomes).filter(id => expected.has(id) && !outcomes[id]),
  posterOutcomeWithoutReference: [], unprovenMissingOutcomeIds: [], wrongSourceFields: [], invalidPosterReferences: [],
  mismatchedMovieIdFields: [], duplicateProviderIdentities: [], duplicatePosterReferences: [] };
const allRows = [];
function coverage(selectedLayers, inspectIssues = false) {
  const result = { movies: { total: 0, matched: 0, missing: 0, unknown: 0, unseeded: 0, recordedMatchWithoutPoster: 0 },
    series: { total: 0, matched: 0, missing: 0, unknown: 0, unseeded: 0, recordedMatchWithoutPoster: 0 } };
  const providers = new Map(), posters = new Map();
  for (const item of catalog) {
    const id = String(item.movieId), counts = result[item.mediaType === "movie" ? "movies" : "series"];
    counts.total++;
    let reference = null, knownMatch = false, invalidPoster = false;
    // Later overlays override an earlier poster only when they actually provide one.
    for (const name of selectedLayers) {
      const record = layers[name][id];
      if (!record || typeof record !== "object") continue;
      const identity = sourceIdentity(record, item.mediaType);
      if (identity) knownMatch = true;
      if (inspectIssues && record.movieId !== undefined && record.movieId !== item.movieId) issues.mismatchedMovieIdFields.push({ layer: name, id: item.movieId });
      if (inspectIssues && ["TMDB", "TVmaze"].includes(record.metadataSource?.name) && !identity) issues.wrongSourceFields.push({ layer: name, id: item.movieId, reason: "provider URL, media namespace, or provider ID disagrees" });
      if (record.posterUrl) {
        const candidate = posterReference(record, item.mediaType);
        if (candidate) { reference = candidate; invalidPoster = false; }
        else {
          reference = null; invalidPoster = true;
          if (inspectIssues) issues.invalidPosterReferences.push({ layer: name, id: item.movieId, reason: "poster URL or provider provenance is not valid" });
        }
      }
    }
    const lookup = selectedLayers.includes("tmdb") ? outcomes[id] : undefined;
    const tmdbIdentity = sourceIdentity(layers.tmdb[id], item.mediaType);
    const confirmedNoPoster = lookup?.status === "matched-no-poster" && lookup.imagesChecked === true
      && isRecentCompleted(lookup) && tmdbIdentity?.provider === "TMDB" && tmdbIdentity.id === lookup.providerId;
    const outcome = reference ? "matched" : !invalidPoster && confirmedNoPoster ? "missing" : "unknown";
    if (!reference && !lookup) counts.unseeded++;
    if (!reference && knownMatch) counts.recordedMatchWithoutPoster++;
    counts[outcome]++;
    if (inspectIssues) {
      if (lookup?.status === "poster" && !reference) issues.posterOutcomeWithoutReference.push(item.movieId);
      if (lookup?.status === "matched-no-poster" && !confirmedNoPoster) issues.unprovenMissingOutcomeIds.push(item.movieId);
      allRows.push({ movieId: item.movieId, mediaType: item.mediaType, outcome,
        ...(lookup ? { lookupStatus: lookup.status, checkedAt: lookup.checkedAt } : {}),
        ...(reference ? { provider: reference.provider, providerId: reference.id } : {}) });
      if (reference) { add(providers, `${item.mediaType}:${reference.provider}:${reference.id}`, item.movieId); add(posters, reference.key, item.movieId); }
    }
  }
  for (const counts of Object.values(result)) counts.coveragePercent = Number((100 * counts.matched / counts.total).toFixed(2));
  if (inspectIssues) { issues.duplicateProviderIdentities = duplicates(providers); issues.duplicatePosterReferences = duplicates(posters); }
  return result;
}
for (const [name, items] of Object.entries(layers)) {
  for (const id of Object.keys(items)) if (!expected.has(id)) issues.overlayUnknownIds.push({ layer: name, id });
}
const identityAudit = { shards: 0, records: 0, missingIds: [], duplicateIds: [], wrongMediaOrShard: [], unknownIds: [] };
const seenIdentities = new Set();
const catalogDir = path.join(root, "web/public/catalog");
for (const file of (await readdir(catalogDir)).filter(file => /^artwork-identities-[0-9]{2}\.json$/.test(file)).sort()) {
  const shard = await json(path.join(catalogDir, file));
  identityAudit.shards++;
  const index = Number(/([0-9]{2})\.json$/.exec(file)[1]);
  for (const [id, identity] of Object.entries(entries(shard))) {
    identityAudit.records++;
    if (seenIdentities.has(id)) identityAudit.duplicateIds.push(Number(id));
    seenIdentities.add(id);
    if (!expected.has(id)) identityAudit.unknownIds.push(id);
    else if (identity.mediaType !== expected.get(id) || Number(id) % 32 !== index) identityAudit.wrongMediaOrShard.push(Number(id));
  }
}
identityAudit.missingIds = [...expected.keys()].filter(id => !seenIdentities.has(id)).map(Number);
const lookupOutcomes = { movies: {}, series: {} };
for (const group of Object.keys(lookupOutcomes)) lookupOutcomes[group] = { poster: 0, "matched-no-poster": 0, unmatched: 0, ambiguous: 0, transient: 0, neverChecked: 0, recentCompleted: 0, expiredCompleted: 0 };
for (const item of catalog) {
  const counts = lookupOutcomes[item.mediaType === "movie" ? "movies" : "series"], value = outcomes[String(item.movieId)];
  if (!value) counts.neverChecked++;
  else {
    counts[value.status]++;
    if (value.status !== "transient") counts[isRecentCompleted(value) ? "recentCompleted" : "expiredCompleted"]++;
  }
}
const report = {
  auditedAt: new Date().toISOString(), offlineOnly: true,
  sources: { staticOverlayRecords: Object.keys(layers.static).length, tmdbOverlayPresent: Boolean(tmdbOverlay), tmdbOverlayRecords: Object.keys(layers.tmdb).length },
  outcomeDefinitions: {
    matched: "A stored poster reference has a valid known-provider URL and matching source/media identity. Image reachability/content was not fetched.",
    missing: "No stored fallback poster and a recent TMDB matched-no-poster outcome records the same verified provider ID plus a completed images-endpoint check. Absence is scoped to that provider/check date.",
    unknown: "No proven current poster/no-artwork result. This includes unseeded IDs, unmatched/ambiguous lookups, transient errors, expired outcomes and invalid provenance.",
  },
  staticOnly: coverage(["static"]), combinedOverlays: coverage(["static", "tmdb"], true),
  lookupOutcomes, identityAudit, issues,
  caveats: ["No runtime Worker/edge cache was inspected; these are stored-reference counts, not total live API coverage.",
    "The optional TMDB overlay is counted as a separate potential source; this audit does not establish that the frontend consumes it.",
    "Duplicate provider identities or poster paths are review flags, not automatic proof of a wrong mapping."],
  ...(args.includes("--include-ids") ? { items: allRows } : {}),
};
console.log(JSON.stringify(report, null, 2));
