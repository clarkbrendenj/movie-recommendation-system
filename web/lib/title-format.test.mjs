import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTitle } from './title-format.mjs';

test('removes the scraped aka label only for known source titles', () => {
  assert.equal(formatTitle({ movieId: 1000101269, title: 'Hi Score Girlaka' }), 'Hi Score Girl');
  assert.equal(formatTitle({ movieId: 1000101263, title: 'Zachowaj spokójaka' }), 'Zachowaj spokój');
  assert.equal(formatTitle({ movieId: 1000101269, title: 'Osaka' }), 'Osaka');
  assert.equal(formatTitle({ movieId: 42, title: 'Tanaka' }), 'Tanaka');
  assert.equal(formatTitle({ movieId: 43, title: 'Basutado!! Ankoku no hakaishin' }), 'Basutado!! Ankoku no hakaishin');
});
test('keeps title formatting separate from identity and model metadata', () => {
  const movie = { movieId: 1, title: 'Toy Story (1995)' };
  assert.equal(formatTitle(movie), 'Toy Story');
  assert.equal(movie.title, 'Toy Story (1995)');
  assert.equal(formatTitle({ movieId: 2, title: 'Godfather, The (1972)' }), 'The Godfather');
  assert.equal(formatTitle({ movieId: 3, title: 'Original', displayTitle: '  Display   title ' }), 'Display title');
});
