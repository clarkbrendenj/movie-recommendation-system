import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ratingQueueStatuses } from "../../../db/schema";
import { getAppUser } from "../../../lib/auth";
import { selectRatingQueue } from "../../../lib/collaboration-policy.mjs";
import { currentCatalog } from "../../../lib/server-lists";
import { api, ApiError, getUserRatings, json, jsonBody, positiveInteger, requireUser, sameOrigin } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return api(async () => {
    const params = new URL(request.url).searchParams;
    const type = params.get("type") || "movies";
    if (type !== "movies" && type !== "series") throw new ApiError(400, "Choose movies or series for the rating queue.");
    const limit = params.has("limit") ? positiveInteger(Number(params.get("limit")), "limit", 48) : 12;
    const raw = params.get("exclude") || "";
    const parts = raw ? raw.split(",") : [];
    if (raw.length > 10000 || parts.length > 200) throw new ApiError(400, "Too many queue exclusions.");
    const excludeIds = new Set(parts.map((value) => positiveInteger(Number(value), "title ID")));
    const [user, catalog] = await Promise.all([getAppUser(request), currentCatalog()]);
    const [ratings, statuses] = user ? await Promise.all([getUserRatings(user.userId),
      getDb().select().from(ratingQueueStatuses).where(eq(ratingQueueStatuses.userId, user.userId))]) : [[], []];
    return json({ ...selectRatingQueue(type === "movies" ? catalog.movies : catalog.series, ratings, statuses, { limit, excludeIds }), type });
  }, request);
}

export async function POST(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const body = await jsonBody(request);
    const movieId = positiveInteger(body.movieId, "title ID");
    if (body.status !== "skip" && body.status !== "unseen" && body.status !== "clear") throw new ApiError(400, "Choose skip, unseen, or clear.");
    const db = getDb();
    if (body.status === "clear") {
      await db.delete(ratingQueueStatuses).where(and(eq(ratingQueueStatuses.userId, user.userId), eq(ratingQueueStatuses.movieId, movieId)));
    } else {
      if (!(await currentCatalog()).byId.has(movieId)) throw new ApiError(400, "That title is not eligible for the rating queue.");
      const updatedAt = new Date();
      await db.insert(ratingQueueStatuses).values({ userId: user.userId, movieId, status: body.status, updatedAt })
        .onConflictDoUpdate({ target: [ratingQueueStatuses.userId, ratingQueueStatuses.movieId], set: { status: body.status, updatedAt } });
    }
    return json({ ok: true });
  }, request);
}
