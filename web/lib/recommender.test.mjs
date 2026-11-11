import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createModel, recommend, rankMovies, browseMovies, isValidRating } from "./recommender.mjs";
import { aggregateGroupRankings } from './collaboration-policy.mjs';

function sparse(name, rows) {
  const indptr = [0];
  const indices = [];
  const data = [];
  for (const row of rows) {
    row.forEach((value, index) => { if (value) { indices.push(index); data.push(value); } });
    indptr.push(indices.length);
  }
  return { name, rows: rows.length, columns: rows[0].length,
    indptr: Uint32Array.from(indptr), indices: Uint16Array.from(indices), data: Float32Array.from(data) };
}

function fixture() {
  const metadata = { version: 1, model: "test", itemCount: 4, weights: { plot: .25, credits: .25, imdb: .1 },
    creditRoles: ["cast"], groups: [], movies: [
      { movieId: 1, title: "First (1995)", genres: ["Comedy"], year: 1995, popularity: 10, imdbRating: 8, imdbVotes: 500, imdbAdjustment: .1 },
      { movieId: 2, title: "Second (2000)", genres: ["Comedy"], year: 2000, popularity: 30, imdbRating: 7, imdbVotes: 100, imdbAdjustment: .1 },
      { movieId: 3, title: "Troisieme, Le (2001)", genres: ["Drama"], year: 2001, popularity: 30, imdbRating: 9, imdbVotes: 1000, imdbAdjustment: .2 },
      { movieId: 4, title: "Fourth (2002)", genres: ["Drama"], year: 2002, popularity: 5, imdbRating: null, imdbVotes: null, imdbAdjustment: 0 },
    ] };
  return createModel(metadata, [
    sparse("cf", [[1, 0], [.8, .6], [.6, .8], [0, 1]]),
    sparse("plots", [[1, 0], [0, 1], [1, 0], [0, 0]]),
    sparse("cast", [[1, 0], [1, 0], [0, 1], [0, 1]]),
  ]);
}

test("ratings accept model-scale twentieths corresponding to display tenths", () => {
  for (const value of [.5, .55, .75, 1, 3.55, 3.8, 5]) assert.equal(isValidRating(value), true);
  for (const value of [0, 5.5, .751, 3.555, NaN, Infinity, "5", null]) assert.equal(isValidRating(value), false);
});

test("full ranking preserves personal order for group utility aggregation", () => {
  const model = fixture();
  const ratings = [{ movieId: 1, rating: 4.05 }];
  const full = rankMovies(model, ratings);
  assert.deepEqual(full.movies.slice(0, 2), recommend(model, ratings, 2).movies);
  assert.equal(full.movies.length, 3);
  assert.equal(full.likes, 1);
  assert.deepEqual(rankMovies(model, ratings, new Set([3])).movies.map(m => m.movieId), [3]);
});

test("cold start uses popularity, then IMDb adjustment, then movie ID", () => {
  const result = recommend(fixture(), [], 10);
  assert.equal(result.mode, "starter");
  assert.equal(result.likes, 0);
  assert.deepEqual(result.movies.map((movie) => movie.movieId), [3, 2, 1, 4]);
  assert.ok(result.movies.every((movie) => movie.score === 0));
});

test("personalized inference blends sparse signals and excludes every rated film", () => {
  const result = recommend(fixture(), [{ movieId: 1, rating: 5 }, { movieId: 4, rating: 1 }], 10);
  assert.equal(result.mode, "personalized");
  assert.equal(result.likes, 1);
  assert.equal(result.ratingsCount, 2);
  assert.deepEqual(result.movies.map((movie) => movie.movieId), [2, 3]);
  assert.ok(Math.abs(result.movies[0].score - 1.01) < 1e-7);
  assert.ok(Math.abs(result.movies[1].score - (.75 / (49 / 52) + .02)) < 1e-7);
});

test("lower ratings alone keep starter recommendations and exclude the rated movie", () => {
  const result = recommend(fixture(), [{ movieId: 3, rating: 3.5 }], 10);
  assert.equal(result.mode, "starter");
  assert.deepEqual(result.movies.map((movie) => movie.movieId), [2, 1, 4]);
});

test('a low-rated Favorite supplies the same positive movie signal without changing saved feedback', () => {
  const model = fixture(), ratings = [{ movieId: 1, rating: 1.5 }, { movieId: 4, rating: 1 }];
  const previous = structuredClone(ratings);
  const actual = rankMovies(model, ratings, undefined, [1]);
  const expected = rankMovies(model, [{ movieId: 1, rating: 4 }, { movieId: 4, rating: 1 }]);
  assert.equal(actual.mode, 'personalized');
  assert.equal(actual.likes, 1); assert.equal(actual.ratingsCount, 2);
  assert.deepEqual(actual.movies.map(({movieId,score}) => ({movieId,score})), expected.movies.map(({movieId,score}) => ({movieId,score})));
  assert.ok(actual.movies.every(movie => ![1,4].includes(movie.movieId)));
  assert.ok(actual.movies.some(movie => movie.reason.includes('favorited')));
  assert.deepEqual(ratings, previous);
  assert.deepEqual(rankMovies(model, ratings, undefined, []), rankMovies(model, ratings));
  assert.equal(rankMovies(model, ratings).mode, 'starter', 'Removing the override restores the saved low score policy.');
});

