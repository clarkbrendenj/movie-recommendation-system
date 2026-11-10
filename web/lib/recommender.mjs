/**
 * Sparse inference for the frozen notebook 10 model. No API or user-training
 * matrix is needed at runtime: new users are represented by their liked films.
 * Scores are affinities, not probabilities or predicted star ratings.
 */

/** @typedef {{movieId:number,title:string,genres:string[],year:number|null,popularity:number,imdbRating:number|null,imdbVotes:number|null,imdbAdjustment:number}} Movie */
/** @typedef {{file:string,dtype:string,bytes?:number,sha256?:string}} BinaryDescriptor */
/** @typedef {{name:string,rows:number,columns:number,nnz:number,indptr:BinaryDescriptor,indices:BinaryDescriptor,data:BinaryDescriptor}} GroupDescriptor */
/** @typedef {{version:number,model:string,itemCount:number,weights:{plot:number,credits:number,imdb:number},creditRoles:string[],movies:Movie[],groups:GroupDescriptor[]}} ModelMetadata */
/** @typedef {{name:string,rows:number,columns:number,indptr:Uint32Array,indices:Uint16Array|Uint32Array,data:Float32Array}} SparseGroup */
/** @typedef {{movieId:number,rating:number}} Rating */
/** @typedef {{metadata:ModelMetadata,groups:Map<string,SparseGroup>,itemIndex:Map<number,number>}} Model */

/** @param {number} value */
export function isValidRating(value) {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0.5 && value <= 5 && Math.abs(value * 20 - Math.round(value * 20)) < 1e-8;
}

/** @param {ModelMetadata} metadata @param {SparseGroup[]} groups @returns {Model} */
export function createModel(metadata, groups) {
  if (metadata.version !== 1 || metadata.itemCount !== metadata.movies.length) {
    throw new Error("Unsupported or incomplete model metadata.");
  }
  const itemIndex = new Map(metadata.movies.map((movie, index) => [movie.movieId, index]));
  if (itemIndex.size !== metadata.itemCount) throw new Error("Duplicate movie IDs in model.");
  const loaded = new Map();
  for (const group of groups) {
    if (group.rows !== metadata.itemCount || group.indptr.length !== group.rows + 1
      || group.indices.length !== group.data.length
      || group.indptr[group.rows] !== group.data.length) {
      throw new Error(`Invalid sparse matrix: ${group.name}.`);
    }
    for (let row = 0; row < group.rows; row++) {
      if (group.indptr[row] > group.indptr[row + 1]) throw new Error("Invalid sparse row pointer.");
    }
    for (let index = 0; index < group.indices.length; index++) {
      if (group.indices[index] >= group.columns || !Number.isFinite(group.data[index]) || group.data[index] < 0) {
        throw new Error("Invalid sparse feature value.");
      }
    }
    loaded.set(group.name, group);
  }
  for (const required of ["cf", "plots", ...metadata.creditRoles]) {
    if (!loaded.has(required)) throw new Error(`Missing model features: ${required}.`);
  }
  return { metadata, groups: loaded, itemIndex };
}

/** @param {SparseGroup} group @param {number[]} likedRows */
function featureScores(group, likedRows) {
  const profile = new Float64Array(group.columns);
  let usableLikes = 0;
  for (const row of likedRows) {
    const start = group.indptr[row];
    const end = group.indptr[row + 1];
    if (start === end) continue;
    usableLikes++;
    for (let index = start; index < end; index++) profile[group.indices[index]] += group.data[index];
  }
  const scores = new Float64Array(group.rows);
  if (usableLikes === 0) return scores;
  for (let row = 0; row < group.rows; row++) {
    let value = 0;
    for (let index = group.indptr[row]; index < group.indptr[row + 1]; index++) {
      value += profile[group.indices[index]] * group.data[index];
    }
    scores[row] = value / usableLikes;
  }
  return scores;
}

/** @param {Float64Array} scores @param {Set<number>} seen */
function scaleUnseen(scores, seen) {
  let maximum = 0;
  for (let index = 0; index < scores.length; index++) {
    if (!seen.has(index) && scores[index] > maximum) maximum = scores[index];
  }
  const scaled = new Float64Array(scores.length);
  if (maximum > 0) for (let index = 0; index < scores.length; index++) scaled[index] = scores[index] / maximum;
  return scaled;
}

/** @param {Float64Array} base @param {Float64Array} content @param {number} weight @param {Set<number>} seen */
function blendWithFallback(base, content, weight, seen) {
  const normalizedBase = scaleUnseen(base, seen);
  const normalizedContent = scaleUnseen(content, seen);
  let hasContent = false;
  for (let index = 0; index < content.length; index++) {
    if (!seen.has(index) && normalizedContent[index] > 0) { hasContent = true; break; }
  }
  if (!hasContent) return normalizedBase;
  for (let index = 0; index < base.length; index++) {
    normalizedBase[index] = (1 - weight) * normalizedBase[index] + weight * normalizedContent[index];
  }
  return normalizedBase;
}

/** Ignore retired IDs and malformed entries; the last valid rating wins. @param {Model} model @param {Rating[]} ratings */
function userProfile(model, ratings) {
  const values = new Map();
  for (const entry of ratings) {
    if (entry && isValidRating(entry.rating) && model.itemIndex.has(entry.movieId)) {
      values.set(model.itemIndex.get(entry.movieId), entry.rating);
    }
  }
  const seen = new Set(values.keys());
  const likedRows = [...values.entries()].filter(([, rating]) => rating >= 4).map(([row]) => row);
  return { seen, likedRows };
}

