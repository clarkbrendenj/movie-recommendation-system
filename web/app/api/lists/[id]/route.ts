import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { listItems, listMembers, lists } from "../../../../db/schema";
import { accessibleList, assertConfirmedFriends, describeList, getSavedItems, listId, listName, memberIds, requireListManager } from "../../../../lib/server-lists";
import { api, ApiError, json, jsonBody, requireUser, sameOrigin } from "../../_shared";

type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  return api(async () => {
    const user = await requireUser(request);
    const row = await accessibleList(listId((await context.params).id), user.userId);
    return json({ list: await describeList(row, user.userId), items: await getSavedItems(row.id) });
  }, request);
}

export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const row = await accessibleList(listId((await context.params).id), user.userId);
    const descriptor = await requireListManager(row, user.userId);
    const body = await jsonBody(request);
    if (body.kind !== undefined || body.mediaType !== undefined) throw new ApiError(400, "The list's type is fixed. Create another list for a different type.");
    const name = body.name === undefined ? row.name : listName(body.name);
    const now = new Date();
    const db = getDb();
    if (body.memberIds !== undefined) {
      const selected = memberIds(body.memberIds, user.userId);
      if (row.kind === "watchlist" && selected.length) throw new ApiError(400, "Watchlists are private.");
      const existing = new Set(descriptor.members.map((member) => member.userId));
      await assertConfirmedFriends(user.userId, selected.filter((id) => !existing.has(id)));
      await db.batch([db.delete(listMembers).where(eq(listMembers.listId, row.id)),
        db.insert(listMembers).values([{ listId: row.id, userId: user.userId, role: "owner", joinedAt: now },
          ...selected.map((userId) => ({ listId: row.id, userId, role: "member" as const, joinedAt: now }))]),
        db.update(lists).set({ name, updatedAt: now }).where(eq(lists.id, row.id))]);
    } else {
      await db.update(lists).set({ name, updatedAt: now }).where(eq(lists.id, row.id));
    }
    return json({ list: await describeList({ ...row, name, updatedAt: now }, user.userId) });
  }, request);
}

export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const row = await accessibleList(listId((await context.params).id), user.userId);
    const db = getDb();
    if (row.ownerId === user.userId) {
      await db.batch([db.delete(listItems).where(eq(listItems.listId, row.id)), db.delete(listMembers).where(eq(listMembers.listId, row.id)),
        db.delete(lists).where(eq(lists.id, row.id))]);
    } else {
      await db.batch([db.delete(listMembers).where(and(eq(listMembers.listId, row.id), eq(listMembers.userId, user.userId))),
        db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, row.id))]);
    }
    return json({ ok: true });
  }, request);
}
