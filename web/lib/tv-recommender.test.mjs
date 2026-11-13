import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTvModel, recommendSeries, rankSeries, browseSeries, FILMAFFINITY_ID_NAMESPACE as OFFSET } from "./tv-recommender.mjs";

function sparse(name, rows) {
  const indptr = [0], indices = [], data = [];
  for (const row of rows) {
    row.forEach((value, col) => { if (value) { indices.push(col); data.push(value); } });
    indptr.push(indices.length);
  }
  return { name, rows: rows.length, columns: rows[0].length,
    indptr: Uint32Array.from(indptr), indices: Uint16Array.from(indices), data: Float32Array.from(data) };
}

function fixture() {
  const rows = [
    [1, "Seed series", "Semilla", 50, true, true, "series", ["Drama"]],
    [2, "First candidate", "Primera candidata", 2, true, true, "series", ["Drama"]],
    [3, "Second candidate", "Segunda candidata", 10, true, true, "series", ["Comedy"]],
    [4, "Excluded season", "Temporada", 999, false, false, "series", ["Drama"]],
    [5, "Context film", "Película", 1000, true, false, "movie", ["Drama"]],
  ];
  const metadata = { version: 1, modelkind: "whole_series", model: "fixture", itemCount: rows.length,
    candidateCount: 3, groups: [], weights: { plot: .25, metadata: 0, quality: 0, personal: .25 },
    benchmark: { dataset: "FilmAffinity", recallAt10: .15, users: 10, split: "validation" },
    items: rows.map(([id, title, alternateTitle, popularity, eligible, candidate, mediaType, genres]) => ({
      movieId: OFFSET + id, sourceId: `film${id}`, title, alternateTitle, popularity, eligible, candidate,
      mediaType, genres, source: "filmaffinity", year: 2000 + id, quality: 0,
    })) };
  return createTvModel(metadata, [
    sparse("cf", [[1, 0], [.8, .6], [.6, .8], [1, 0], [1, 0]]),
    sparse("synopsis", [[1, 0], [1, 0], [0, 1], [1, 0], [0, 1]]),
    sparse("genres", [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]),
    sparse("cast", [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]),
  ]);
}

test("TV ranking preserves full-catalog component scaling and its 25/75 blend", () => {
  const result = recommendSeries(fixture(), [{ movieId: OFFSET + 1, rating: 4 }], 10);
  assert.equal(result.mode, "personalized");
  assert.equal(result.likes, 1);
  assert.deepEqual(result.movies.map(item => item.movieId), [OFFSET + 3, OFFSET + 2]);
  // Full-catalog CF maximum=1 because of the context movie; TV CF max=.8.
  // Personal A=.8+.25=1.05, B=.6; scaled B=4/7. Count B=1, A=.2.
  assert.ok(Math.abs(result.movies[0].score - (.25 * (4 / 7) + .75)) < 1e-7);
  assert.ok(Math.abs(result.movies[1].score - .4) < 1e-7);
  assert.ok(result.movies.every(item => item.mediaType === "series" && item.candidate && item.eligible));
});

test("cold starts and low ratings use series popularity and retain seen exclusions", () => {
  const model = fixture();
  assert.deepEqual(recommendSeries(model, [], 10).movies.map(item => item.movieId), [OFFSET + 1, OFFSET + 3, OFFSET + 2]);
  const below = recommendSeries(model, [{ movieId: OFFSET + 1, rating: 3.5 }]);
  assert.equal(below.mode, "starter");
  assert.equal(below.ratingsCount, 1);
  assert.deepEqual(below.movies.map(item => item.movieId), [OFFSET + 3, OFFSET + 2]);
});

test('a low-rated TV Favorite overrides the threshold without changing its saved score', () => {
  const model = fixture(), ratings = [{movieId:OFFSET+1,rating:1.5}];
  const actual = recommendSeries(model, ratings, 10, [OFFSET+1]);
  const expected = recommendSeries(model, [{movieId:OFFSET+1,rating:4}], 10);
  assert.equal(actual.mode, 'personalized'); assert.equal(actual.likes, 1); assert.equal(actual.ratingsCount, 1);
  assert.deepEqual(actual.movies.map(item => [item.movieId,item.score]), expected.movies.map(item => [item.movieId,item.score]));
  assert.ok(actual.movies.every(item => item.reason.includes('favorited') && item.movieId !== OFFSET+1));
  assert.equal(ratings[0].rating, 1.5);
  assert.equal(recommendSeries(model, ratings, 10, []).mode, 'starter');
});

test('TV Favorites deduplicate positives and do not fabricate watch ratings', () => {
  const model = fixture(), ratings = [{movieId:OFFSET+1,rating:4}];
  const actual = recommendSeries(model, ratings, 10, [OFFSET+1,OFFSET+1]);
  const expected = recommendSeries(model, ratings, 10);
  assert.equal(actual.likes, 1);
  assert.deepEqual(actual.movies.map(item => [item.movieId,item.score]), expected.movies.map(item => [item.movieId,item.score]));
  const unrated = recommendSeries(model, [], 10, new Set([OFFSET+1]));
  assert.equal(unrated.ratingsCount, 0); assert.equal(unrated.likes, 1);
  assert.deepEqual(unrated.movies.map(item => [item.movieId,item.score]), expected.movies.map(item => [item.movieId,item.score]));
});

test('foreign identities, vetoed seasons, context movies and malformed TV Favorites cannot personalize', () => {
  const model = fixture();
  const actual = recommendSeries(model, [], 10, [1,OFFSET+4,OFFSET+5,OFFSET+9999,NaN,1.5,String(OFFSET+1),null]);
  assert.deepEqual(actual, recommendSeries(model, [], 10));
});

