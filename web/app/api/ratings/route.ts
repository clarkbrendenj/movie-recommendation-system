import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ratings, ratingQueueStatuses } from "../../../db/schema";
import { isValidRating } from "../../../lib/recommender.mjs";
import { DISPLAY_RATING_SCALE, displayToModel, isValidDisplayRating } from "../../../lib/rating-scale.mjs";
import { isRateableSeries } from "../../../lib/media-catalog.mjs";
import { getModelMetadata, getTvModelMetadata } from "../../../lib/server-model";
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
    const movieId = positiveInteger(Number(new URL(request.url).searchParams.get("movieId")), "movie ID");
    await getDb().delete(ratings).where(and(eq(ratings.userId, user.userId), eq(ratings.movieId, movieId)));
    return json({ ok: true });
  }, request);
}
