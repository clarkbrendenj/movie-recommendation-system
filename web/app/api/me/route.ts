import { getChatGPTUser } from "../../chatgpt-auth";
import { getModelMetadata } from "../../../lib/server-model";
import { api, getUserRatings, json } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  return api(async () => {
    const [user, metadata] = await Promise.all([getChatGPTUser(), getModelMetadata()]);
    const ratings = user ? await getUserRatings(user.userId) : [];
    return json({
      user: user ? { id: user.userId, displayName: user.displayName } : null,
      ratings,
      model: { name: metadata.model, candidateCount: metadata.itemCount },
    });
  });
}
