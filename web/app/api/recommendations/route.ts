import { getChatGPTUser } from "../../chatgpt-auth";
import { recommend } from "../../../lib/recommender.mjs";
import { getModel } from "../../../lib/server-model";
import { api, getUserRatings, json, positiveInteger } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return api(async () => {
    const params = new URL(request.url).searchParams;
    const limit = params.has("limit") ? positiveInteger(Number(params.get("limit")), "limit", 48) : 12;
    const [user, model] = await Promise.all([getChatGPTUser(), getModel()]);
    const ratings = user ? await getUserRatings(user.userId) : [];
    return json(recommend(model, ratings, limit));
  });
}
