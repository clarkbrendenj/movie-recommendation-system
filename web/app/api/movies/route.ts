import { browseMovies } from "../../../lib/recommender.mjs";
import { browseSeries } from "../../../lib/tv-recommender.mjs";
import { browseCombined, catalogGenres, movieCard, movieCandidateIds } from "../../../lib/media-catalog.mjs";
import { getModelMetadata, getTvModelMetadata, getMovieUnitOverlay } from "../../../lib/server-model";
import { api, ApiError, json, positiveInteger } from "../_shared";

export async function GET(request: Request) {
  return api(async () => {
    const params = new URL(request.url).searchParams;
    const type = params.get("type") || "movies";
    if (!["movies", "series", "both"].includes(type)) throw new ApiError(400, "Choose movies, series, or both.");
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
    const options = { q, genre, page, sort, ids };
    if (type === "series") return json({ ...browseSeries(await getTvModelMetadata(), options), type });
    const [metadata, overlay] = await Promise.all([getModelMetadata(), getMovieUnitOverlay()]);
    if (type === "both") return json({ ...browseCombined(metadata, await getTvModelMetadata(), options, overlay), type });
    const eligible = movieCandidateIds(metadata, overlay);
    const result = browseMovies(metadata, options, eligible);
    return json({ ...result, movies: result.movies.map((item) => movieCard(item, overlay)),
      genres: catalogGenres(metadata.movies.filter((item) => eligible.has(item.movieId))), type });
  }, request);
}
