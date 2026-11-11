import { getAppUser } from "../../../lib/auth";
import { getModelMetadata, getTvModelMetadata, getMovieUnitOverlay } from "../../../lib/server-model";
import { DISPLAY_RATING_SCALE, modelToDisplay } from "../../../lib/rating-scale.mjs";
import { getUserTitleStates } from "../../../lib/server-title-state";
import { api, getUserRatings, json } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return api(async () => {
    const [user, metadata, tvMetadata, overlay] = await Promise.all([getAppUser(request), getModelMetadata(), getTvModelMetadata(), getMovieUnitOverlay()]);
    const [ratings, titleStates] = user ? await Promise.all([getUserRatings(user.userId), getUserTitleStates(user.userId)]) : [[], []];
    return json({
      user,
      ratingScale: DISPLAY_RATING_SCALE,
      ratings: ratings.map((entry) => ({ ...entry, rating: modelToDisplay(entry.rating) })),
      titleStates,
      model: { name: metadata.model, candidateCount: overlay.candidateCount },
      models: {
        movies: { name: metadata.model, candidateCount: overlay.candidateCount, featureCount: metadata.itemCount,
          dataset: "MovieLens + IMDb", benchmarkRecallAt10: 0.122573, benchmarkCandidateCount: metadata.itemCount,
          benchmarkScope: "Original unfiltered catalog; film-only view has not been re-benchmarked." },
        series: { name: tvMetadata.model, candidateCount: tvMetadata.candidateCount, dataset: tvMetadata.benchmark.dataset, benchmarkRecallAt10: tvMetadata.benchmark.recallAt10 },
      },
    });
  }, request);
}
