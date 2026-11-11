import { inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ratings, titleStates } from "../../../../../db/schema";
import { aggregateGroupRankings } from "../../../../../lib/collaboration-policy.mjs";
import { rankMovies } from "../../../../../lib/recommender.mjs";
import { rankSeries } from "../../../../../lib/tv-recommender.mjs";
import { movieCandidateIds, movieCard } from "../../../../../lib/media-catalog.mjs";
import { getModel, getMovieUnitOverlay, getTvModel } from "../../../../../lib/server-model";
import { accessibleList, describeList, listId } from "../../../../../lib/server-lists";
import { api, ApiError, json, positiveInteger, requireUser } from "../../../_shared";

type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  return api(async () => {
    const user = await requireUser(request);
    const row = await accessibleList(listId((await context.params).id), user.userId);
    if (row.kind !== "recommendation") throw new ApiError(400, "Recommendations belong to a Together list.");
    const list = await describeList(row, user.userId);
    const memberIds = list.members.map((member) => member.userId);
    const params = new URL(request.url).searchParams;
    const limit = params.has("limit") ? positiveInteger(Number(params.get("limit")), "limit", 48) : 12;
    // Only this server-side computation reads consenting members' histories.
    // No participant's rating, utility, count, or personal reason is returned.
    const db = getDb();
    const [feedback, activity] = await Promise.all([
      db.select({ userId: ratings.userId, movieId: ratings.movieId, rating: ratings.rating })
        .from(ratings).where(inArray(ratings.userId, memberIds)),
      db.select({ userId: titleStates.userId, movieId: titleStates.movieId, liked: titleStates.liked, watched: titleStates.watched })
        .from(titleStates).where(inArray(titleStates.userId, memberIds)),
    ]);
    const blockedIds = new Set([...feedback, ...activity.filter(entry => entry.watched || entry.liked)].map((entry) => entry.movieId));
    const profiles = memberIds.map((id) => ({
      ratings: feedback.filter((entry) => entry.userId === id),
      favoriteIds: activity.filter(entry => entry.userId === id && entry.liked).map(entry => entry.movieId),
    }));
    const sections: Record<string, { movies: ReturnType<typeof aggregateGroupRankings>; mode: string }> = {};
    if (row.mediaType === "movies" || row.mediaType === "both") {
      const [model, overlay] = await Promise.all([getModel(), getMovieUnitOverlay()]);
      const eligibleIds = movieCandidateIds(model.metadata, overlay);
      const rankings = profiles.map((profile) => rankMovies(model, profile.ratings, eligibleIds, profile.favoriteIds.filter(id => eligibleIds.has(id)))
        .movies.map((item) => movieCard(item, overlay)));
      sections.movies = { movies: aggregateGroupRankings(rankings, { eligibleIds, blockedIds, limit }), mode: "group" };
    }
    if (row.mediaType === "series" || row.mediaType === "both") {
      const model = await getTvModel();
      const eligibleIds = new Set(model.metadata.items.filter((item) => item.mediaType === "series" && item.eligible && item.candidate).map((item) => item.movieId));
      const rankings = profiles.map((profile) => rankSeries(model, profile.ratings, profile.favoriteIds).movies);
      sections.series = { movies: aggregateGroupRankings(rankings, { eligibleIds, blockedIds, limit }), mode: "group" };
    }
    return json({ listId: row.id, type: row.mediaType, movies: sections.movies?.movies || sections.series?.movies || [], series: sections.series?.movies || [], sections,
      policy: { method: "50% weakest rank percentile + 50% mean rank percentile across the complete shared candidate pool.",
        excluded: "Every title rated, favorited, or marked watched by any member is excluded. Unknown and haven't-seen titles are not dislikes.",
        validation: "This group policy is a new preference-balancing layer, not a benchmarked rating predictor.", members: memberIds.length } });
  }, request);
}
