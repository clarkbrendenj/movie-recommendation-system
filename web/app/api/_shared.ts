import { eq } from "drizzle-orm";
import { getChatGPTUser } from "../chatgpt-auth";
import { getDb } from "../../db";
import { ratings } from "../../db/schema";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}

export async function api(handler: () => Promise<Response>) {
  try { return await handler(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error("Afterglow API error", error);
    return json({ error: "We could not complete that request. Please try again." }, 500);
  }
}

export async function requireUser() {
  const user = await getChatGPTUser();
  if (!user) throw new ApiError(401, "Sign in to save your ratings.");
  return user;
}

export async function getUserRatings(userId: string) {
  return getDb().select({ movieId: ratings.movieId, rating: ratings.rating })
    .from(ratings).where(eq(ratings.userId, userId));
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ApiError(403, "This action must come from this app.");
  }
}

export function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ApiError(400, `Invalid ${name}.`);
  }
  return value;
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "Send a JSON request.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "The request body is missing.");
  const decoder = new TextDecoder();
  let text = "";
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 4096) { await reader.cancel(); throw new ApiError(413, "The request is too large."); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new ApiError(400, "The request contains invalid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Send a JSON object.");
  return body as Record<string, unknown>;
}