test("unlinked MovieLens IDs, vetoed seasons and malformed entries cannot create likes", () => {
  const result = recommendSeries(fixture(), [null, { movieId: 1, rating: 5 }, { movieId: OFFSET + 4, rating: 5 }, { movieId: OFFSET + 1, rating: 4.201 }]);
  assert.equal(result.mode, "starter");
  assert.equal(result.ratingsCount, 0);
  assert.equal(result.likes, 0);
  assert.ok(!result.movies.some(item => item.movieId === OFFSET + 4 || item.movieId === OFFSET + 5));
});

test("full series ranking preserves the bounded shelf for tenths-scale ratings", () => {
  const model = fixture();
  const ratings = [{ movieId: OFFSET + 1, rating: 4.05 }];
  const full = rankSeries(model, ratings);
  assert.equal(full.likes, 1);
  assert.deepEqual(full.movies.slice(0, 1), recommendSeries(model, ratings, 1).movies);
  assert.equal(full.movies.length, 2);
});

test("last valid duplicate rating wins and every valid rated series is excluded", () => {
  const model = fixture();
  const result = recommendSeries(model, [{ movieId: OFFSET + 1, rating: 5 }, { movieId: OFFSET + 1, rating: 1 }]);
  assert.equal(result.likes, 0);
  assert.equal(result.ratingsCount, 1);
  const allSeen = recommendSeries(model, model.metadata.items.filter(item => item.candidate).map(item => ({ movieId: item.movieId, rating: 1 })));
  assert.deepEqual(allSeen.movies, []);
});

test("browsing searches both source titles and filters the series catalog before pagination", () => {
  const { metadata } = fixture();
  assert.deepEqual(browseSeries(metadata, { q: "segunda", genre: "Comedy" }).movies.map(item => item.movieId), [OFFSET + 3]);
  assert.deepEqual(browseSeries(metadata, { ids: [OFFSET + 4, OFFSET + 5] }).movies, []);
  assert.deepEqual(browseSeries(metadata, { ids: [] }).movies, []);
  assert.deepEqual(browseSeries(metadata, { sort: "year" }).movies.map(item => item.movieId), [OFFSET + 3, OFFSET + 2, OFFSET + 1]);
  assert.deepEqual(browseSeries(metadata).genres, ["Comedy", "Drama"]);
});

test("unsafe source identities, wrong candidate kinds and corrupt sparse matrices fail closed", () => {
  const model = fixture();
  const duplicate = structuredClone(model.metadata);
  duplicate.items[1].movieId = duplicate.items[0].movieId;
  assert.throws(() => createTvModel(duplicate, [...model.groups.values()]));
  const wrongKind = structuredClone(model.metadata);
  wrongKind.items[0].mediaType = "movie";
  assert.throws(() => createTvModel(wrongKind, [...model.groups.values()]));
  const corrupt = [...model.groups.values()].map(group => ({ ...group }));
  corrupt[0].data = Float32Array.from([-1]);
  assert.throws(() => createTvModel(model.metadata, corrupt));
});

test("exported TV model preserves every Python reference top ten and score", async () => {
  const directory = new URL("../public/tv-model/", import.meta.url);
  const metadata = JSON.parse(await readFile(new URL("metadata.json", directory), "utf8"));
  const reference = JSON.parse(await readFile(new URL("reference.json", directory), "utf8"));
  const array = async descriptor => {
    const bytes = await readFile(new URL(descriptor.file, directory));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (descriptor.dtype === "uint32") return new Uint32Array(buffer);
    if (descriptor.dtype === "uint16") return new Uint16Array(buffer);
    return new Float32Array(buffer);
  };
  const groups = [];
  for (const descriptor of metadata.groups) {
    groups.push({ name: descriptor.name, rows: descriptor.rows, columns: descriptor.columns,
      indptr: await array(descriptor.indptr), indices: await array(descriptor.indices), data: await array(descriptor.data) });
  }
  const model = createTvModel(metadata, groups);
  assert.equal(metadata.candidateCount, 1715);
  assert.equal(metadata.verification.validationUsersCompared, 972);
  assert.equal(metadata.verification.allTop10Identical, true);
  assert.ok(metadata.sparseBytes < 10 * 1024 * 1024);
  assert.equal(reference.candidateIds.length, 1715);
  const movies = JSON.parse(await readFile(new URL("../model/metadata.json", directory), "utf8"));
  const movieIds = new Set(movies.movies.map(item => item.movieId));
  assert.ok(reference.candidateIds.every(id => !movieIds.has(id)));
  for (const example of reference.cases) {
    const seen = new Set(example.ratings.map(item => item.movieId));
    const actual = recommendSeries(model, example.ratings, 10);
    const expanded = recommendSeries(model, example.ratings, 20);
    const available = metadata.items.filter(item => item.eligible && item.candidate && item.mediaType === 'series' && !seen.has(item.movieId)).length;
    assert.equal(expanded.movies.length, Math.min(20, available), `${example.name}: up to twenty unseen whole-series picks`);
    assert.deepEqual(expanded.movies.slice(0, 10), actual.movies, `${example.name}: expanded list preserves scores and top ten`);
    assert.deepEqual(actual.movies.map(item => item.movieId), example.top10, example.name);
    for (const expected of example.scores) {
      const item = actual.movies.find(row => row.movieId === expected.movieId);
      assert.ok(item && Math.abs(item.score - expected.score) < 1e-6, `${example.name}: score mismatch`);
    }
    assert.ok(actual.movies.every(item => !seen.has(item.movieId)));
    assert.ok(expanded.movies.every(item => !seen.has(item.movieId)));
  }
});
