/** Pure authorization and ranking policies. Utilities are ordinal, not ratings. */
export const SKIP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function friendshipPairKey(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right || left === right) throw new Error("Two distinct users are required.");
  return JSON.stringify([left, right].sort());
}

/** @param {{ownerId:string,members:Array<{userId:string}>}} list @param {string} userId @param {string} action */
export function listPermission(list, userId, action) {
  if (!list.members.some((member) => member.userId === userId)) return false;
  if (action === "read" || action === "items") return true;
  if (action === "manage") return list.ownerId === userId;
  if (action === "leave") return list.ownerId !== userId;
  return false;
}

/** @param {{requesterId:string,recipientId:string,status:string}} friendship @param {string} userId @param {string} action */
export function friendActionAllowed(friendship, userId, action) {
  if (action === "accept" || action === "decline") return friendship.status === "pending" && friendship.recipientId === userId;
  if (action === "cancel") return friendship.status === "pending" && friendship.requesterId === userId;
  if (action === "remove") return friendship.status === "accepted" && [friendship.requesterId, friendship.recipientId].includes(userId);
  return false;
}

/** Complete rankings must cover the same eligible unseen pool. A truncated
 * intersection is rejected rather than presented as group personalization.
 * @param {Array<Array<{movieId:number,[key:string]:any}>>} rankings
 * @param {{eligibleIds:ReadonlySet<number>,blockedIds?:ReadonlySet<number>,limit?:number}} options
 */
export function aggregateGroupRankings(rankings, { eligibleIds, blockedIds = new Set(), limit = 12 }) {
  if (!rankings.length || !Number.isInteger(limit) || limit < 1 || limit > 48) throw new Error("A group and valid limit are required.");
  const expected = new Set([...eligibleIds].filter((id) => !blockedIds.has(id)));
  const ordered = rankings.map((ranking) => {
    const seen = new Set();
    for (const item of ranking) {
      if (!Number.isSafeInteger(item.movieId) || seen.has(item.movieId)) throw new Error("Invalid or duplicate ranked identity.");
      seen.add(item.movieId);
    }
    const remaining = ranking.filter((item) => expected.has(item.movieId));
    if (remaining.length !== expected.size) throw new Error("Group inference requires complete candidate rankings.");
    return remaining;
  });
  const size = expected.size;
  if (!size) return [];
  const utilities = ordered.map((ranking) => new Map(ranking.map((item, index) => [item.movieId, size === 1 ? 1 : 1 - index / (size - 1)])));
  return ordered[0].map((item) => {
    const values = utilities.map((profile) => profile.get(item.movieId));
    const minimum = Math.min(...values);
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    return { item, minimum, mean, score: .5 * minimum + .5 * mean };
  }).sort((a, b) => b.score - a.score || b.minimum - a.minimum || b.mean - a.mean || a.item.movieId - b.item.movieId)
    .slice(0, limit).map(({ item, score }) => ({ ...item, score, reason: "Balances the tastes of everyone on this list." }));
}

/** @param {{status:string,updatedAt:Date|number|string}} entry @param {number} now */
export function queueStatusBlocks(entry, now) {
  return entry.status === "unseen" || (entry.status === "skip" && now - new Date(entry.updatedAt).getTime() < SKIP_COOLDOWN_MS);
}

/** Rating prompts intentionally omit public ratings and recommendation praise. */
export function ratingPromptCard(item) {
  const { imdbRating, imdbVotes, imdbAdjustment, quality, popularity, score, reason, ...prompt } = item;
  return prompt;
}

/** @param {Array<{movieId:number,title:string,popularity:number,[key:string]:any}>} items
 * @param {Array<{movieId:number}>} ratings
 * @param {Array<{movieId:number,status:string,updatedAt:Date|number|string}>} statuses
 * @param {{limit?:number,excludeIds?:ReadonlySet<number>,now?:number}} options */
export function selectRatingQueue(items, ratings, statuses, { limit = 12, excludeIds = new Set(), now = Date.now() } = {}) {
  const blocked = new Set([...ratings.map((entry) => entry.movieId), ...excludeIds,
    ...statuses.filter((entry) => queueStatusBlocks(entry, now)).map((entry) => entry.movieId)]);
  const eligible = items.filter((item) => !blocked.has(item.movieId)).sort((a, b) => b.popularity - a.popularity || a.movieId - b.movieId);
  return { movies: eligible.slice(0, limit).map(ratingPromptCard), remaining: eligible.length };
}
