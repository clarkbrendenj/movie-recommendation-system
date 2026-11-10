import { and, count, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { friends, users } from "../../../db/schema";
import { friendActionAllowed, friendshipPairKey } from "../../../lib/collaboration-policy.mjs";
import { api, ApiError, json, jsonBody, requireUser, sameOrigin } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return api(async () => {
    const user = await requireUser(request);
    const db = getDb();
    const rows = await db.select().from(friends).where(or(eq(friends.requesterId, user.userId), eq(friends.recipientId, user.userId)));
    const ids = [...new Set(rows.map((row) => row.requesterId === user.userId ? row.recipientId : row.requesterId))];
    const profiles = ids.length ? await db.select({ userId: users.id, username: users.username, displayName: users.displayName })
      .from(users).where(inArray(users.id, ids)) : [];
    const byId = new Map(profiles.map((profile) => [profile.userId, profile]));
    type Profile = typeof profiles[number];
    const accepted: Array<Profile & { requestId: string }> = [];
    const incoming: Array<{ requestId: string; user: Profile }> = [];
    const outgoing: Array<{ requestId: string; user: Profile }> = [];
    for (const row of rows) {
      const other = byId.get(row.requesterId === user.userId ? row.recipientId : row.requesterId);
      if (!other) continue;
      if (row.status === "accepted") accepted.push({ requestId: row.id, ...other });
      else (row.recipientId === user.userId ? incoming : outgoing).push({ requestId: row.id, user: other });
    }
    return json({ friends: accepted, incoming, outgoing });
  }, request);
}

export async function POST(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const body = await jsonBody(request);
    const code = typeof body.friendCode === "string" ? body.friendCode.trim().toUpperCase() : "";
    if (!/^[A-Z0-9-]{8,64}$/.test(code)) throw new ApiError(400, "Enter your friend's complete friend code.");
    const db = getDb();
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.friendCode, code)).limit(1);
    if (!target) throw new ApiError(404, "No account matches that friend code.");
    if (target.id === user.userId) throw new ApiError(400, "Choose another person's friend code.");
    const pairKey = friendshipPairKey(user.userId, target.id);
    const [existing] = await db.select().from(friends).where(eq(friends.pairKey, pairKey)).limit(1);
    if (existing?.status === "accepted") throw new ApiError(409, "You are already friends.");
    if (existing) {
      if (existing.requesterId !== user.userId) throw new ApiError(409, "This person already sent you a request. Accept it from your requests.");
      return json({ requestId: existing.id, status: "pending" });
    }
    const [{ total }] = await db.select({ total: count() }).from(friends).where(and(eq(friends.requesterId, user.userId), eq(friends.status, "pending")));
    if (total >= 30) throw new ApiError(429, "Resolve some pending friend requests before sending another.");
    const now = new Date();
    await db.insert(friends).values({ id: crypto.randomUUID(), requesterId: user.userId, recipientId: target.id,
      pairKey, status: "pending", createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [created] = await db.select().from(friends).where(eq(friends.pairKey, pairKey)).limit(1);
    if (!created || created.requesterId !== user.userId) throw new ApiError(409, "A request from this person is already pending.");
    return json({ requestId: created.id, status: created.status });
  }, request);
}

export async function PATCH(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request);
    const body = await jsonBody(request);
    if (typeof body.requestId !== "string" || body.requestId.length > 100 || typeof body.action !== "string"
      || !["accept", "decline", "cancel", "remove"].includes(body.action)) throw new ApiError(400, "Choose a valid friend request action.");
    const db = getDb();
    const [row] = await db.select().from(friends).where(eq(friends.id, body.requestId)).limit(1);
    if (!row || !friendActionAllowed(row, user.userId, body.action)) throw new ApiError(404, "Friend request not found.");
    if (body.action === "accept") {
      await db.update(friends).set({ status: "accepted", updatedAt: new Date() }).where(and(eq(friends.id, row.id), eq(friends.status, "pending")));
    } else {
      await db.delete(friends).where(eq(friends.id, row.id));
    }
    return json({ ok: true });
  }, request);
}
