/**
 * Sparse inference for the frozen FilmAffinity whole-series shelf winner.
 * Source IDs are namespaced, never guessed from MovieLens IDs or title strings.
 * Scores are ranking affinities, not predicted 1–10 ratings.
 */
import { isValidRating } from "./recommender.mjs";

/** @typedef {{movieId:number,sourceId:string,title:string,alternateTitle:string,genres:string[],year:number|null,popularity:number,quality:number,eligible:boolean,candidate:boolean,mediaType:'movie'|'series',source:'filmaffinity',imdbRating?:number|null,imdbVotes?:number|null,imdbAdjustment?:number}} TvItem */
/** @typedef {{file:string,dtype:string,bytes?:number,sha256?:string}} BinaryDescriptor */
/** @typedef {{name:string,rows:number,columns:number,nnz:number,indptr:BinaryDescriptor,indices:BinaryDescriptor,data:BinaryDescriptor}} GroupDescriptor */
/** @typedef {{version:number,modelkind:string,model:string,itemCount:number,candidateCount:number,items:TvItem[],groups:GroupDescriptor[],weights:{plot:number,metadata:number,quality:number,personal:number},benchmark:{dataset:string,recallAt10:number,users:number,split:string}}} TvMetadata */
/** @typedef {{name:string,rows:number,columns:number,indptr:Uint32Array,indices:Uint16Array|Uint32Array,data:Float32Array}} SparseGroup */
/** @typedef {{movieId:number,rating:number}} Rating */
/** @typedef {{metadata:TvMetadata,groups:Map<string,SparseGroup>,itemIndex:Map<number,number>,candidates:number[]}} TvModel */

export const FILMAFFINITY_ID_NAMESPACE = 1_000_000_000;

/** @param {TvMetadata} metadata @param {SparseGroup[]} groups @returns {TvModel} */
export function createTvModel(metadata, groups) {
  if (metadata.version !== 1 || metadata.modelkind !== "whole_series"
      || metadata.itemCount !== metadata.items?.length || !Array.isArray(metadata.groups)) {
    throw new Error("Unsupported or incomplete TV model metadata.");
  }
  const itemIndex = new Map();
  const candidates = [];
  for (let index = 0; index < metadata.items.length; index++) {
    const item = metadata.items[index];
    const source = /^film([0-9]+)$/.exec(item.sourceId);
    if (!source || !Number.isSafeInteger(item.movieId) || item.movieId !== FILMAFFINITY_ID_NAMESPACE + Number(source[1])
        || itemIndex.has(item.movieId) || item.source !== "filmaffinity"
        || typeof item.eligible !== "boolean" || typeof item.candidate !== "boolean"
        || !Number.isFinite(item.quality) || item.quality < 0 || item.quality > 1
        || !Number.isSafeInteger(item.popularity) || item.popularity < 0) {
      throw new Error("Invalid or overlapping TV source identity.");
    }
    if (item.candidate) {
      if (!item.eligible || item.mediaType !== "series") throw new Error("Only eligible whole-series items may be candidates.");
      candidates.push(index);
    }
    itemIndex.set(item.movieId, index);
  }
  if (metadata.candidateCount !== candidates.length) throw new Error("Incomplete TV candidate catalog.");
  if (![metadata.weights.plot, metadata.weights.metadata, metadata.weights.quality, metadata.weights.personal].every(Number.isFinite)
      || metadata.weights.plot < 0 || metadata.weights.metadata < 0 || metadata.weights.quality < 0
      || metadata.weights.personal < 0 || metadata.weights.personal > 1) {
    throw new Error("Invalid TV model weights.");
  }
  const loaded = new Map();
  for (const group of groups) {
    if (loaded.has(group.name) || group.rows !== metadata.itemCount || !Number.isInteger(group.columns) || group.columns < 1
        || group.indptr.length !== group.rows + 1 || group.indptr[0] !== 0
        || group.indices.length !== group.data.length || group.indptr[group.rows] !== group.data.length) {
      throw new Error(`Invalid sparse TV matrix: ${group.name}.`);
    }
    for (let row = 0; row < group.rows; row++) {
      if (group.indptr[row] > group.indptr[row + 1]) throw new Error("Invalid TV sparse row pointer.");
    }
    for (let index = 0; index < group.indices.length; index++) {
      if (group.indices[index] >= group.columns || !Number.isFinite(group.data[index]) || group.data[index] < 0) {
        throw new Error("Invalid sparse TV feature value.");
      }
    }
    loaded.set(group.name, group);
  }
  for (const required of ["cf", "synopsis", "genres", "cast"]) {
    if (!loaded.has(required)) throw new Error(`Missing TV model features: ${required}.`);
  }
  return { metadata, groups: loaded, itemIndex, candidates };
}

/** @param {SparseGroup} group @param {number[]} liked */
function affinities(group, liked) {
  const profile = new Float64Array(group.columns);
  for (const row of liked) {
    for (let at = group.indptr[row]; at < group.indptr[row + 1]; at++) {
      profile[group.indices[at]] += group.data[at];
    }
  }
  const scores = new Float64Array(group.rows);
  for (let row = 0; row < group.rows; row++) {
    for (let at = group.indptr[row]; at < group.indptr[row + 1]; at++) {
      scores[row] += profile[group.indices[at]] * group.data[at];
    }
  }
  return scores;
}

