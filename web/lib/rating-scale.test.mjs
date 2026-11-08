import test from "node:test";
import assert from "node:assert/strict";
import { DISPLAY_RATING_SCALE, isValidDisplayRating, displayToModel, modelToDisplay } from "./rating-scale.mjs";
import { createModel, recommend } from "./recommender.mjs";

test("display ratings accept every integer from 1 to 10 and reject other values", () => {
  assert.equal(DISPLAY_RATING_SCALE, 10);
  for (let rating = 1; rating <= 10; rating++) assert.equal(isValidDisplayRating(rating), true);
  for (const rating of [0, 11, -1, .5, 4.5, NaN, Infinity, -Infinity, "8", null, undefined, true]) {
    assert.equal(isValidDisplayRating(rating), false);
    assert.throws(() => displayToModel(rating), RangeError);
  }
});

test("both boundaries map to the existing model and database scale", () => {
  assert.equal(displayToModel(1), .5);
  assert.equal(displayToModel(10), 5);
  assert.equal(modelToDisplay(.5), 1);
  assert.equal(modelToDisplay(5), 10);
});

test("all existing half-star ratings retain their meaning without migration", () => {
  for (let stored = .5; stored <= 5; stored += .5) {
    const shown = modelToDisplay(stored);
    assert.equal(shown, stored * 2);
    assert.equal(displayToModel(shown), stored);
  }
  assert.equal(modelToDisplay(4.5), 9);
  for (const stored of [0, 5.5, 1.25, NaN, Infinity, "4.5", null]) {
    assert.throws(() => modelToDisplay(stored), RangeError);
  }
});

test("7/10 stays below the model's like threshold and 8/10 becomes a like", () => {
  const movies = [1, 2].map((movieId) => ({ movieId, title: `Movie ${movieId}`, genres: [], year: 2000,
    popularity: 1, imdbRating: 7, imdbVotes: 10, imdbAdjustment: 0 }));
  const metadata = { version: 1, model: "scale test", itemCount: 2, weights: { plot: .25, credits: .25, imdb: .1 },
    creditRoles: ["cast"], groups: [], movies };
  const groups = ["cf", "plots", "cast"].map((name) => ({ name, rows: 2, columns: 1,
    indptr: Uint32Array.from([0, 1, 2]), indices: Uint16Array.from([0, 0]), data: Float32Array.from([1, 1]) }));
  const model = createModel(metadata, groups);
  const lower = recommend(model, [{ movieId: 1, rating: displayToModel(7) }]);
  assert.equal(lower.likes, 0);
  assert.equal(lower.mode, "starter");
  const liked = recommend(model, [{ movieId: 1, rating: displayToModel(8) }]);
  assert.equal(liked.likes, 1);
  assert.equal(liked.mode, "personalized");
  assert.ok(lower.movies.every((movie) => movie.movieId !== 1));
  assert.ok(liked.movies.every((movie) => movie.movieId !== 1));
});
