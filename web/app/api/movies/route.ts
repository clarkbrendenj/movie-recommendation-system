import { browseMovies } from "../../../lib/recommender.mjs";
import { getModelMetadata } from "../../../lib/server-model";
import { api, ApiError, json, positiveInteger } from "../_shared";

export async function GET(request: Request) {
  return api(async () => {
    const params = new URL(request.url).searchParams;
    const q = params.get("q") || "";
    if (q.length > 200) throw new ApiError(400, "Search is too long.");
    const page = params.has("page") ? positiveInteger(Number(params.get("page")), "page", 10000) : 1;
    const genre = params.get("genre") || "";
    const sort = params.get("sort") || "popular";
    if (!["popular", "title", "year", "rating"].includes(sort)) throw new ApiError(400, "Invalid movie sort.");
    let ids: number[] | undefined;
    if (params.has("ids")) {
      const raw = params.get("ids") || "";
      if (raw.length > 10000) throw new ApiError(400, "Too many movie IDs.");
      ids = raw ? raw.split(",").map((value) => positiveInteger(Number(value), "movie ID")) : [];
    }
    const metadata = await getModelMetadata();
    return json(browseMovies(metadata, { q, genre, page, sort, ids }));
  });
}
