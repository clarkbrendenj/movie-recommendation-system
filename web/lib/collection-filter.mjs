/** @typedef {'all'|'rated'|'unrated'} CollectionRatingStatus */
/** @typedef {'all'|'yes'|'no'} CollectionFlagFilter */
/** @typedef {{ratingStatus:CollectionRatingStatus,ratingMin:string,ratingMax:string,genres:readonly string[],yearMin:string,yearMax:string,favorite:CollectionFlagFilter,watched:CollectionFlagFilter}} CollectionFilters */
/** @typedef {{filters?:Partial<CollectionFilters>,ratings?:ReadonlyMap<number,number>,states?:ReadonlyMap<number,{liked?:boolean,watched?:boolean}>}} CollectionFilterOptions */

/** @type {Readonly<CollectionFilters>} */
export const EMPTY_FILTERS = Object.freeze({
  ratingStatus: 'all', ratingMin: '', ratingMax: '', genres: Object.freeze([]),
  yearMin: '', yearMax: '', favorite: 'all', watched: 'all',
});

const genreOrder = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const normalizeGenre = value => value.trim().toLocaleLowerCase('en');

/** @param {{genres?:readonly string[]}} item */
function meaningfulGenres(item) {
  return Array.isArray(item.genres) ? item.genres.filter(genre => typeof genre === 'string')
    .map(genre => genre.trim()).filter(genre => genre && normalizeGenre(genre) !== '(no genres listed)') : [];
}

/** Available options are derived from the full source, not already filtered rows.
 * @param {readonly {genres?:readonly string[]}[]} items
 * @returns {string[]}
 */
export function getGenreOptions(items) {
  const labels = new Map();
  for (const item of items) {
    for (const genre of meaningfulGenres(item)) {
      const key = normalizeGenre(genre);
      if (!labels.has(key)) labels.set(key, genre);
    }
  }
  return [...labels.values()].sort(genreOrder.compare);
}

/** Saved scores alone establish rated state; no default, draft, or public score.
 * @param {number} movieId
 * @param {ReadonlyMap<number,number>} ratings
 * @returns {number|null}
 */
export function getSavedCollectionRating(movieId, ratings) {
  const value = ratings.get(movieId);
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10 ? value : null;
}

/** Explicit watched state takes precedence over the legacy rated-title fallback.
 * @param {number} movieId
 * @param {ReadonlyMap<number,number>} ratings
 * @param {ReadonlyMap<number,{watched?:boolean}>} states
 */
export function isCollectionWatched(movieId, ratings, states) {
  const explicit = states.get(movieId)?.watched;
  return typeof explicit === 'boolean' ? explicit : getSavedCollectionRating(movieId, ratings) !== null;
}

function readBound(raw, minimum, maximum, whole) {
  if (raw === undefined || raw === '') return { value: null, valid: true };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { value: null, valid: false };
  const text = String(raw).trim();
  if (!text) return { value: null, valid: true };
  if (!/^\d+(?:\.\d+)?$/.test(text)) return { value: null, valid: false };
  const value = Number(text);
  return { value, valid: Number.isFinite(value) && value >= minimum && value <= maximum && (!whole || Number.isInteger(value)) };
}

/** Compile editable filter values once, before walking a collection. */
function compileFilters(filters) {
  const value = { ...EMPTY_FILTERS, ...filters };
  if (!['all', 'rated', 'unrated'].includes(value.ratingStatus)) return { error: 'Choose all, rated, or unrated titles.' };
  if (!['all', 'yes', 'no'].includes(value.favorite) || !['all', 'yes', 'no'].includes(value.watched)) return { error: 'Choose all, yes, or no for Favorite and Watched.' };
  if (!Array.isArray(value.genres) || value.genres.some(genre => typeof genre !== 'string' || !genre.trim())) return { error: 'Choose valid genre labels.' };
  const ratingMin = readBound(value.ratingMin, 1, 10, false), ratingMax = readBound(value.ratingMax, 1, 10, false);
  if (!ratingMin.valid || !ratingMax.valid) return { error: 'Rating bounds must be numbers from 1 to 10.' };
  if (ratingMin.value !== null && ratingMax.value !== null && ratingMin.value > ratingMax.value) return { error: 'Minimum rating must not exceed maximum rating.' };
  const yearMin = readBound(value.yearMin, 1, 9999, true), yearMax = readBound(value.yearMax, 1, 9999, true);
  if (!yearMin.valid || !yearMax.valid) return { error: 'Year bounds must be whole years from 1 to 9999.' };
  if (yearMin.value !== null && yearMax.value !== null && yearMin.value > yearMax.value) return { error: 'Earliest year must not exceed latest year.' };
  return { error: null, value, ratingMin: ratingMin.value, ratingMax: ratingMax.value,
    yearMin: yearMin.value, yearMax: yearMax.value, genres: new Set(value.genres.map(normalizeGenre)) };
}

/** @param {Partial<CollectionFilters>} [filters] @returns {string|null} */
export function getFilterError(filters = EMPTY_FILTERS) {
  return compileFilters(filters).error;
}

/** @param {Partial<CollectionFilters>} [filters] */
export function hasActiveFilters(filters = EMPTY_FILTERS) {
  const value = { ...EMPTY_FILTERS, ...filters };
  const hasBound = bound => bound !== undefined && String(bound).trim() !== '';
  return value.ratingStatus !== 'all' || value.favorite !== 'all' || value.watched !== 'all'
    || hasBound(value.ratingMin) || hasBound(value.ratingMax) || hasBound(value.yearMin) || hasBound(value.yearMax)
    || !Array.isArray(value.genres) || value.genres.length > 0;
}

/**
 * Filters combine with AND across columns and OR within the selected genres.
 * Bounds are inclusive. Invalid editable values return no matches, preventing a
 * malformed filter from silently broadening a private library view. Items and
 * saved feedback remain unchanged; filtering retains the input collection order.
 * @template {{movieId:number,genres?:readonly string[],year?:number|null}} T
 * @param {readonly T[]} items
 * @param {CollectionFilterOptions} [options]
 * @returns {T[]}
 */
export function filterCollection(items, { filters = EMPTY_FILTERS, ratings = new Map(), states = new Map() } = {}) {
  const compiled = compileFilters(filters);
  if (compiled.error) return [];
  const { value, ratingMin, ratingMax, yearMin, yearMax, genres } = compiled;
  const ratingRange = ratingMin !== null || ratingMax !== null;
  const yearRange = yearMin !== null || yearMax !== null;
  return items.filter(item => {
    const rating = getSavedCollectionRating(item.movieId, ratings);
    if (value.ratingStatus === 'rated' && rating === null) return false;
    if (value.ratingStatus === 'unrated' && rating !== null) return false;
    if (ratingRange && (rating === null || (ratingMin !== null && rating < ratingMin) || (ratingMax !== null && rating > ratingMax))) return false;
    if (genres.size && !meaningfulGenres(item).some(genre => genres.has(normalizeGenre(genre)))) return false;
    const year = typeof item.year === 'number' && Number.isSafeInteger(item.year) && item.year >= 1 && item.year <= 9999 ? item.year : null;
    if (yearRange && (year === null || (yearMin !== null && year < yearMin) || (yearMax !== null && year > yearMax))) return false;
    const favorite = states.get(item.movieId)?.liked === true;
    if (value.favorite !== 'all' && favorite !== (value.favorite === 'yes')) return false;
    const watched = isCollectionWatched(item.movieId, ratings, states);
    return value.watched === 'all' || watched === (value.watched === 'yes');
  });
}
