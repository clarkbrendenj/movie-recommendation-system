import { and, eq, gt, lte, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { getDb } from "../db";
import { authRateLimits, authSessions, users } from "../db/schema";
import { hashToken, randomToken, sessionCookie, sessionToken, SESSION_SECONDS } from "./auth-crypto.mjs";

export type AppUser = { id: string; userId: string; username: string; displayName: string; friendCode: string };

export function publicUser(row: { id: string; username: string; displayName: string; friendCode: string }): AppUser {
  return { id: row.id, userId: row.id, username: row.username, displayName: row.displayName, friendCode: row.friendCode };
}

export async function getAppUser(request?: Request): Promise<AppUser | null> {
  const requestHeaders = request?.headers || await headers();
  const token = sessionToken(requestHeaders.get("cookie"));
  if (!token) return null;
  const rows = await getDb().select({ id: users.id, username: users.username, displayName: users.displayName, friendCode: users.friendCode })
    .from(authSessions).innerJoin(users, eq(authSessions.userId, users.id))
    .where(and(eq(authSessions.tokenHash, await hashToken(token)), gt(authSessions.expiresAt, new Date()))).limit(1);
  return rows[0] ? publicUser(rows[0]) : null;
}

export async function createSession(userId: string, request: Request) {
  const token = randomToken();
  const now = new Date();
  const db = getDb();
  await db.delete(authSessions).where(lte(authSessions.expiresAt, now));
  await db.insert(authSessions).values({ tokenHash: await hashToken(token), userId, createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000) });
  return sessionCookie(token, request.url);
}

export async function removeSession(request: Request) {
  const token = sessionToken(request.headers.get("cookie"));
  if (token) await getDb().delete(authSessions).where(eq(authSessions.tokenHash, await hashToken(token)));
  return sessionCookie("", request.url, true);
}

/** Persisted fixed windows; atomic increments also hold across Worker instances. */
export async function consumeAuthBudget(request: Request, action: "login" | "register", username = "") {
  // Cloudflare supplies CF-Connecting-IP. The shared unknown bucket still limits
  // requests on local/direct hosts; client-supplied user identity is never used.
  const address = (request.headers.get("cf-connecting-ip") || "unknown").slice(0, 100);
  const limits = action === "login"
    ? [{ key: `login:account:${username}`, maximum: 10, window: 15 * 60_000 }, { key: `login:source:${address}`, maximum: 60, window: 15 * 60_000 }]
    : [{ key: `register:source:${address}`, maximum: 10, window: 60 * 60_000 }];
  for (const limit of limits) {
    const keyHash = await hashToken(limit.key);
    const now = Date.now(), cutoff = now - limit.window;
    const values = await getDb().insert(authRateLimits).values({ keyHash, attempts: 1, windowStartedAt: now })
      .onConflictDoUpdate({ target: authRateLimits.keyHash, set: {
        attempts: sql`CASE WHEN ${authRateLimits.windowStartedAt} <= ${cutoff} THEN 1 ELSE ${authRateLimits.attempts} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${authRateLimits.windowStartedAt} <= ${cutoff} THEN ${now} ELSE ${authRateLimits.windowStartedAt} END`,
      } }).returning({ attempts: authRateLimits.attempts });
    if (values[0].attempts > limit.maximum) return false;
  }
  return true;
}
