/** Local development integration checks; never run against a hosted account. */
import assert from "node:assert/strict";

const origin = "http://127.0.0.1:5173";
const localCookie = "__sites_local_auth=1";
async function request(path, { signedIn = true, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(signedIn ? { Cookie: localCookie } : {}),
      ...(method !== "GET" ? { Origin: origin } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const data = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : { error: text };
  return { status: response.status, headers: response.headers, body: data };
}

const anonymous = await request("/api/me", { signedIn: false });
assert.equal(anonymous.status, 200);
assert.equal(anonymous.body.user, null);
assert.deepEqual(anonymous.body.ratings, []);
assert.equal(anonymous.body.ratingScale, 10);
assert.equal((await request("/api/ratings", { signedIn: false, method: "PUT", body: { movieId: 1, rating: 8, ratingScale: 10 } })).status, 401);
const original = await request("/api/me");
assert.equal(original.status, 200);
assert.equal(original.body.user.id, "local_seedy");
assert.equal(original.body.ratingScale, 10);
assert.match(original.headers.get("cache-control"), /private.*no-store/);
const originalRating = original.body.ratings.find((rating) => rating.movieId === 1);
const otherLikes = original.body.ratings.filter((rating) => rating.movieId !== 1 && rating.rating >= 8).length;
async function save(rating, extra = {}) {
  return request("/api/ratings", { method: "PUT", body: { movieId: 1, rating, ratingScale: 10, ...extra } });
}
try {
  for (const rating of [0, 11, 4.5, "8"]) assert.equal((await save(rating)).status, 400);
  assert.equal((await request("/api/ratings", { method: "PUT", body: { movieId: 1, rating: 5 } })).status, 400);
  assert.equal((await save(5, { ratingScale: 5 })).status, 400);
  assert.equal((await save(5, { ratingScale: "10" })).status, 400);
  assert.equal((await request("/api/ratings", { method: "PUT", headers: { Origin: "https://other.example" }, body: { movieId: 1, rating: 10, ratingScale: 10 } })).status, 403);
  const forged = await request("/api/me?userId=someone-else", { headers: {
    "oai-authenticated-user-id": "someone-else", "oai-authenticated-user-email": "other@example.test",
  } });
  assert.equal(forged.body.user.id, "local_seedy");
  for (const [rating, expectedLikes] of [[1, otherLikes], [10, otherLikes + 1], [7, otherLikes], [8, otherLikes + 1]]) {
    assert.equal((await save(rating)).status, 200);
    const current = await request("/api/me");
    assert.equal(current.body.ratingScale, 10);
    assert.equal(current.body.ratings.find((entry) => entry.movieId === 1)?.rating, rating);
    const recommendations = await request("/api/recommendations?limit=12");
    assert.equal(recommendations.status, 200);
    assert.equal(recommendations.body.likes, expectedLikes);
    assert.ok(!recommendations.body.movies.some((movie) => movie.movieId === 1));
  }
  assert.equal((await save(9, { userId: "someone-else" })).status, 200);
  const saved = await request("/api/me");
  assert.equal(saved.body.ratings.find((rating) => rating.movieId === 1)?.rating, 9);
  assert.equal(saved.body.user.id, "local_seedy");
  const personalized = await request("/api/recommendations?limit=12");
  assert.equal(personalized.status, 200);
  assert.equal(personalized.body.mode, "personalized");
  assert.equal(personalized.body.movies.length, 12);
  assert.ok(!personalized.body.movies.some((movie) => movie.movieId === 1));
  assert.equal((await save(5)).status, 200);
  assert.ok(!(await request("/api/recommendations")).body.movies.some((movie) => movie.movieId === 1));
  assert.equal((await request("/api/ratings?movieId=1", { method: "DELETE" })).status, 200);
  assert.ok(!(await request("/api/me")).body.ratings.some((rating) => rating.movieId === 1));
  const movies = await request("/api/movies?q=Toy%20Story&genre=Animation");
  assert.equal(movies.status, 200);
  assert.ok(movies.body.movies.some((movie) => movie.movieId === 1));
  console.log("Passed local API checks: anonymous access, sign-in identity, private caching, 1–10 integer validation, stale-client rejection, boundary ratings, 8/10 like threshold, cross-origin rejection, rating CRUD, seen exclusion, and search.");
} finally {
  if (originalRating) {
    assert.equal((await save(originalRating.rating)).status, 200, "Restore the original 1–10 rating.");
  } else {
    assert.equal((await request("/api/ratings?movieId=1", { method: "DELETE" })).status, 200, "Remove the temporary rating.");
  }
}
