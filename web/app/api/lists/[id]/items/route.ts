import { and, count, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { listItems, lists } from "../../../../../db/schema";
import { accessibleList, currentCatalog, itemFitsList, listId } from "../../../../../lib/server-lists";
import { api, ApiError, json, jsonBody, positiveInteger, requireUser, sameOrigin } from "../../../_shared";

type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: Context) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const row = await accessibleList(listId((await context.params).id), user.userId);
    const movieId = positiveInteger((await jsonBody(request)).movieId, "title ID");
    const item = (await currentCatalog()).byId.get(movieId);
    if (!item || !itemFitsList(item, row)) throw new ApiError(400, "That title is not eligible for this list's type.");
    const db = getDb();
    const [{ total }] = await db.select({ total: count() }).from(listItems).where(eq(listItems.listId, row.id));
    if (total >= 500) throw new ApiError(400, "A list can hold up to 500 titles.");
    const now = new Date();
    await db.batch([db.insert(listItems).values({ listId: row.id, movieId, addedBy: user.userId, createdAt: now }).onConflictDoNothing(),
      db.update(lists).set({ updatedAt: now }).where(eq(lists.id, row.id))]);
    return json({ ok: true });
  }, request);
}

export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const row = await accessibleList(listId((await context.params).id), user.userId);
    const movieId = positiveInteger(Number(new URL(request.url).searchParams.get("movieId")), "title ID");
    const db = getDb();
    await db.batch([db.delete(listItems).where(and(eq(listItems.listId, row.id), eq(listItems.movieId, movieId))),
      db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, row.id))]);
    return json({ ok: true });
  }, request);
}
