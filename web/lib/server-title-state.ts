import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { ratingQueueStatuses, ratings, titleStates } from '../db/schema';
import { isRateableSeries } from './media-catalog.mjs';
import { getModelMetadata, getTvModelMetadata } from './server-model';
import { ApiError } from '../app/api/_shared';

export async function validateActivityTitle(movieId: number) {
  if (!(await getModelMetadata()).movies.some(movie => movie.movieId === movieId)
    && !isRateableSeries(await getTvModelMetadata(), movieId)) {
    throw new ApiError(400, 'That title is not in this catalog.');
  }
}

export async function getUserTitleStates(userId: string) {
  return getDb().select({ movieId: titleStates.movieId, liked: titleStates.liked, watched: titleStates.watched })
    .from(titleStates).where(eq(titleStates.userId, userId));
}

export async function updateTitleState(userId: string, movieId: number, patch: {liked?: boolean; watched?: boolean}) {
  const db = getDb(), updatedAt = new Date();
  const stateWrite = db.insert(titleStates).values({ userId, movieId, liked: patch.liked ?? false, watched: patch.watched ?? false, updatedAt })
    .onConflictDoUpdate({ target: [titleStates.userId, titleStates.movieId], set: { ...patch, updatedAt } });
  if (patch.watched === false) {
    // The correction commits together, without turning an unseen mark into a score.
    await db.batch([
      stateWrite,
      db.delete(ratings).where(and(eq(ratings.userId, userId), eq(ratings.movieId, movieId))),
      db.insert(ratingQueueStatuses).values({ userId, movieId, status: 'unseen', updatedAt })
        .onConflictDoUpdate({ target: [ratingQueueStatuses.userId, ratingQueueStatuses.movieId], set: { status: 'unseen', updatedAt } }),
    ]);
  } else if (patch.watched === true) {
    await db.batch([stateWrite,
      db.delete(ratingQueueStatuses).where(and(eq(ratingQueueStatuses.userId, userId), eq(ratingQueueStatuses.movieId, movieId))),
    ]);
  } else await stateWrite;
  const [state] = await db.select({ movieId: titleStates.movieId, liked: titleStates.liked, watched: titleStates.watched })
    .from(titleStates).where(and(eq(titleStates.userId, userId), eq(titleStates.movieId, movieId)));
  return state;
}
