import { getChatGPTUser } from "../../chatgpt-auth";
import { getModelMetadata } from "../../../lib/server-model";
import { DISPLAY_RATING_SCALE, modelToDisplay } from "../../../lib/rating-scale.mjs";
import { api, getUserRatings, json } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  return api(async () => {
    const [user, metadata] = await Promise.all([getChatGPTUser(), getModelMetadata()]);
    const ratings = user ? await getUserRatings(user.userId) : [];
    return json({
      user: user ? { id: user.userId, displayName: user.displayName } : null,
      ratingScale: DISPLAY_RATING_SCALE,
      ratings: ratings.map((entry) => ({ ...entry, rating: modelToDisplay(entry.rating) })),
      model: { name: metadata.model, candidateCount: metadata.itemCount },
    });
  });
}
