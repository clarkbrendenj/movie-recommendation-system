import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertDistinctCatalogIds, browseCombined, isRateableSeries, movieCandidateIds } from "./media-catalog.mjs";
import { browseMovies, createModel, recommend } from "./recommender.mjs";

function movie(movieId, extra = {}) {
  return { movieId, title: `Movie ${movieId}`, genres: ["Drama"], year: 2000, popularity: 1,
    imdbRating: null, imdbVotes: null, imdbAdjustment: 0, ...extra };
}

function series(movieId, extra = {}) {
  return { ...movie(movieId), source: "filmaffinity", sourceId: `film${movieId - 1_000_000_000}`,
    mediaType: "series", eligible: true, candidate: true, genres: ["TV drama"], ...extra };
}

test("combined identities reject collisions in visible and hidden source rows", () => {
  assert.doesNotThrow(() => assertDistinctCatalogIds({ movies: [movie(1)] }, { items: [series(1_000_000_001)] }));
  for (const items of [[series(1)], [series(1, { candidate: false, mediaType: "movie" })],
    [series(1_000_000_001), series(1_000_000_001)], [series(Number.MAX_SAFE_INTEGER + 1)]]) {
    assert.throws(() => assertDistinctCatalogIds({ movies: [movie(1)] }, { items }), /Duplicate or invalid ID/);
  }
});

test("only explicitly eligible TV candidates can receive ratings", () => {
  const metadata = { items: [series(1_000_000_001), series(1_000_000_002, { eligible: false, candidate: false }),
    series(1_000_000_003, { candidate: false, mediaType: "movie" }),
    series(1_000_000_004, { eligible: undefined }), series(1_000_000_005, { candidate: undefined })] };
  assert.equal(isRateableSeries(metadata, 1_000_000_001), true);
  for (const id of [1, 1_000_000_002, 1_000_000_003, 1_000_000_004, 1_000_000_005]) {
    assert.equal(isRateableSeries(metadata, id), false);
  }
});

test("Both resolves IDs across full catalogs before filtering or pagination", () => {
  const movies = { movies: Array.from({ length: 40 }, (_, i) => movie(i + 1)) };
  const tv = { items: Array.from({ length: 40 }, (_, i) => series(1_000_000_000 + i + 1)) };
  const before = JSON.stringify({ movies, tv });
  const result = browseCombined(movies, tv, { ids: [35, 1_000_000_035] });
  assert.equal(result.total, 2);
  assert.deepEqual(result.movies.map((item) => item.movieId), [35, 1_000_000_035]);
  assert.equal(result.movies[0].mediaType, "movie");
  assert.equal(result.movies[0].sourceId, "ml:35");
  assert.equal(result.movies[1].mediaType, "series");
  assert.equal(browseCombined(movies, tv, { ids: [] }).total, 0);
  const second = browseCombined(movies, tv, { page: 2 });
  assert.equal(second.pageSize, 24);
  assert.equal(second.total, 80);
  assert.deepEqual(second.movies.map((item) => item.movieId),
    [...movies.movies, ...tv.items].slice(24, 48).map((item) => item.movieId));
  assert.equal(JSON.stringify({ movies, tv }), before);
});

test("Both exposes source genres and searches visible series without leaking context titles", () => {
  const movies = { movies: [movie(1, { title: "Unrelated" })] };
  const tv = { items: [series(1_000_000_001, { title: "Señor de la casa", alternateTitle: "The House" }),
    series(1_000_000_002, { title: "Hidden film", genres: ["Hidden"], mediaType: "movie", candidate: false }),
    series(1_000_000_003, { title: "Hidden season", genres: ["Hidden"], eligible: false, candidate: false })] };
  const result = browseCombined(movies, tv, { q: "senor", genre: "TV drama" });
  assert.deepEqual(result.movies.map((item) => item.movieId), [1_000_000_001]);
  assert.deepEqual(result.genres, ["Drama", "TV drama"]);
  assert.equal(browseCombined(movies, tv).total, 2);
  assert.equal(browseCombined(movies, tv, { q: "Hidden" }).total, 0);
  assert.deepEqual(browseCombined(movies, tv, { q: "The House" }).movies.map((item) => item.movieId), [1_000_000_001]);
});

