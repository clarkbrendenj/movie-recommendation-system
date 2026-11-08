import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ratings } from "../../../db/schema";
import { isValidRating } from "../../../lib/recommender.mjs";
import { getModelMetadata } from "../../../lib/server-model";
import { api, ApiError, json, jsonBody, positiveInteger, requireUser, sameOrigin } from "../_shared";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser();
    const body = await jsonBody(request);
    const movieId = positiveInteger(body.movieId, "movie ID");
    const rating = body.rating;
    if (typeof rating !== "number" || !isValidRating(rating)) {
      throw new ApiError(400, "Choose a rating from 0.5 to 5 in half-star steps.");
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