test('movie Favorites deduplicate rated positives and permit unrated favorites without inventing ratings', () => {
  const model = fixture(), rated = [{movieId:1,rating:4}];
  const baseline = recommend(model, rated, 10);
  const duplicate = recommend(model, rated, 10, undefined, [1,1,1]);
  assert.equal(duplicate.likes, 1);
  assert.deepEqual(duplicate.movies.map(movie => [movie.movieId,movie.score]), baseline.movies.map(movie => [movie.movieId,movie.score]));
  const unrated = recommend(model, [], 10, undefined, new Set([1]));
  assert.equal(unrated.mode, 'personalized'); assert.equal(unrated.likes, 1); assert.equal(unrated.ratingsCount, 0);
  assert.deepEqual(unrated.movies.map(movie => [movie.movieId,movie.score]), baseline.movies.map(movie => [movie.movieId,movie.score]));
  assert.deepEqual(rankMovies(model, [], undefined, [99999,1_000_000_001,NaN,1.2,'1',null]), rankMovies(model, []));
});

test('Together combines distinct member Favorite profiles over the complete mutually eligible pool', () => {
  const model = fixture(), eligibleIds = new Set([1,2,3,4]);
  const first = rankMovies(model, [], eligibleIds, [1]);
  const second = rankMovies(model, [], eligibleIds, [4]);
  assert.equal(first.ratingsCount, 0); assert.equal(second.ratingsCount, 0);
  assert.notDeepEqual(first.movies.map(movie => [movie.movieId,movie.score]), second.movies.map(movie => [movie.movieId,movie.score]));
  const result = aggregateGroupRankings([first.movies, second.movies], { eligibleIds, blockedIds:new Set([1,4]), limit:12 });
  assert.deepEqual(new Set(result.map(movie => movie.movieId)), new Set([2,3]));
  assert.ok(result.every(movie => movie.reason === 'Balances the tastes of everyone on this list.'));
});

test("duplicate ratings use the last value and unknown catalog IDs do not create likes", () => {
  const result = recommend(fixture(), [
    { movieId: 1, rating: 5 }, { movieId: 1, rating: 2 }, { movieId: 99999, rating: 5 },
  ]);
  assert.equal(result.mode, "starter");
  assert.equal(result.ratingsCount, 1);
  assert.equal(result.likes, 0);
});

test("all rated movies yield an empty list and missing content falls back to CF", () => {
  const model = fixture();
  const fullySeen = recommend(model, model.metadata.movies.map((movie) => ({ movieId: movie.movieId, rating: 5 })));
  assert.deepEqual(fullySeen.movies, []);
  model.groups.set("plots", sparse("plots", [[0, 0], [0, 0], [0, 0], [0, 0]]));
  model.groups.set("cast", sparse("cast", [[0, 0], [0, 0], [0, 0], [0, 0]]));
  const result = recommend(model, [{ movieId: 1, rating: 4 }]);
  assert.deepEqual(result.movies.map((movie) => movie.movieId), [2, 3, 4]);
  assert.ok(Math.abs(result.movies[0].score - 1.01) < 1e-7);
  assert.ok(Math.abs(result.movies[1].score - .77) < 1e-7);
});

test("catalog search composes title terms, genre, IDs, and stable sorting", () => {
  const { metadata } = fixture();
  assert.deepEqual(browseMovies(metadata, { q: "le 2001", genre: "Drama" }).movies.map((movie) => movie.movieId), [3]);
  assert.equal(browseMovies(metadata, { genre: "Horror" }).total, 0);
  assert.deepEqual(browseMovies(metadata, { ids: [1, 3], sort: "year" }).movies.map((movie) => movie.movieId), [3, 1]);
  assert.deepEqual(browseMovies(metadata, { ids: [] }).movies, []);
  assert.equal(browseMovies(metadata, { page: 2 }).movies.length, 0);
});

test("all frozen Python reference cases retain their top 10 and scores", async () => {
  const directory = new URL("../public/model/", import.meta.url);
  const metadata = JSON.parse(await readFile(new URL("metadata.json", directory), "utf8"));
  const reference = JSON.parse(await readFile(new URL("reference.json", directory), "utf8"));
  async function array(descriptor) {
    const bytes = await readFile(new URL(descriptor.file, directory));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (descriptor.dtype === "uint32") return new Uint32Array(buffer);
    if (descriptor.dtype === "uint16") return new Uint16Array(buffer);
    return new Float32Array(buffer);
  }
  const groups = [];
  for (const descriptor of metadata.groups) {
    groups.push({ name: descriptor.name, rows: descriptor.rows, columns: descriptor.columns,
      indptr: await array(descriptor.indptr), indices: await array(descriptor.indices), data: await array(descriptor.data) });
  }
  const model = createModel(metadata, groups);
  for (const entry of reference.cases) {
    const result = recommend(model, entry.ratings, 10);
    assert.deepEqual(result.movies.map((movie) => movie.movieId), entry.top10, entry.name);
    for (const expected of entry.scores) {
      const actual = result.movies.find((movie) => movie.movieId === expected.movieId);
      assert.ok(actual, `${entry.name}: missing ${expected.movieId}`);
      assert.ok(Math.abs(actual.score - expected.score) < 1e-6,
        `${entry.name}: ${expected.movieId} score ${actual.score} != ${expected.score}`);
    }
    const seen = new Set(entry.ratings.map((rating) => rating.movieId));
    assert.ok(result.movies.every((movie) => !seen.has(movie.movieId)));
  }
});