test("the film mask applies before top-k and pagination while preserving full profile columns", () => {
  const count = 80;
  const metadata = { version: 1, itemCount: count, model: "test", weights: { plot: .25, credits: .25, imdb: .1 },
    creditRoles: ["cast"], groups: [], movies: Array.from({ length: count }, (_, i) => movie(i + 1, { popularity: count - i })) };
  const groups = ["cf", "plots", "cast"].map((name) => ({ name, rows: count, columns: 1,
    indptr: Uint32Array.from(Array.from({ length: count + 1 }, (_, i) => i)),
    indices: new Uint16Array(count), data: new Float32Array(count).fill(1) }));
  const model = createModel(metadata, groups);
  const eligible = new Set(Array.from({ length: 20 }, (_, i) => i + 61));
  assert.deepEqual(recommend(model, [], 12).movies.map((item) => item.movieId), Array.from({ length: 12 }, (_, i) => i + 1));
  const filtered = recommend(model, [{ movieId: 1, rating: 4 }], 12, eligible);
  assert.deepEqual(filtered.movies.map((item) => item.movieId), Array.from({ length: 12 }, (_, i) => i + 61));
  assert.equal(filtered.mode, "personalized");
  assert.equal(filtered.likes, 1);
  assert.equal(filtered.ratingsCount, 1);
  assert.ok(filtered.movies.every((item) => item.score === 1));
  assert.equal(model.metadata.movies.length, count);
  assert.equal(model.groups.get("cf").rows, count);
  const browsed = browseMovies(metadata, {}, eligible);
  assert.equal(browsed.total, 20);
  assert.deepEqual(browsed.movies.map((item) => item.movieId), [...eligible]);
  assert.equal(browseMovies(metadata).total, count);
});

test("legacy MovieLens TV entries remain resolvable by explicit Both IDs only", () => {
  const movies = { itemCount: 3, movies: [movie(1), movie(2, { title: "Legacy series" }), movie(3)] };
  const tv = { items: [series(1_000_000_001)] };
  const overlay = { version: 1, featureItemCount: 3, candidateCount: 2,
    excludedItems: [{ movieId: 2, imdbId: "tt0000002", titleType: "tvMiniSeries" }] };
  assert.deepEqual([...movieCandidateIds(movies, overlay)], [1, 3]);
  assert.equal(browseCombined(movies, tv, {}, overlay).total, 3);
  assert.equal(browseCombined(movies, tv, { q: "Legacy" }, overlay).total, 0);
  const resolved = browseCombined(movies, tv, { ids: [2, 1_000_000_001] }, overlay);
  assert.equal(resolved.total, 2);
  const legacy = resolved.movies.find((item) => item.movieId === 2);
  assert.equal(legacy.mediaType, "other");
  assert.equal(legacy.legacyUnit, "tvMiniSeries");
  assert.equal(legacy.sourceId, "ml:2");
  assert.equal(resolved.movies.find((item) => item.movieId === 1_000_000_001).mediaType, "series");
  assert.throws(() => movieCandidateIds(movies, { ...overlay, candidateCount: 3 }), /candidate count/);
  assert.throws(() => movieCandidateIds(movies, { ...overlay, featureItemCount: 4 }), /does not match/);
});

test("the shipped exact-ID overlay matches all three source hashes and retains the frozen catalog", async () => {
  const overlay = JSON.parse(await readFile(new URL("../public/catalog/movie-unit-exclusions.json", import.meta.url), "utf8"));
  const metadata = JSON.parse(await readFile(new URL("../public/model/metadata.json", import.meta.url), "utf8"));
  assert.equal(metadata.itemCount, 6885);
  assert.equal(overlay.excludedItems.length, 67);
  assert.equal(movieCandidateIds(metadata, overlay).size, 6818);
  assert.equal(overlay.unknownTitleTypes, 12);
  assert.deepEqual(overlay.titleTypeCounts.tvMiniSeries, 43);
  assert.deepEqual(overlay.titleTypeCounts.tvSeries, 3);
  assert.deepEqual(overlay.titleTypeCounts.tvEpisode, 21);
  for (const source of Object.values(overlay.sources)) {
    const bytes = await readFile(new URL(`../../${source.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  }
});
