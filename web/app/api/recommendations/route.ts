import { getAppUser } from "../../../lib/auth";
import { recommend } from "../../../lib/recommender.mjs";
import { recommendSeries } from "../../../lib/tv-recommender.mjs";
import { movieCard, movieCandidateIds } from "../../../lib/media-catalog.mjs";
import { getModel, getTvModel, getMovieUnitOverlay } from "../../../lib/server-model";
import { api, ApiError, getUserRatings, json, positiveInteger } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return api(async () => {
    const params = new URL(request.url).searchParams;
    const type = params.get("type") || "movies";
    if (!["movies", "series", "both"].includes(type)) throw new ApiError(400, "Choose movies, series, or both.");
    const limit = params.has("limit") ? positiveInteger(Number(params.get("limit")), "limit", 48) : 12;
    const user = await getAppUser(request);
    const ratings = user ? await getUserRatings(user.userId) : [];
    if (type === "series") {
      const result = recommendSeries(await getTvModel(), ratings, limit);
      return json({ ...result, series: result.movies, sections: { series: result }, type });
    }
    const [model, tvModel, overlay] = await Promise.all([getModel(), type === "both" ? getTvModel() : Promise.resolve(null), getMovieUnitOverlay()]);
    const result = recommend(model, ratings, limit, movieCandidateIds(model.metadata, overlay));
    const movies = { ...result, movies: result.movies.map((item) => movieCard(item, overlay)) };
    if (tvModel) {
      const series = recommendSeries(tvModel, ratings, limit);
      return json({ ...movies, series: series.movies, sections: { movies, series }, type });
    }
    return json({ ...movies, sections: { movies }, type });
  }, request);
}
