import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_FILTERS, filterCollection, getFilterError, getGenreOptions,
  getSavedCollectionRating, hasActiveFilters, isCollectionWatched,
} from './collection-filter.mjs';

const movie = (movieId, extra = {}) => ({ movieId, title: `Title ${movieId}`, genres: [], year: null, ...extra });
const ids = rows => rows.map(row => row.movieId);

test('empty filters retain source order and item identities in a new array', () => {
  const rows = [movie(1000000001), movie(2), movie(1)];
  const result = filterCollection(rows);
  assert.deepEqual(ids(result), [1000000001, 2, 1]);
  assert.notEqual(result, rows);
  assert.equal(result[0], rows[0]);
  assert.equal(Object.isFrozen(EMPTY_FILTERS), true);
  assert.equal(Object.isFrozen(EMPTY_FILTERS.genres), true);
  assert.equal(getFilterError(), null);
  assert.equal(hasActiveFilters(), false);
});

test('rated status reads only valid saved scores and ignores defaults, drafts, and public scores', () => {
  const rows = [movie(1, { rating: 5, draftRating: 8, imdbRating: 9.5 }), movie(2), movie(3), movie(4), movie(5), movie(6), movie(7)];
  const ratings = new Map([[2, 5], [3, NaN], [4, Infinity], [5, 0], [6, 10.1], [7, '8']]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingStatus: 'rated' }, ratings })), [2]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingStatus: 'unrated' }, ratings })), [1, 3, 4, 5, 6, 7]);
  assert.equal(getSavedCollectionRating(1, ratings), null);
  assert.equal(getSavedCollectionRating(2, ratings), 5);
  assert.equal(getSavedCollectionRating(7, ratings), null);
});

test('rating bounds include both endpoints and exclude missing scores only when a range is active', () => {
  const rows = [movie(1), movie(2), movie(3), movie(4), movie(5), movie(6)];
  const ratings = new Map([[1, 1], [2, 7], [3, 7.6], [4, 10], [6, -1]]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingMin: '7', ratingMax: '7.6' }, ratings })), [2, 3]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingMin: '10' }, ratings })), [4]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingMax: '1' }, ratings })), [1]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingMin: '1', ratingMax: '10' }, ratings })), [1, 2, 3, 4]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingMin: ' ', ratingMax: '' }, ratings })), [1, 2, 3, 4, 5, 6]);
});

test('genre options use the full source, trim labels, remove placeholders, and deduplicate case-insensitively', () => {
  const rows = [movie(1, { genres: [' Drama ', 'Action', ''] }), movie(2, { genres: ['drama', 'Comedy'] }),
    movie(3, { genres: ['(NO GENRES LISTED)', ' ', 'Sci-Fi'] }), movie(4)];
  assert.deepEqual(getGenreOptions(rows), ['Action', 'Comedy', 'Drama', 'Sci-Fi']);
  const filtered = filterCollection(rows, { filters: { genres: ['Comedy'] } });
  assert.deepEqual(ids(filtered), [2]);
  assert.deepEqual(getGenreOptions(rows), ['Action', 'Comedy', 'Drama', 'Sci-Fi']);
});

test('genre filtering checks every meaningful genre with OR within the selected labels', () => {
  const rows = [movie(1, { genres: ['Action', 'Drama'] }), movie(2, { genres: ['Comedy', 'drama'] }),
    movie(3, { genres: ['Sci-Fi'] }), movie(4, { genres: ['(no genres listed)', ''] }), movie(5)];
  assert.deepEqual(ids(filterCollection(rows, { filters: { genres: [' DRAMA ', 'sci-fi'] } })), [1, 2, 3]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { genres: ['Drama'] } })), [1, 2]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { genres: ['(no genres listed)'] } })), []);
  assert.deepEqual(ids(filterCollection(rows, { filters: { genres: ['Unknown'] } })), []);
  assert.deepEqual(ids(filterCollection(rows, { filters: { genres: [] } })), [1, 2, 3, 4, 5]);
});

test('year ranges are inclusive and require a known whole release year when active', () => {
  const rows = [movie(1, { year: 1990 }), movie(2, { year: 2000 }), movie(3, { year: 2020 }), movie(4),
    movie(5, { year: '2000' }), movie(6, { year: 2000.5 }), movie(7, { year: 0 })];
  assert.deepEqual(ids(filterCollection(rows, { filters: { yearMin: '1990', yearMax: '2000' } })), [1, 2]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { yearMin: '2020' } })), [3]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { yearMax: '1990' } })), [1]);
  assert.deepEqual(ids(filterCollection(rows)), [1, 2, 3, 4, 5, 6, 7]);
});

