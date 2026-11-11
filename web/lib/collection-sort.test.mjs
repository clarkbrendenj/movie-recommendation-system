import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTION_SORT_FIELDS, sortCollection } from './collection-sort.mjs';

const movie = (movieId, title, extra = {}) => ({ movieId, title, genres: [], year: null, ...extra });
const ids = rows => rows.map(row => row.movieId);

test('original order is a fresh array retaining every item and source identity', () => {
  const rows = [movie(1000000001, 'Series'), movie(2, 'Movie'), movie(1, 'Another movie')];
  const sorted = sortCollection(rows);
  assert.deepEqual(ids(sorted), [1000000001, 2, 1]);
  assert.notEqual(sorted, rows);
  assert.equal(sorted[0], rows[0]);
  assert.deepEqual(COLLECTION_SORT_FIELDS, ['original', 'rating', 'genre', 'favorite', 'year']);
});

test('rating sort uses confirmed personal scores, keeping unrated and invalid values last in either direction', () => {
  const rows = [movie(1, 'Zulu', { imdbRating: 10, popularity: 999 }), movie(2, 'Five'), movie(3, 'High'), movie(4, 'Low'),
    movie(5, 'Alpha', { rating: 9, draftRating: 10 }), movie(6, 'Beta'), movie(7, 'Gamma'), movie(8, 'Omega'), movie(9, 'Delta')];
  const ratings = new Map([[2, 5], [3, 9.8], [4, 1.1], [6, NaN], [7, Infinity], [8, 11], [9, '8']]);
  assert.deepEqual(ids(sortCollection(rows, { field: 'rating', direction: 'desc', ratings })), [3, 2, 4, 5, 6, 9, 7, 8, 1]);
  assert.deepEqual(ids(sortCollection(rows, { field: 'rating', direction: 'asc', ratings })), [4, 2, 3, 5, 6, 9, 7, 8, 1]);
  assert.equal(ratings.size, 7);
});

test('year sort puts known release years first and leaves missing or malformed years at the end', () => {
  const rows = [movie(1, 'Unknown'), movie(2, 'Older', { year: 1950 }), movie(3, 'Newer', { year: 2024 }),
    movie(4, 'Invalid', { year: Infinity }), movie(5, 'Empty', { year: 0 }), movie(6, 'String', { year: '2020' })];
  assert.deepEqual(ids(sortCollection(rows, { field: 'year', direction: 'asc' })), [2, 3, 5, 4, 6, 1]);
  assert.deepEqual(ids(sortCollection(rows, { field: 'year', direction: 'desc' })), [3, 2, 5, 4, 6, 1]);
});

test('genre sort groups the first meaningful listed genre and places unknown genres last', () => {
  const rows = [movie(1, 'Unknown', { genres: ['(no genres listed)', ' '] }), movie(2, 'Drama title', { genres: ['Drama'] }),
    movie(3, 'Action drama', { genres: ['Action', 'Drama'] }), movie(4, 'Action crime', { genres: ['', 'Action', 'Crime'] }),
    movie(5, 'Comedy title', { genres: ['Comedy'] }), movie(6, 'Missing')];
  assert.deepEqual(ids(sortCollection(rows, { field: 'genre', direction: 'asc' })), [4, 3, 5, 2, 6, 1]);
  assert.deepEqual(ids(sortCollection(rows, { field: 'genre', direction: 'desc' })), [2, 5, 3, 4, 6, 1]);
});

test('Favorite sorting uses the explicit flag independently of rating and watched state', () => {
  const rows = [movie(1, 'High nonfavorite'), movie(2, 'Low favorite'), movie(1000000003, 'Unrated series favorite'), movie(4, 'Absent flag')];
  const ratings = new Map([[1, 10], [2, 2.1]]);
  const states = new Map([[1, { liked: false, watched: true }], [2, { liked: true, watched: false }],
    [1000000003, { liked: true, watched: false }]]);
  assert.deepEqual(ids(sortCollection(rows, { field: 'favorite', direction: 'desc', ratings, states })), [2, 1000000003, 4, 1]);
  assert.deepEqual(ids(sortCollection(rows, { field: 'favorite', direction: 'asc', ratings, states })), [4, 1, 2, 1000000003]);
});

test('ties use the displayed cleaned title and numeric identity for deterministic mixed catalogs', () => {
  const rows = [movie(1000000002, 'Something else', { displayTitle: 'Alpha' }), movie(9, 'Alpha'),
    movie(3, 'Film 10'), movie(2, 'Film 2'), movie(1, 'Matrix, The (1999)')];
  const ratings = new Map(rows.map(row => [row.movieId, 8]));
  assert.deepEqual(ids(sortCollection(rows, { field: 'rating', direction: 'desc', ratings })), [9, 1000000002, 2, 3, 1]);
  assert.deepEqual(ids(sortCollection(rows, { field: 'rating', direction: 'asc', ratings })), [9, 1000000002, 2, 3, 1]);
});

test('sorting frozen rows never mutates title data, genre arrays, private flags, or scores', () => {
  const rows = Object.freeze([
    Object.freeze(movie(1, 'Zulu', { genres: Object.freeze(['Drama']), year: 2020, score: 99 })),
    Object.freeze(movie(2, 'Alpha', { genres: Object.freeze(['Action']), year: 1990, score: 1 })),
  ]);
  const state = Object.freeze({ liked: true, watched: false });
  const ratings = new Map([[1, 3.4], [2, 9.1]]), states = new Map([[1, state]]);
  for (const field of COLLECTION_SORT_FIELDS) {
    for (const direction of ['asc', 'desc']) {
      const output = sortCollection(rows, { field, direction, ratings, states });
      assert.equal(output.length, rows.length);
      assert.ok(output.every(row => rows.includes(row)));
    }
  }
  assert.deepEqual(ids(rows), [1, 2]);
  assert.deepEqual(rows[0].genres, ['Drama']);
  assert.equal(rows[0].score, 99);
  assert.deepEqual([...ratings], [[1, 3.4], [2, 9.1]]);
  assert.equal(states.get(1), state);
});
