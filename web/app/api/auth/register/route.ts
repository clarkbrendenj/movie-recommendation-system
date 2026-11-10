import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { users } from "../../../../db/schema";
import { consumeAuthBudget, createSession, publicUser } from "../../../../lib/auth";
import { hashPassword, normalizeUsername, randomToken, validPassword } from "../../../../lib/auth-crypto.mjs";
import { api, ApiError, json, jsonBody, sameOrigin } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const body = await jsonBody(request);
    const username = normalizeUsername(body.username);
    if (!username) throw new ApiError(400, "Use 3–32 letters, numbers or underscores for your username.");
    if (!validPassword(body.password)) throw new ApiError(400, "Choose a password containing 10–128 characters.");
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : username;
    if (!displayName || displayName.length > 60) throw new ApiError(400, "Choose a display name from 1 to 60 characters.");
    if (!await consumeAuthBudget(request, "register")) throw new ApiError(429, "Too many account attempts. Please try again later.");
    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1)).length) {
      throw new ApiError(409, "That username is unavailable. Please choose another.");
    }
    const user = { id: `usr_${crypto.randomUUID().replaceAll("-", "")}`, username, displayName,
      friendCode: `AG-${randomToken(8).toUpperCase()}` };
    const digest = await hashPassword(body.password as string);
    // A concurrent registration can claim the name after the friendly precheck.
    // Ignore only the username conflict; never overwrite an existing account.
    const created = await db.insert(users).values({ ...user, passwordDigest: digest, createdAt: new Date() })
      .onConflictDoNothing({ target: users.username }).returning({ id: users.id });
    if (!created.length) throw new ApiError(409, "That username is unavailable. Please choose another.");
    const response = json({ user: publicUser(user) }, 201);
    response.headers.set("Set-Cookie", await createSession(user.id, request));
    return response;
  }, request);
}
