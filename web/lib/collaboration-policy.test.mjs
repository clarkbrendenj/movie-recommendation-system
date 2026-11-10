import assert from "node:assert/strict";
import test from "node:test";
import { aggregateGroupRankings, friendActionAllowed, friendshipPairKey, listPermission,
  queueStatusBlocks, selectRatingQueue, SKIP_COOLDOWN_MS } from "./collaboration-policy.mjs";

const cards = (ids) => ids.map((movieId) => ({ movieId, title: `Title ${movieId}`, score: movieId, reason: "A private personal reason" }));

test("only actual list members can read or edit items, and only the owner manages settings", () => {
  const list = { ownerId: "owner", members: [{ userId: "owner" }, { userId: "friend" }] };
  assert.equal(listPermission(list, "owner", "manage"), true);
  assert.equal(listPermission(list, "friend", "manage"), false);
  assert.equal(listPermission(list, "friend", "items"), true);
  assert.equal(listPermission(list, "friend", "leave"), true);
  assert.equal(listPermission(list, "owner", "leave"), false);
  for (const action of ["read", "items", "manage", "leave"]) assert.equal(listPermission(list, "stranger", action), false);
  assert.equal(listPermission({ ...list, members: [{ userId: "friend" }] }, "owner", "manage"), false);
});

test("a friend request requires the recipient's explicit acceptance", () => {
  const pending = { requesterId: "A", recipientId: "B", status: "pending" };
  assert.equal(friendActionAllowed(pending, "B", "accept"), true);
  assert.equal(friendActionAllowed(pending, "B", "decline"), true);
  assert.equal(friendActionAllowed(pending, "A", "accept"), false);
  assert.equal(friendActionAllowed(pending, "A", "cancel"), true);
  assert.equal(friendActionAllowed(pending, "B", "cancel"), false);
  for (const action of ["accept", "decline", "cancel", "remove"]) assert.equal(friendActionAllowed(pending, "C", action), false);
  const accepted = { ...pending, status: "accepted" };
  assert.equal(friendActionAllowed(accepted, "A", "remove"), true);
  assert.equal(friendActionAllowed(accepted, "B", "remove"), true);
  assert.equal(friendActionAllowed(accepted, "B", "accept"), false);
});

test("friendship uniqueness is direction-independent without delimiter ambiguity", () => {
  assert.equal(friendshipPairKey("A", "B"), friendshipPairKey("B", "A"));
  assert.notEqual(friendshipPairKey("a:b", "c"), friendshipPairKey("a", "b:c"));
  assert.throws(() => friendshipPairKey("A", "A"));
});

test("balanced rank utility has an exact weakest-plus-mean numeric oracle", () => {
  const result = aggregateGroupRankings([cards([1, 2, 3]), cards([3, 2, 1])], { eligibleIds: new Set([1, 2, 3]) });
  assert.deepEqual(result.map((item) => item.movieId), [2, 1, 3]);
  assert.deepEqual(result.map((item) => item.score), [.5, .25, .25]);
  assert.ok(result.every((item) => item.reason === "Balances the tastes of everyone on this list."));
  assert.ok(result.every((item) => !Object.hasOwn(item, "minimum") && !Object.hasOwn(item, "mean") && !Object.hasOwn(item, "utilities")));
});

test("group ranking finds a compromise outside both individual top-twelve lists", () => {
  const ascending = Array.from({ length: 30 }, (_, i) => i + 1);
  const descending = [...ascending].reverse();
  assert.equal(ascending.slice(0, 12).filter((id) => descending.slice(0, 12).includes(id)).length, 0);
  const result = aggregateGroupRankings([cards(ascending), cards(descending)], { eligibleIds: new Set(ascending), limit: 2 });
  assert.deepEqual(result.map((item) => item.movieId), [15, 16]);
  assert.ok(Math.abs(result[0].score - (.5 * 14 / 29 + .25)) < 1e-12);
});

test("truncated candidate intersections and duplicate identities are rejected", () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.throws(() => aggregateGroupRankings([cards(ids.slice(0, 12)), cards(ids.slice(18))], { eligibleIds: new Set(ids) }), /complete candidate/);
  assert.throws(() => aggregateGroupRankings([cards([1, 1])], { eligibleIds: new Set([1]) }), /duplicate/);
  assert.throws(() => aggregateGroupRankings([], { eligibleIds: new Set([1]) }));
});

test("union-seen and veto masking happen before common-pool normalization", () => {
  const rankings = [cards([1, 2, 3, 4]), cards([4, 3, 2])];
  const before = JSON.stringify(rankings);
  const result = aggregateGroupRankings(rankings, { eligibleIds: new Set([1, 2, 3, 4]), blockedIds: new Set([1, 3]) });
  assert.deepEqual(result.map((item) => item.movieId), [2, 4]);
  assert.deepEqual(result.map((item) => item.score), [.25, .25]);
  assert.equal(JSON.stringify(rankings), before);
});

test("cold-start order still has rank utility and exhausted pools are valid", () => {
  const cold = cards([5, 4, 3]).map((item) => ({ ...item, score: 0 }));
  assert.deepEqual(aggregateGroupRankings([cold, cold], { eligibleIds: new Set([3, 4, 5]) }).map((item) => item.movieId), [5, 4, 3]);
  assert.equal(aggregateGroupRankings([cards([9])], { eligibleIds: new Set([9]) })[0].score, 1);
  assert.deepEqual(aggregateGroupRankings([[], []], { eligibleIds: new Set() }), []);
});

test("skip expires after exactly twenty-four hours; haven't-seen persists", () => {
  const now = 1_000_000_000;
  assert.equal(queueStatusBlocks({ status: "skip", updatedAt: now - SKIP_COOLDOWN_MS + 1 }, now), true);
  assert.equal(queueStatusBlocks({ status: "skip", updatedAt: now - SKIP_COOLDOWN_MS }, now), false);
  assert.equal(queueStatusBlocks({ status: "unseen", updatedAt: 0 }, now), true);
});

test("rating queue excludes every rating and persistent queue marks without creating dislikes", () => {
  const now = 1_000_000_000;
  const items = Array.from({ length: 6 }, (_, i) => ({ movieId: i + 1, title: `Title ${i + 1}`, popularity: 10 - i,
    imdbRating: 9, imdbVotes: 1000, imdbAdjustment: .5, quality: .9, score: 1, reason: "Popular!" }));
  const ratings = [{ movieId: 1, rating: .5 }];
  const marks = [{ movieId: 2, status: "unseen", updatedAt: 0 }, { movieId: 3, status: "skip", updatedAt: now },
    { movieId: 4, status: "skip", updatedAt: now - SKIP_COOLDOWN_MS }];
  const before = JSON.stringify({ items, ratings, marks });
  const queue = selectRatingQueue(items, ratings, marks, { now, excludeIds: new Set([6]) });
  assert.deepEqual(queue.movies.map((item) => item.movieId), [4, 5]);
  assert.equal(queue.remaining, 2);
  for (const item of queue.movies) for (const field of ["imdbRating", "imdbVotes", "imdbAdjustment", "quality", "popularity", "score", "reason"]) assert.equal(Object.hasOwn(item, field), false);
  assert.equal(JSON.stringify({ items, ratings, marks }), before);
});
