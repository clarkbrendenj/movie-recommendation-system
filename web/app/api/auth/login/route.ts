import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { users } from "../../../../db/schema";
import { consumeAuthBudget, createSession, publicUser } from "../../../../lib/auth";
import { DUMMY_PASSWORD_DIGEST, normalizeUsername, validPassword, verifyPassword } from "../../../../lib/auth-crypto.mjs";
import { api, ApiError, json, jsonBody, sameOrigin } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const body = await jsonBody(request);
    const username = normalizeUsername(body.username);
    if (!await consumeAuthBudget(request, "login", username || "invalid")) {
      throw new ApiError(429, "Too many sign-in attempts. Please try again later.");
    }
    if (!username || !validPassword(body.password)) throw new ApiError(401, "Invalid username or password.");
    const found = await getDb().select().from(users).where(eq(users.username, username)).limit(1);
    const user = found[0];
    const valid = await verifyPassword(body.password as string, user?.passwordDigest || DUMMY_PASSWORD_DIGEST);
    if (!user || !valid) throw new ApiError(401, "Invalid username or password.");
    const response = json({ user: publicUser(user) });
    response.headers.set("Set-Cookie", await createSession(user.id, request));
    return response;
  }, request);
}