/** @param {Movie} movie @param {Movie[]} likedMovies @param {boolean} personalized */
function recommendationReason(movie, likedMovies, personalized) {
  if (!personalized) return "A popular starting point. Rate a few favorites to make this yours.";
  const shared = movie.genres.filter((genre) => likedMovies.some((liked) => liked.genres.includes(genre)));
  if (shared.length) return `Shares ${shared.slice(0, 2).join(" and ").toLowerCase()} with films you rated highly.`;
  return "A pick from your taste profile, with plot, cast, and IMDb signals.";
}

/**
 * The original model uses ratings >=4 as likes. Lower ratings exclude a film
 * from future recommendations; they do not contribute a negative preference.
 * Full candidate ranking for shared-list aggregation.
 * @param {Model} model @param {Rating[]} ratings
 * @param {ReadonlySet<number>} [eligibleIds] Optional output-only candidate filter;
 * profile features and unseen normalization retain the complete frozen catalog.
 */
export function rankMovies(model, ratings, eligibleIds) {
  const { metadata } = model;
  const { seen, likedRows } = userProfile(model, ratings);
  const personalized = likedRows.length > 0;
  let scores = new Float64Array(metadata.itemCount);
  if (personalized) {
    const cf = featureScores(/** @type {SparseGroup} */ (model.groups.get("cf")), likedRows);
    const plots = featureScores(/** @type {SparseGroup} */ (model.groups.get("plots")), likedRows);
    const plotBlend = blendWithFallback(cf, plots, metadata.weights.plot, seen);
    const credits = new Float64Array(metadata.itemCount);
    for (const role of metadata.creditRoles) {
      const values = scaleUnseen(featureScores(/** @type {SparseGroup} */ (model.groups.get(role)), likedRows), seen);
      for (let index = 0; index < values.length; index++) credits[index] += values[index] / metadata.creditRoles.length;
    }
    scores = scaleUnseen(blendWithFallback(plotBlend, credits, metadata.weights.credits, seen), seen);
    for (let index = 0; index < scores.length; index++) {
      scores[index] += metadata.weights.imdb * metadata.movies[index].imdbAdjustment;
    }
  }
  const indices = metadata.movies.map((_, index) => index).filter((index) => !seen.has(index)
    && (!eligibleIds || eligibleIds.has(metadata.movies[index].movieId)));
  indices.sort((left, right) => {
    const a = metadata.movies[left];
    const b = metadata.movies[right];
    return (personalized ? scores[right] - scores[left] : 0)
      || b.popularity - a.popularity
      || (personalized ? 0 : b.imdbAdjustment - a.imdbAdjustment)
      || a.movieId - b.movieId;
  });
  const likedMovies = likedRows.map((index) => metadata.movies[index]);
  return {
    movies: indices.map((index) => ({
      ...metadata.movies[index],
      score: scores[index],
      reason: recommendationReason(metadata.movies[index], likedMovies, personalized),
    })),
    mode: personalized ? "personalized" : "starter",
    likes: likedRows.length,
    ratingsCount: seen.size,
  };
}

/** Return a bounded personal shelf, preserving the frozen model's ranking.
 * @param {Model} model @param {Rating[]} ratings @param {number} [limit]
 * @param {ReadonlySet<number>} [eligibleIds]
 */
export function recommend(model, ratings, limit = 12, eligibleIds) {
  const result = rankMovies(model, ratings, eligibleIds);
  return { ...result, movies: result.movies.slice(0, Math.max(0, Math.min(48, Math.trunc(limit)))) };
}

/** @param {string} value */
function searchText(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** @param {ModelMetadata} metadata @param {{q?:string,genre?:string,page?:number,sort?:string,ids?:number[]}} options
 * @param {ReadonlySet<number>} [eligibleIds] */
export function browseMovies(metadata, options = {}, eligibleIds) {
  const query = searchText(options.q || "").split(" ").filter(Boolean);
  const genre = options.genre || "";
  const ids = options.ids ? new Set(options.ids) : null;
  const movies = metadata.movies.filter((movie) => {
    if (eligibleIds && !eligibleIds.has(movie.movieId)) return false;
    if (ids && !ids.has(movie.movieId)) return false;
    if (genre && !movie.genres.includes(genre)) return false;
    if (!query.length) return true;
    const title = searchText(movie.title);
    return query.every((term) => title.includes(term));
  });
  const sort = options.sort || "popular";
  movies.sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title, "en") || a.movieId - b.movieId;
    if (sort === "year") return (b.year || 0) - (a.year || 0) || b.popularity - a.popularity || a.movieId - b.movieId;
    if (sort === "rating") return (b.imdbRating || 0) - (a.imdbRating || 0) || (b.imdbVotes || 0) - (a.imdbVotes || 0) || a.movieId - b.movieId;
    return b.popularity - a.popularity || b.imdbAdjustment - a.imdbAdjustment || a.movieId - b.movieId;
  });
  const page = Math.max(1, Math.trunc(options.page || 1));
  const pageSize = 24;
  return { movies: movies.slice((page - 1) * pageSize, page * pageSize), total: movies.length, page, pageSize };
}
