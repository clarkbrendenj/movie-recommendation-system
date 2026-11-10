import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { listMembers, lists } from "../../../db/schema";
import { assertConfirmedFriends, describeList, describeLists, listName, memberIds } from "../../../lib/server-lists";
import { api, ApiError, json, jsonBody, requireUser, sameOrigin } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return api(async () => {
    const user = await requireUser(request);
    const kind = new URL(request.url).searchParams.get("kind");
    if (kind && !["watchlist", "together"].includes(kind)) throw new ApiError(400, "Choose watchlist or together.");
    const rows = await getDb().select({ list: lists }).from(lists).innerJoin(listMembers,
      and(eq(listMembers.listId, lists.id), eq(listMembers.userId, user.userId)))
      .where(kind ? eq(lists.kind, kind === "together" ? "recommendation" : "watchlist") : undefined).orderBy(desc(lists.updatedAt));
    return json({ lists: await describeLists(rows.map((row) => row.list), user.userId) });
  }, request);
}

export async function POST(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const body = await jsonBody(request);
    const name = listName(body.name);
    if (body.kind !== "watchlist" && body.kind !== "together") throw new ApiError(400, "Choose watchlist or together.");
    if (body.mediaType !== "movies" && body.mediaType !== "series" && body.mediaType !== "both") throw new ApiError(400, "Choose movies, series, or both.");
    const selected = memberIds(body.memberIds, user.userId);
    if (body.kind === "watchlist" && selected.length) throw new ApiError(400, "Watchlists are private. Use Together for friends.");
    if (body.kind === "together" && !selected.length) throw new ApiError(400, "Choose at least one confirmed friend.");
    await assertConfirmedFriends(user.userId, selected);
    const db = getDb();
    const [{ total }] = await db.select({ total: count() }).from(lists).where(eq(lists.ownerId, user.userId));
    if (total >= 100) throw new ApiError(400, "You have reached the limit of 100 lists.");
    const now = new Date();
    const row: typeof lists.$inferInsert = { id: crypto.randomUUID(), ownerId: user.userId, name,
      kind: body.kind === "together" ? "recommendation" : "watchlist", mediaType: body.mediaType, createdAt: now, updatedAt: now };
    await db.batch([db.insert(lists).values(row), db.insert(listMembers).values([
      { listId: row.id, userId: user.userId, role: "owner", joinedAt: now },
      ...selected.map((userId) => ({ listId: row.id, userId, role: "member" as const, joinedAt: now })),
    ])]);
    return json({ list: await describeList(row as typeof lists.$inferSelect, user.userId) });
  }, request);
}
