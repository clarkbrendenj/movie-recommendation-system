import test from "node:test";
import assert from "node:assert/strict";
import { normalizedTitle, selectTvmazeMatch, tvmazeDisplayDetails } from "./title-details.mjs";

const show = (id, name = "Breaking Bad", premiered = "2008-01-20") => ({ id, name, premiered,
  url: `https://www.tvmaze.com/shows/${id}/breaking-bad`, image: { original: "https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg" },
  ended: "2013-09-29", rating: { average: 9.9 } });

test("title normalization handles punctuation and accents while retaining non-Latin titles", () => {
  assert.equal(normalizedTitle("L'été — 24"), normalizedTitle("L'ete 24"));
  assert.notEqual(normalizedTitle("東京"), normalizedTitle("大阪"));
  assert.equal(normalizedTitle(null), "");
});
test("TV matching requires exact title and premiere year", () => {
  const candidate = show(1);
  assert.equal(selectTvmazeMatch([{ show: candidate }], { title: "Breaking Bad", year: 2008 }), candidate);
  assert.equal(selectTvmazeMatch([candidate], { title: "Breaking Bad", year: 2009 }), null);
  assert.equal(selectTvmazeMatch([candidate], { title: "Breaking", year: 2008 }), null);
  assert.equal(selectTvmazeMatch([candidate], { title: "Breaking Bad", year: null }), null);
});
test("exact alternate titles work; distinct matching shows are rejected", () => {
  const candidate = show(1);
  assert.equal(selectTvmazeMatch([candidate], { title: "Otro nombre", alternateTitle: "Breaking Bad", year: 2008 }), candidate);
  assert.equal(selectTvmazeMatch([candidate, show(2)], { title: "Breaking Bad", year: 2008 }), null);
  assert.equal(selectTvmazeMatch([candidate, candidate], { title: "Breaking Bad", year: 2008 }), candidate);
});
test("display extraction counts unique numbered seasons and never copies community scores", () => {
  const details = tvmazeDisplayDetails(show(1), [{ number: 1, premiereDate: "2008-01-20" }, { number: 2, premiereDate: "2009-03-08" },
    { number: 2, premiereDate: "2009-03-08" }, { number: 0, premiereDate: "2008-01-20" }, { number: null },
    { number: 3, premiereDate: null }, { number: 4, premiereDate: "2030-01-01" }], "2026-11-09");
  assert.equal(details.seasonCount, 2);
  assert.equal(details.endYear, 2013);
  assert.equal(details.seasonCountAsOf, "2026-11-09");
  assert.equal(details.metadataSource.url, "https://www.tvmaze.com/shows/1/breaking-bad");
  assert.ok(details.posterUrl);
  assert.equal(details.rating, undefined);
});
test("untrusted source and image hosts fail closed", () => {
  assert.deepEqual(tvmazeDisplayDetails({ ...show(1), url: "https://wrong.example/shows/1/test" }), {});
  assert.equal(tvmazeDisplayDetails({ ...show(1), image: { original: "javascript:alert(1)" } }).posterUrl, undefined);
  assert.equal(tvmazeDisplayDetails({ ...show(1), image: { original: "https://other.example/poster.jpg" } }).posterUrl, undefined);
  assert.equal(tvmazeDisplayDetails({ ...show(1), url: "https://www.tvmaze.com/shows/2/test" }).metadataSource, undefined);
});
