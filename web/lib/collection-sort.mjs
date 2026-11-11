import { formatTitle } from './title-format.mjs';

/** @typedef {'original'|'rating'|'genre'|'favorite'|'year'} CollectionSortField */
/** @typedef {'asc'|'desc'} CollectionSortDirection */
/** @typedef {{field?:CollectionSortField,direction?:CollectionSortDirection,ratings?:ReadonlyMap<number,number>,states?:ReadonlyMap<number,{liked?:boolean}>}} CollectionSortOptions */

/** @type {readonly CollectionSortField[]} */
export const COLLECTION_SORT_FIELDS = Object.freeze(['original', 'rating', 'genre', 'favorite', 'year']);
const titleOrder = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function meaningfulGenres(item) {
  return Array.isArray(item.genres) ? item.genres.filter(genre => typeof genre === 'string')
    .map(genre => genre.trim()).filter(genre => genre && genre.toLowerCase() !== '(no genres listed)') : [];
}

function compareGenres(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = titleOrder.compare(left[index], right[index]);
    if (difference) return difference;
  }
  return left.length - right.length;
}

/**
 * Presentation-only ordering. Only confirmed scores participate in rating sort;
 * draft/default values, public ratings, and model affinities are never read.
 * Unknown rating/year/genre values stay last in either direction. Genre sorting
 * uses the first meaningful listed genre, then its remaining displayed labels.
 * The original array and its items are retained unchanged.
 * @template {{movieId:number,title:string,displayTitle?:string,genres?:string[],year?:number|null}} T
 * @param {readonly T[]} items
 * @param {CollectionSortOptions} [options]
 * @returns {T[]}
 */
export function sortCollection(items, { field = 'original', direction = 'desc', ratings = new Map(), states = new Map() } = {}) {
  if (field === 'original' || !COLLECTION_SORT_FIELDS.includes(field)) return [...items];
  const order = direction === 'asc' ? 1 : -1;
  const rows = items.map(item => {
    let key = null;
    if (field === 'rating') {
      const value = ratings.get(item.movieId);
      if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10) key = value;
    } else if (field === 'year') {
      if (typeof item.year === 'number' && Number.isSafeInteger(item.year) && item.year > 0) key = item.year;
    } else if (field === 'favorite') {
      key = states.get(item.movieId)?.liked === true ? 1 : 0;
    } else {
      const genres = meaningfulGenres(item);
      if (genres.length) key = genres;
    }
    return { item, key, title: formatTitle(item) };
  });
  rows.sort((left, right) => {
    // Apply missing-value placement before direction, so ascending does not
    // bring an unrated or unknown title above a real score/year/genre.
    if (left.key === null && right.key !== null) return 1;
    if (right.key === null && left.key !== null) return -1;
    let primary = 0;
    if (left.key !== null && right.key !== null) {
      primary = field === 'genre' ? compareGenres(left.key, right.key) : left.key - right.key;
    }
    return order * primary || titleOrder.compare(left.title, right.title) || left.item.movieId - right.item.movieId;
  });
  return rows.map(row => row.item);
}
