/** Loopback-only end-to-end checks with fresh, isolated Afterglow accounts. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const port = Number(process.env.AFTERGLOW_TEST_PORT || 5173);
assert.ok([5173, 5174].includes(port), "Smoke checks are restricted to the two local preview ports.");
const origin = `http://127.0.0.1:${port}`;
const suffix = randomBytes(6).toString("hex");
const password = randomBytes(24).toString("base64url");
function client() {
  let cookie = "";
  const request = async function request(path, { method = "GET", body, headers = {}, expected = 200 } = {}) {
    if (process.env.AFTERGLOW_SMOKE_TRACE) console.log(`${method} ${path}`);
    const response = await fetch(origin + path, {
      // Wrangler's local proxy can expire idle sockets while cold assets load.
      // Keep this diagnostic suite independent of its HTTP keep-alive pool.
      method, signal: AbortSignal.timeout(90_000), headers: { Connection: "close", "CF-Connecting-IP": `local-smoke-${suffix}`, ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== "GET" ? { Origin: origin } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    const text = await response.text();
    const data = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : { error: text };
    assert.equal(response.status, expected, `${method} ${path}: ${data.error || response.status}`);
    return data;
  };
  request.cookie = () => cookie;
  return request;
}
const alice = client(), bob = client(), outsider = client(), anonymous = client();
assert.equal((await anonymous("/api/me")).user, null);
assert.equal((await anonymous("/api/me", { headers: { "oai-authenticated-user-id": "local_seedy", "oai-authenticated-user-email": "spoof@example.test" } })).user, null);
await anonymous("/api/lists", { expected: 401 });
for (const [request, name] of [[alice, "a"], [bob, "b"], [outsider, "c"]]) {
  await request("/api/auth/register", { method: "POST", expected: 201,
    body: { username: `local_test_${name}_${suffix}`, displayName: `Test ${name}`, password } });
}
const a = await alice("/api/me"), b = await bob("/api/me");
assert.ok(a.user.id && a.user.friendCode && b.user.id);
assert.equal(a.ratingScale, 10);
assert.equal(a.models.movies.candidateCount, 6818);
assert.equal(a.models.series.candidateCount, 1715);
assert.deepEqual(a.titleStates, []);
await anonymous('/api/title-state', { method: 'PUT', body: { movieId: 1, liked: true }, expected: 401 });

const film = (await alice("/api/movies?type=movies&q=Toy%20Story")).movies.find(m => m.movieId === 1);
const series = (await alice("/api/movies?type=series&q=Breaking%20Bad")).movies[0];
assert.ok(film && series);
const save = (request, item, rating) => request("/api/ratings", { method: "PUT", body: { movieId: item.movieId, rating, ratingScale: 10 } });
await save(alice, film, 7.6);
await save(alice, series, 8.1);
await save(bob, film, 9.3);
assert.equal((await alice("/api/me")).ratings.find(r => r.movieId === film.movieId).rating, 7.6);
assert.equal((await bob("/api/me")).ratings.length, 1);
assert.equal((await outsider("/api/me")).ratings.length, 0);
await alice("/api/ratings", { method: "PUT", body: { movieId: film.movieId, rating: 7.55, ratingScale: 10 }, expected: 400 });
await alice("/api/ratings", { method: "PUT", body: { movieId: film.movieId, rating: 8, ratingScale: 10 }, headers: { Origin: "https://other.example" }, expected: 403 });
const separate = await alice("/api/recommendations?type=both&limit=12");
assert.equal(separate.sections.movies.mode, "starter");
assert.equal(separate.sections.series.mode, "personalized");
assert.ok(separate.movies.every(m => m.mediaType === "movie" && m.movieId !== film.movieId));
assert.ok(separate.series.every(m => m.mediaType === "series" && m.movieId !== series.movieId));
const expandedPersonal = await alice('/api/recommendations?type=both');
for (const kind of ['movies', 'series']) {
  assert.equal(expandedPersonal.sections[kind].movies.length, 20, `${kind}: default shelf has twenty titles`);
  assert.deepEqual(expandedPersonal.sections[kind].movies.slice(0, 12), separate.sections[kind].movies, `${kind}: expanding the shelf preserves existing ranking and scores`);
}
await alice('/api/recommendations?limit=49', { expected: 400 });

// Favorites override the positive-preference threshold without rewriting scores.
const stateOf = (account, id) => account.titleStates.find(state => state.movieId === id);
const rankingOf = result => result.movies.map(({ movieId, score }) => ({ movieId, score }));
await save(alice, series, 3);
assert.equal((await alice('/api/recommendations?type=series&limit=12')).mode, 'starter');
await alice('/api/title-state', { method: 'PUT', body: { movieId: series.movieId, liked: true } });
const favoriteSeries = await alice('/api/recommendations?type=series&limit=12');
assert.equal(favoriteSeries.mode, 'personalized');
assert.equal(favoriteSeries.likes, 1);
assert.deepEqual(rankingOf(favoriteSeries), rankingOf({ movies: separate.series }));
assert.equal((await alice('/api/me')).ratings.find(entry => entry.movieId === series.movieId).rating, 3);
await alice('/api/title-state', { method: 'PUT', body: { movieId: series.movieId, liked: false } });
assert.equal((await alice('/api/recommendations?type=series&limit=12')).mode, 'starter');
await save(alice, series, 8.1);
await save(alice, film, 3);
await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: true } });
let activity = await alice('/api/me');
assert.equal(activity.ratings.find(rating => rating.movieId === film.movieId).rating, 3);
assert.deepEqual(stateOf(activity, film.movieId), { movieId: film.movieId, liked: true, watched: true });
assert.equal(stateOf(await bob('/api/me'), film.movieId).liked, false, 'Favorites belong only to the signed-in account.');
assert.deepEqual((await outsider('/api/me')).titleStates, []);
const likedLowScore = await alice('/api/recommendations?type=movies&limit=12');
assert.equal(likedLowScore.mode, 'personalized', 'A Favorite is an explicit positive preference even at 3/10.');
assert.equal(likedLowScore.likes, 1, 'The rated Favorite must count once.');
assert.deepEqual(rankingOf(likedLowScore), rankingOf(await bob('/api/recommendations?type=movies&limit=12')));
await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: false } });
const noFavorite = await alice('/api/recommendations?type=movies&limit=12');
assert.equal(noFavorite.mode, 'starter');
assert.deepEqual(noFavorite.movies.map(item => item.movieId), separate.movies.map(item => item.movieId));
assert.equal((await alice('/api/me')).ratings.find(entry => entry.movieId === film.movieId).rating, 3);
await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: true } });
await outsider('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: true } });
const favoriteOnly = await outsider('/api/recommendations?type=movies&limit=12');
assert.equal(favoriteOnly.mode, 'personalized');
assert.equal(favoriteOnly.ratingsCount, 0, 'A Favorite must not invent a score.');
assert.ok(!favoriteOnly.movies.some(item => item.movieId === film.movieId));
assert.deepEqual((await outsider('/api/me')).ratings, []);
assert.equal(stateOf(await outsider('/api/me'), film.movieId).watched, false, 'Favoriting must not invent watched status.');
await outsider('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: false } });
assert.equal((await outsider('/api/recommendations?type=movies&limit=12')).mode, 'starter');
await alice(`/api/ratings?movieId=${film.movieId}`, { method: 'DELETE' });
activity = await alice('/api/me');
assert.ok(!activity.ratings.some(rating => rating.movieId === film.movieId));
assert.deepEqual(stateOf(activity, film.movieId), { movieId: film.movieId, liked: true, watched: true });
assert.ok(!(await alice('/api/recommendations?type=movies&limit=12')).movies.some(item => item.movieId === film.movieId));
await save(alice, film, 3);
const undone = await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, watched: false } });
assert.equal(undone.ratingRemoved, true);
activity = await alice('/api/me');
assert.ok(!activity.ratings.some(rating => rating.movieId === film.movieId));
assert.deepEqual(stateOf(activity, film.movieId), { movieId: film.movieId, liked: true, watched: false });
await save(alice, film, 7.6);
const watchedWithoutScore = separate.movies[0];
await alice('/api/title-state', { method: 'PUT', body: { movieId: watchedWithoutScore.movieId, watched: true } });
activity = await alice('/api/me');
assert.ok(!activity.ratings.some(rating => rating.movieId === watchedWithoutScore.movieId));
const withoutWatched = await alice('/api/recommendations?type=movies&limit=12');
assert.equal(withoutWatched.movies.length, 12, 'Watched exclusions must be applied before the requested limit.');
assert.ok(!withoutWatched.movies.some(item => item.movieId === watchedWithoutScore.movieId));
assert.equal(withoutWatched.ratingsCount, likedLowScore.ratingsCount);
await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: 'true' }, expected: 400 });
await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, watched: null }, expected: 400 });
await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId }, expected: 400 });
await alice('/api/title-state', { method: 'PUT', body: { movieId: 999999999, watched: true }, expected: 400 });
await alice('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: false }, headers: { Origin: 'https://other.example' }, expected: 403 });
assert.equal(stateOf(await alice('/api/me'), film.movieId).liked, true);

const watchlist = (await alice("/api/lists", { method: "POST", body: { name: "Test watchlist", kind: "watchlist", mediaType: "both" } })).list;
await alice(`/api/lists/${watchlist.id}/items`, { method: "POST", body: { movieId: series.movieId } });
assert.equal((await alice(`/api/lists/${watchlist.id}`)).items[0].movieId, series.movieId);
await outsider(`/api/lists/${watchlist.id}`, { expected: 404 });
await outsider(`/api/lists/${watchlist.id}/items`, { method: "POST", body: { movieId: film.movieId }, expected: 404 });
const pending = await alice("/api/friends", { method: "POST", body: { friendCode: b.user.friendCode } });
await alice("/api/lists", { method: "POST", body: { name: "Not accepted", kind: "together", mediaType: "both", memberIds: [b.user.id] }, expected: 403 });
await bob("/api/friends", { method: "PATCH", body: { requestId: pending.requestId, action: "accept" } });
const together = (await alice("/api/lists", { method: "POST", body: { name: "Test double feature", kind: "together", mediaType: "both", memberIds: [b.user.id] } })).list;
assert.equal(together.members.length, 2);
await outsider(`/api/lists/${together.id}/recommendations`, { expected: 404 });
await bob(`/api/lists/${together.id}`, { method: "PATCH", body: { name: "Cannot rename" }, expected: 403 });
const group = await bob(`/api/lists/${together.id}/recommendations?limit=12`);
assert.equal(group.sections.movies.movies.length, 12);
assert.equal(group.sections.series.movies.length, 12);
const expandedGroup = await bob(`/api/lists/${together.id}/recommendations`);
for (const kind of ['movies', 'series']) {
  assert.equal(expandedGroup.sections[kind].movies.length, 20, `${kind}: default Together shelf has twenty titles`);
  assert.deepEqual(expandedGroup.sections[kind].movies.slice(0, 12), group.sections[kind].movies, `${kind}: Together utilities are independent of shelf size`);
}
for (const item of [...group.movies, ...group.series]) assert.ok(![film.movieId, series.movieId, watchedWithoutScore.movieId].includes(item.movieId));
assert.ok(!JSON.stringify(group).includes('"ratings":'), "Group responses must not expose individual histories.");
assert.ok(!JSON.stringify(group).includes('"titleStates":'), 'Group responses must not expose private Likes or watched flags.');
await save(bob, film, 3);
await bob('/api/title-state', { method: 'PUT', body: { movieId: film.movieId, liked: true } });
const favoriteGroup = await bob(`/api/lists/${together.id}/recommendations?limit=12`);
assert.deepEqual(rankingOf(favoriteGroup.sections.movies), rankingOf(group.sections.movies), 'Each group member’s Favorite supplies the same positive profile as their former high score.');
assert.deepEqual(rankingOf(favoriteGroup.sections.series), rankingOf(group.sections.series));
assert.equal((await bob('/api/me')).ratings.find(entry => entry.movieId === film.movieId).rating, 3);
assert.ok(!JSON.stringify(favoriteGroup).includes('favoriteIds'));

const queue = await alice("/api/rating-queue?type=movies&limit=12");
assert.ok(queue.movies.length && queue.movies.every(m => m.mediaType === "movie" && m.movieId !== film.movieId));
const skipped = queue.movies[0].movieId, unseen = queue.movies[1].movieId;
await alice("/api/rating-queue", { method: "POST", body: { movieId: skipped, status: "skip" } });
await alice("/api/rating-queue", { method: "POST", body: { movieId: unseen, status: "unseen" } });
const nextQueue = await alice("/api/rating-queue?type=movies&limit=12");
assert.ok(nextQueue.movies.every(m => m.movieId !== skipped && m.movieId !== unseen));
await save(alice, { movieId: unseen }, 6.4);
await alice(`/api/ratings?movieId=${unseen}`, { method: "DELETE" });
assert.ok((await alice("/api/rating-queue?type=movies&limit=12")).movies.some(m => m.movieId === unseen), "Saving a searched title clears an earlier haven't-seen mark.");
await alice("/api/rating-queue", { method: "POST", body: { movieId: skipped, status: "clear" } });
await alice("/api/rating-queue", { method: "POST", body: { movieId: unseen, status: "clear" } });
await alice(`/api/lists/${together.id}`, { method: "DELETE" });
await alice(`/api/lists/${watchlist.id}`, { method: "DELETE" });
await alice(`/api/ratings?movieId=${film.movieId}`, { method: "DELETE" });
await alice(`/api/ratings?movieId=${series.movieId}`, { method: "DELETE" });
await bob(`/api/ratings?movieId=${film.movieId}`, { method: "DELETE" });
await alice('/api/title-state', { method: 'PUT', body: { movieId: watchedWithoutScore.movieId, watched: false } });
await alice(`/api/ratings?movieId=${film.movieId}&watched=false`, { method: 'DELETE' });
assert.equal(stateOf(await alice('/api/me'), film.movieId).watched, false);
assert.equal(stateOf(await alice('/api/me'), film.movieId).liked, true);
await alice("/api/friends", { method: "PATCH", body: { requestId: pending.requestId, action: "remove" } });
const revokedCookie = alice.cookie();
await alice("/api/auth/logout", { method: "POST" });
assert.equal((await alice("/api/me")).user, null);
assert.equal((await anonymous("/api/me", { headers: { Cookie: revokedCookie } })).user, null, "A logged-out session token must remain revoked when replayed.");
await alice("/api/auth/login", { method: "POST", body: { username: a.user.username, password } });
assert.equal((await alice("/api/me")).user.id, a.user.id);
for (const request of [alice, bob, outsider]) await request("/api/auth/logout", { method: "POST" });
console.log("Passed Afterglow accounts, rating tenths, Favorite overrides for movie/TV/personal/Together recommendations, preserved scores and watched state, rating removal, private watchlists, friendship consent, group authorization, queue choices, and logout/login checks.");
