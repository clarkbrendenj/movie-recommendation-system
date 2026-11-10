/** Catalog identity and browsing helpers; recommendation scores stay per model. */

/** @typedef {{version:number,featureItemCount:number,candidateCount:number,excludedItems:Array<{movieId:number,imdbId:string,titleType:string}>}} MovieUnitOverlay */

/** @type {WeakMap<MovieUnitOverlay, Map<number, string>>} */
const unitIndices = new WeakMap();

/** @param {MovieUnitOverlay} overlay */
function unitIndex(overlay) {
  let index = unitIndices.get(overlay);
  if (!index) {
    index = new Map(overlay.excludedItems.map((item) => [item.movieId, item.titleType]));
    unitIndices.set(overlay, index);
  }
  return index;
}

/** @template {{movieId:number}} T @param {T} movie @param {MovieUnitOverlay} [overlay] */
export function movieCard(movie, overlay) {
  const legacyUnit = overlay ? unitIndex(overlay).get(movie.movieId) : undefined;
  return { ...movie, mediaType: legacyUnit ? "other" : "movie", source: "movielens", sourceId: `ml:${movie.movieId}`,
    ...(legacyUnit ? { legacyUnit } : {}) };
}

/** @param {{itemCount:number,movies:Array<{movieId:number}>}} metadata @param {MovieUnitOverlay} overlay */
export function movieCandidateIds(metadata, overlay) {
  if (overlay.version !== 1 || overlay.featureItemCount !== metadata.itemCount) throw new Error("Movie unit overlay does not match the frozen model.");
  const sourceIds = new Set(metadata.movies.map((item) => item.movieId));
  const excluded = unitIndex(overlay);
  if (excluded.size !== overlay.excludedItems.length || overlay.excludedItems.some((item) => !sourceIds.has(item.movieId)
    || !["tvSeries", "tvMiniSeries", "tvEpisode"].includes(item.titleType))) {
    throw new Error("Invalid movie unit exclusions.");
  }
  const eligible = new Set(metadata.movies.filter((item) => !excluded.has(item.movieId)).map((item) => item.movieId));
  if (eligible.size !== overlay.candidateCount) throw new Error("Movie unit candidate count is inconsistent.");
  return eligible;
}

/** @param {{items:Array<{movieId:number,mediaType:string,eligible:boolean,candidate:boolean}>}} metadata @param {number} movieId */
export function isRateableSeries(metadata, movieId) {
  return metadata.items.some((item) => item.movieId === movieId && item.mediaType === "series"
    && item.eligible === true && item.candidate === true);
}

/** Fail on collisions even in hidden context rows; titles never identify items.
 * @param {{movies:Array<{movieId:number}>}} movies
 * @param {{items:Array<{movieId:number}>}} series
 */
export function assertDistinctCatalogIds(movies, series) {
  const seen = new Set();
  for (const item of [...movies.movies, ...series.items]) {
    if (!Number.isSafeInteger(item.movieId) || item.movieId < 1 || seen.has(item.movieId)) {
      throw new Error("Duplicate or invalid ID across media catalogs.");
    }
    seen.add(item.movieId);
  }
}

/** @param {string} value */
function searchText(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** @param {Array<{genres:string[]}>} items */
export function catalogGenres(items) {
  return [...new Set(items.flatMap((item) => item.genres))].sort((a, b) => a.localeCompare(b, "en"));
}

/** Browse the complete two-source catalog before taking a page, never two
 * already-truncated recommendation lists.
 * @param {import("./recommender.mjs").ModelMetadata} movieMetadata
 * @param {import("./tv-recommender.mjs").TvMetadata} tvMetadata
 * @param {{q?:string,genre?:string,page?:number,sort?:string,ids?:number[]}} options
 * @param {MovieUnitOverlay} [overlay]
 */
export function browseCombined(movieMetadata, tvMetadata, options = {}, overlay) {
  assertDistinctCatalogIds(movieMetadata, tvMetadata);
  const eligible = overlay ? movieCandidateIds(movieMetadata, overlay) : null;
  const requestedIds = options.ids ? new Set(options.ids) : null;
  const visible = [
    ...movieMetadata.movies.filter((item) => !eligible || eligible.has(item.movieId) || requestedIds?.has(item.movieId))
      .map((item) => movieCard(item, overlay)),
    ...tvMetadata.items.filter((item) => item.mediaType === "series" && item.eligible === true && item.candidate === true),
  ];
  const query = searchText(options.q || "").split(" ").filter(Boolean);
  const ids = options.ids ? new Set(options.ids) : null;
  const items = visible.filter((item) => {
    if (ids && !ids.has(item.movieId)) return false;
    if (options.genre && !item.genres.includes(options.genre)) return false;
    const title = searchText(`${item.title} ${"alternateTitle" in item ? item.alternateTitle : ""}`);
    return query.every((term) => title.includes(term));
  });
  items.sort((a, b) => {
    if (options.sort === "title") return a.title.localeCompare(b.title, "en") || a.movieId - b.movieId;
    if (options.sort === "year") return (b.year || 0) - (a.year || 0) || b.popularity - a.popularity || a.movieId - b.movieId;
    if (options.sort === "rating") return (b.imdbRating || 0) - (a.imdbRating || 0) || (b.imdbVotes || 0) - (a.imdbVotes || 0) || a.movieId - b.movieId;
    return b.popularity - a.popularity || (b.imdbAdjustment || 0) - (a.imdbAdjustment || 0) || a.movieId - b.movieId;
  });
  const page = Math.max(1, Math.trunc(options.page || 1));
  const pageSize = 24;
  return { movies: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, genres: catalogGenres(visible) };
}
