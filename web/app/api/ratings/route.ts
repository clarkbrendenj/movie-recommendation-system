import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ratings } from "../../../db/schema";
import { isValidRating } from "../../../lib/recommender.mjs";
import { DISPLAY_RATING_SCALE, displayToModel, isValidDisplayRating } from "../../../lib/rating-scale.mjs";
import { getModelMetadata } from "../../../lib/server-model";
import { api, ApiError, json, jsonBody, positiveInteger, requireUser, sameOrigin } from "../_shared";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser();
    const body = await jsonBody(request);
    const movieId = positiveInteger(body.movieId, "movie ID");
    if (body.ratingScale !== DISPLAY_RATING_SCALE) {
      throw new ApiError(400, "This app uses the 1–10 rating scale. Refresh the page and try again.");
    }
    const displayRating = body.rating;
    if (typeof displayRating !== "number" || !isValidDisplayRating(displayRating)) {
      throw new ApiError(400, "Choose a whole-number rating from 1 to 10.");
    }
    const rating = displayToModel(displayRating);
    if (!isValidRating(rating)) {
      throw new ApiError(400, "That rating cannot be saved.");
    }
    const metadata = await getModelMetadata();
    if (!metadata.movies.some((movie) => movie.movieId === movieId)) throw new ApiError(400, "That movie is not in this catalog.");
    const updatedAt = new Date();
    await getDb().insert(ratings).values({ userId: user.userId, movieId, rating, updatedAt })
      .onConflictDoUpdate({ target: [ratings.userId, ratings.movieId], set: { rating, updatedAt } });
    return json({ ok: true });
  });
}

export async function DELETE(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser();
    const movieId = positiveInteger(Number(new URL(request.url).searchParams.get("movieId")), "movie ID");
    await getDb().delete(ratings).where(and(eq(ratings.userId, user.userId), eq(ratings.movieId, movieId)));
    return json({ ok: true });
  });
}
