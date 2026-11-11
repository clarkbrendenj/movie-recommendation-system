import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ratings, ratingQueueStatuses, titleStates } from "../../../db/schema";
import { isValidRating } from "../../../lib/recommender.mjs";
import { DISPLAY_RATING_SCALE, displayToModel, isValidDisplayRating } from "../../../lib/rating-scale.mjs";
import { isRateableSeries } from "../../../lib/media-catalog.mjs";
import { getModelMetadata, getTvModelMetadata } from "../../../lib/server-model";
import { updateTitleState, validateActivityTitle } from "../../../lib/server-title-state";
import { api, ApiError, json, jsonBody, positiveInteger, requireUser, sameOrigin } from "../_shared";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const body = await jsonBody(request);
    const movieId = positiveInteger(body.movieId, "movie ID");
    if (body.ratingScale !== DISPLAY_RATING_SCALE) {
      throw new ApiError(400, "This app uses the 1–10 rating scale. Refresh the page and try again.");
    }
    const displayRating = body.rating;
    if (typeof displayRating !== "number" || !isValidDisplayRating(displayRating)) {
      throw new ApiError(400, "Choose a rating from 1 to 10 in steps of 0.1.");
    }
    const rating = displayToModel(displayRating);
    if (!isValidRating(rating)) {
      throw new ApiError(400, "That rating cannot be saved.");
    }
    const metadata = await getModelMetadata();
    if (!metadata.movies.some((movie) => movie.movieId === movieId)
      && !isRateableSeries(await getTvModelMetadata(), movieId)) {
      throw new ApiError(400, "That title is not in this catalog.");
    }
    const updatedAt = new Date();
    const db = getDb();
    await db.batch([
      db.insert(ratings).values({ userId: user.userId, movieId, rating, updatedAt })
        .onConflictDoUpdate({ target: [ratings.userId, ratings.movieId], set: { rating, updatedAt } }),
      db.insert(titleStates).values({ userId: user.userId, movieId, watched: true, liked: false, updatedAt })
        .onConflictDoUpdate({ target: [titleStates.userId, titleStates.movieId], set: { watched: true, updatedAt } }),
      // A rating means the title has now been seen, including when found by search.
      db.delete(ratingQueueStatuses).where(and(eq(ratingQueueStatuses.userId, user.userId), eq(ratingQueueStatuses.movieId, movieId))),
    ]);
    return json({ ok: true });
  }, request);
}

export async function DELETE(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const movieId = positiveInteger(Number(params.get("movieId")), "movie ID");
    if (params.has('watched') && params.get('watched') !== 'false') throw new ApiError(400, 'Choose watched=false to undo an unseen title.');
    if (params.get('watched') === 'false') {
      // Exact-ID deletion is also allowed for retired titles in an old history.
      try { await validateActivityTitle(movieId); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 400) throw error;
        const [existing] = await getDb().select({ movieId: ratings.movieId }).from(ratings)
          .where(and(eq(ratings.userId, user.userId), eq(ratings.movieId, movieId))).limit(1);
        if (!existing) throw error;
      }
      const state = await updateTitleState(user.userId, movieId, { watched: false });
      return json({ ok: true, state, ratingRemoved: true });
    }
    await getDb().delete(ratings).where(and(eq(ratings.userId, user.userId), eq(ratings.movieId, movieId)));
    return json({ ok: true, ratingRemoved: true });
  }, request);
}