test('Favorite is an independent explicit flag, including low-scored and unrated favorites', () => {
  const rows = [movie(1), movie(2), movie(1000000001), movie(4)];
  const ratings = new Map([[1, 10], [2, 2.1]]);
  const states = new Map([[1, { liked: false, watched: true }], [2, { liked: true, watched: false }],
    [1000000001, { liked: true }]]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { favorite: 'yes' }, ratings, states })), [2, 1000000001]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { favorite: 'no' }, ratings, states })), [1, 4]);
});

test('Watched honors explicit flags and falls back only to a valid saved score', () => {
  const rows = [movie(1), movie(2), movie(3), movie(4), movie(5), movie(6)];
  const ratings = new Map([[1, 5], [3, 8], [5, NaN], [6, '7']]);
  const states = new Map([[2, { watched: true }], [3, { watched: false }], [4, { liked: true }]]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { watched: 'yes' }, ratings, states })), [1, 2]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { watched: 'no' }, ratings, states })), [3, 4, 5, 6]);
  assert.equal(isCollectionWatched(3, ratings, states), false);
  assert.equal(isCollectionWatched(2, ratings, states), true);
});

test('all active columns combine with AND while keeping the original collection order', () => {
  const rows = [movie(1000000001, { year: 2005, genres: ['Drama', 'Mystery'] }), movie(1, { year: 2005, genres: ['Drama'] }),
    movie(2, { year: 2005, genres: ['Comedy'] }), movie(3, { year: 1980, genres: ['Drama'] }),
    movie(4, { year: 2005, genres: ['Drama'] }), movie(5, { year: 2005, genres: ['Drama'] })];
  const ratings = new Map([[1000000001, 7.6], [1, 8], [2, 8], [3, 8], [4, 8], [5, 6]]);
  const states = new Map(rows.map(row => [row.movieId, { liked: row.movieId !== 4, watched: true }]));
  const filters = { ratingStatus: 'rated', ratingMin: '7', ratingMax: '9', genres: ['Drama'],
    yearMin: '2000', yearMax: '2010', favorite: 'yes', watched: 'yes' };
  assert.deepEqual(ids(filterCollection(rows, { filters, ratings, states })), [1000000001, 1]);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingStatus: 'unrated', ratingMin: '7' }, ratings, states })), []);
});

test('invalid editable ranges and enum values fail closed and expose a validation message', () => {
  const rows = [movie(1, { year: 2000, genres: ['Drama'] })];
  const ratings = new Map([[1, 8]]);
  for (const filters of [
    { ratingMin: 'eight' }, { ratingMax: '11' }, { ratingMin: '0' }, { ratingMin: '9', ratingMax: '7' },
    { ratingMin: '1e0' }, { ratingMax: 'Infinity' }, { yearMin: '2000.5' }, { yearMax: '10000' },
    { yearMin: '2020', yearMax: '1990' }, { yearMin: 'year' }, { ratingStatus: 'unknown' },
    { favorite: 'unknown' }, { watched: 'unknown' }, { genres: [''] }, { genres: null },
  ]) {
    assert.equal(typeof getFilterError(filters), 'string', JSON.stringify(filters));
    assert.deepEqual(filterCollection(rows, { filters, ratings }), [], JSON.stringify(filters));
    assert.equal(hasActiveFilters(filters), true, JSON.stringify(filters));
  }
  assert.equal(getFilterError({ ratingMin: '7.5', yearMin: '1990' }), null);
  assert.equal(hasActiveFilters({ ratingMin: ' ', yearMax: '\t', genres: [] }), false);
  assert.equal(hasActiveFilters({ ratingStatus: 'unrated' }), true);
  assert.equal(hasActiveFilters({ watched: 'no' }), true);
  assert.equal(hasActiveFilters({ favorite: 'yes' }), true);
});

test('filtering frozen input preserves source objects, filters, feedback, and movie/series namespaces', () => {
  const rows = Object.freeze([
    Object.freeze(movie(7, { genres: Object.freeze(['Drama']), year: 2000 })),
    Object.freeze(movie(1000000007, { genres: Object.freeze(['Drama']), year: 2000 })),
  ]);
  const state = Object.freeze({ liked: true, watched: false });
  const ratings = new Map([[7, 8], [1000000007, 2]]);
  const states = new Map([[1000000007, state]]);
  const filters = Object.freeze({ ...EMPTY_FILTERS, genres: Object.freeze(['Drama']), favorite: 'yes' });
  const output = filterCollection(rows, { filters, ratings, states });
  assert.deepEqual(ids(output), [1000000007]);
  assert.equal(output[0], rows[1]);
  assert.deepEqual(ids(rows), [7, 1000000007]);
  assert.deepEqual([...ratings], [[7, 8], [1000000007, 2]]);
  assert.equal(states.get(1000000007), state);
  assert.deepEqual(filters.genres, ['Drama']);
  assert.deepEqual(getGenreOptions(rows), ['Drama']);
  assert.deepEqual(ids(filterCollection(rows, { filters: { ratingMin: '7' }, ratings, states })), [7]);
});