/** @param {Float64Array} scores @param {Set<number>} seen @param {number[]} [columns] */
function normalized(scores, seen, columns) {
  let maximum = 0;
  if (columns) {
    for (const row of columns) if (!seen.has(row) && scores[row] > maximum) maximum = scores[row];
  } else {
    for (let row = 0; row < scores.length; row++) if (!seen.has(row) && scores[row] > maximum) maximum = scores[row];
  }
  const result = new Float64Array(scores.length);
  if (maximum > 0) {
    for (let row = 0; row < scores.length; row++) if (!seen.has(row)) result[row] = scores[row] / maximum;
  }
  return result;
}

/** Last valid rating wins; unknown MovieLens IDs and vetoed units do not enter a profile. @param {TvModel} model @param {Rating[]} ratings */
function profile(model, ratings) {
  const values = new Map();
  for (const entry of ratings) {
    const row = entry ? model.itemIndex.get(entry.movieId) : undefined;
    if (row !== undefined && model.metadata.items[row].eligible && isValidRating(entry.rating)) values.set(row, entry.rating);
  }
  const seen = new Set(model.metadata.items.flatMap((item, row) => item.eligible ? [] : [row]));
  for (const row of values.keys()) seen.add(row);
  return { seen, liked: [...values].filter(([, rating]) => rating >= 4).map(([row]) => row), ratingsCount: values.size };
}

/** Full candidate ranking for shared lists. @param {TvModel} model @param {Rating[]} ratings */
export function rankSeries(model, ratings) {
  const { metadata, candidates } = model;
  const current = profile(model, ratings);
  const personal = new Float64Array(metadata.itemCount);
  const popularity = Float64Array.from(metadata.items, item => item.popularity);
  if (current.liked.length) {
    const cf = normalized(affinities(/** @type {SparseGroup} */ (model.groups.get("cf")), current.liked), current.seen);
    const synopsis = normalized(affinities(/** @type {SparseGroup} */ (model.groups.get("synopsis")), current.liked), current.seen);
    const genres = normalized(affinities(/** @type {SparseGroup} */ (model.groups.get("genres")), current.liked), current.seen);
    const cast = normalized(affinities(/** @type {SparseGroup} */ (model.groups.get("cast")), current.liked), current.seen);
    for (let row = 0; row < personal.length; row++) {
      personal[row] = cf[row] + metadata.weights.plot * synopsis[row]
        + metadata.weights.metadata * (genres[row] + cast[row]) / 2
        + metadata.weights.quality * metadata.items[row].quality;
    }
  } else {
    personal.set(popularity);
  }
  const scaledPersonal = normalized(personal, current.seen, candidates);
  const scaledPopularity = normalized(popularity, current.seen, candidates);
  const scores = new Float64Array(metadata.itemCount);
  for (const row of candidates) scores[row] = metadata.weights.personal * scaledPersonal[row] + (1 - metadata.weights.personal) * scaledPopularity[row];
  const ranked = candidates.filter(row => !current.seen.has(row));
  ranked.sort((left, right) => scores[right] - scores[left]
    || metadata.items[right].popularity - metadata.items[left].popularity
    || metadata.items[left].movieId - metadata.items[right].movieId);
  return {
    movies: ranked.map(row => ({ ...metadata.items[row], score: scores[row],
      reason: current.liked.length ? "Based on titles you rated highly, balanced with popular series."
        : "A popular series to start with. Rate series you have seen to make this yours." })),
    mode: current.liked.length ? "personalized" : "starter",
    likes: current.liked.length,
    ratingsCount: current.ratingsCount,
  };
}

/** @param {TvModel} model @param {Rating[]} ratings @param {number} [limit] */
export function recommendSeries(model, ratings, limit = 12) {
  const result = rankSeries(model, ratings);
  const size = Number.isFinite(limit) ? Math.max(0, Math.min(48, Math.trunc(limit))) : 12;
  return { ...result, movies: result.movies.slice(0, size) };
}

/** @param {string} value */
function searchable(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** @param {TvMetadata} metadata @param {{q?:string,genre?:string,page?:number,sort?:string,ids?:number[]}} [options] */
export function browseSeries(metadata, options = {}) {
  const query = searchable(options.q || "").split(" ").filter(Boolean);
  const ids = options.ids ? new Set(options.ids) : null;
  const candidates = metadata.items.filter(item => item.candidate && item.eligible && item.mediaType === "series");
  const genres = [...new Set(candidates.flatMap(item => item.genres))].sort();
  const selected = candidates.filter(item => (!ids || ids.has(item.movieId))
    && (!options.genre || item.genres.includes(options.genre))
    && query.every(term => searchable(`${item.title} ${item.alternateTitle}`).includes(term)));
  selected.sort((a, b) => {
    if (options.sort === "title") return a.title.localeCompare(b.title, "en") || a.movieId - b.movieId;
    if (options.sort === "year") return (b.year || 0) - (a.year || 0) || b.popularity - a.popularity || a.movieId - b.movieId;
    if (options.sort === "rating") return b.quality - a.quality || b.popularity - a.popularity || a.movieId - b.movieId;
    return b.popularity - a.popularity || a.movieId - b.movieId;
  });
  const page = Math.max(1, Math.trunc(options.page || 1));
  const pageSize = 24;
  return { movies: selected.slice((page - 1) * pageSize, page * pageSize), total: selected.length, page, pageSize, genres };
}
