import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createModel, recommend, browseMovies, isValidRating } from "./recommender.mjs";

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

test("ratings require finite half-star values between 0.5 and 5", () => {
  for (const value of [.5, 1, 3.5, 5]) assert.equal(isValidRating(value), true);
  for (const value of [0, 5.5, .75, NaN, Infinity, "5", null]) assert.equal(isValidRating(value), false);
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
