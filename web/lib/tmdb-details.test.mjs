import test from "node:test";
import assert from "node:assert/strict";
import { isValidImdbId, isValidTmdbId, selectTmdbMovieMatch, matchesTmdbMovie, selectTmdbTvMatch, tmdbPosterUrl, tmdbDisplayDetails } from "./tmdb-details.mjs";

test("external identifiers reject malformed IDs and unsafe numbers", () => {
  assert.equal(isValidImdbId("tt0114709"), true);
  for (const id of ["114709", "tt123", "tt0114709?key=x", null]) assert.equal(isValidImdbId(id), false);
  for (const id of [0, -1, 1.5, "862", Number.MAX_SAFE_INTEGER]) assert.equal(isValidTmdbId(id), false);
  assert.equal(isValidTmdbId(862), true);
});
test("IMDb find lookup accepts one movie identity and rejects wrong-type/ambiguous results", () => {
  const movie = { id: 862, title: "Toy Story" };
  const target = { imdbId: "tt0114709", tmdbId: 862 };
  assert.equal(selectTmdbMovieMatch({ movie_results: [movie], tv_results: [{ id: 1 }] }, target), movie);
  assert.equal(selectTmdbMovieMatch({ movie_results: [movie, { id: 2 }] }, target), null);
  assert.equal(selectTmdbMovieMatch({ tv_results: [movie] }, target), null);
  assert.equal(selectTmdbMovieMatch({ movie_results: [movie] }, { ...target, tmdbId: 2 }), null);
  assert.equal(selectTmdbMovieMatch({ movie_results: [movie] }, { imdbId: "invalid" }), null);
});
test("details must agree with the vetted movie identity; conflicting IMDb never passes", () => {
  assert.equal(matchesTmdbMovie({ id: 862, imdb_id: "tt0114709" }, { imdbId: "tt0114709" }), true);
  assert.equal(matchesTmdbMovie({ id: 862, imdb_id: null }, { imdbId: "tt0114709", tmdbId: 862 }), true);
  assert.equal(matchesTmdbMovie({ id: 862 }, { imdbId: "tt0114709" }), false);
  assert.equal(matchesTmdbMovie({ id: 862, imdb_id: "tt0000001" }, { imdbId: "tt0114709", tmdbId: 862 }), false);
  assert.equal(matchesTmdbMovie({ id: 862, imdb_id: "tt0114709", external_ids: { imdb_id: "tt0000001" } }, { imdbId: "tt0114709" }), false);
  assert.equal(matchesTmdbMovie({ id: 863, imdb_id: "tt0114709" }, { imdbId: "tt0114709", tmdbId: 862 }), false);
});
test("TV matching accepts original/alternate names and exact first-air year only", () => {
  const show = { id: 100, name: "Translated Name", original_name: "L'été", first_air_date: "2010-05-06" };
  assert.equal(selectTmdbTvMatch({ results: [show], total_pages: 1 }, { title: "L'ete", year: 2010 }), show);
  assert.equal(selectTmdbTvMatch([show], { title: "Other", alternateTitle: "Translated Name", year: 2010 }), show);
  assert.equal(selectTmdbTvMatch([show], { title: "L'ete", year: 2011 }), null);
  assert.equal(selectTmdbTvMatch([show], { title: "L'ete", year: null }), null);
  assert.equal(selectTmdbTvMatch([{ ...show, first_air_date: "2010-99-99" }], { title: "L'ete", year: 2010 }), null);
});
test("TV ambiguity and incomplete paginated result sets fail closed", () => {
  const show = { id: 1, name: "Example", first_air_date: "2000-01-01" }, target = { title: "Example", year: 2000 };
  assert.equal(selectTmdbTvMatch([show, { ...show, id: 2 }], target), null);
  assert.equal(selectTmdbTvMatch([show, show], target), show);
  assert.equal(selectTmdbTvMatch({ results: [show], total_pages: 2 }, target), null);
});
test("poster construction accepts only official HTTPS image base and vetted sizes/paths", () => {
  assert.equal(tmdbPosterUrl("/poster.jpg"), "https://image.tmdb.org/t/p/w342/poster.jpg");
  assert.equal(tmdbPosterUrl("/poster.jpg", { posterSize: "w500" }), "https://image.tmdb.org/t/p/w500/poster.jpg");
  for (const path of ["https://evil.example/x.jpg", "/../x.jpg", "/x.jpg?token=secret", "//evil.jpg", null]) assert.equal(tmdbPosterUrl(path), undefined);
  for (const base of ["http://image.tmdb.org/t/p/", "https://evil.example/t/p/", "https://image.tmdb.org/t/p/?secret=x"]) assert.equal(tmdbPosterUrl("/x.jpg", { imageBaseUrl: base }), undefined);
});
test("movie extraction whitelists names/artwork and omits all API community signals", () => {
  const details = tmdbDisplayDetails({ id: 862, poster_path: "/poster.jpg", vote_average: 9, vote_count: 100, popularity: 200,
    credits: { cast: [{ name: "Tom Hanks" }, { name: "Tom Hanks" }, { name: "" }], crew: [{ name: "John Lasseter", job: "Director" }, { name: "Writer", job: "Writer" }] } }, { mediaType: "movie" });
  assert.deepEqual(details.cast, ["Tom Hanks"]);
  assert.deepEqual(details.directors, ["John Lasseter"]);
  assert.equal(details.metadataSource.url, "https://www.themoviedb.org/movie/862");
  for (const key of ["vote_average", "vote_count", "popularity", "credits", "rating"]) assert.equal(details[key], undefined);
});
test("TV uses aggregate credits, explicit creators, and premiered regular seasons", () => {
  const details = tmdbDisplayDetails({ id: 1, first_air_date: "2008-01-20", last_air_date: "2013-09-29", status: "Ended",
    created_by: [{ name: "Vince Gilligan" }], credits: { cast: [{ name: "Latest season only" }] },
    aggregate_credits: { cast: [{ name: "Bryan Cranston" }], crew: [{ name: "Director", jobs: [{ job: "Director" }] }] },
    number_of_seasons: 99, seasons: [{ season_number: 0, air_date: "2008-01-01" }, { season_number: 1, air_date: "2008-01-20" },
      { season_number: 2, air_date: "2009-03-08" }, { season_number: 3, air_date: null }, { season_number: 4, air_date: "2030-01-01" }] }, { mediaType: "series", asOf: "2026-11-10" });
  assert.deepEqual(details.cast, ["Bryan Cranston"]);
  assert.deepEqual(details.creators, ["Vince Gilligan"]);
  assert.deepEqual(details.directors, ["Director"]);
  assert.equal(details.seasonCount, 2);
  assert.equal(details.seasonCountAsOf, "2026-11-10");
  assert.equal(details.endYear, 2013);
  assert.equal(tmdbDisplayDetails({ id: 1, status: "Returning Series", first_air_date: "2008-01-20", last_air_date: "2025-01-01" }, { mediaType: "series" }).endYear, undefined);
  assert.deepEqual(tmdbDisplayDetails({ id: 0 }, { mediaType: "movie" }), {});
});
