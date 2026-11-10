import test from 'node:test';
import assert from 'node:assert/strict';
import { getTmdbTitleDetails, parseArtworkIds } from './tmdb-provider.mjs';

const movieIdentity = { mediaType: 'movie', imdbId: 'tt0114709', tmdbId: 862 };
const film = { id: 862, imdb_id: 'tt0114709', poster_path: '/poster123.jpg', vote_average: 9, popularity: 100, credits: { cast: [{ name: 'Tom Hanks' }] } };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('artwork batches reject oversized, malformed, and unsafe IDs before any provider call', () => {
  assert.deepEqual(parseArtworkIds('1,1000101269,1'), [1, 1000101269]);
  for (const input of [null, '', '1e3', '-1', '1,2,3,4,5,6,7', '9007199254740992', '1&api_key=oops']) assert.throws(() => parseArtworkIds(input), RangeError);
});
test('an unconfigured provider makes no identity or external requests', async () => {
  assert.deepEqual(await getTmdbTitleDetails([1], { getIdentity: async () => { throw Error('must not load'); }, fetch: async () => { throw Error('must not fetch'); } }), { configured: false, items: {} });
});
test('known movies use authoritative IDs and return only sanitized public fields', async () => {
  const writes = [];
  const result = await getTmdbTitleDetails([1], { token: 'test-only-token', getIdentity: async () => movieIdentity,
    fetch: async (url, init) => { assert.equal(url.origin, 'https://api.themoviedb.org'); assert.equal(url.pathname, '/3/movie/862'); assert.equal(url.searchParams.get('append_to_response'), 'credits'); assert.equal(url.searchParams.has('api_key'), false); assert.equal(init.headers.Authorization, 'Bearer test-only-token'); assert.equal(init.redirect, 'error'); return json(film); },
    cache: { get: async () => null, set: async (...values) => { writes.push(values); } } });
  assert.equal(result.configured, true); assert.equal(result.items[1].posterUrl, 'https://image.tmdb.org/t/p/w342/poster123.jpg');
  assert.deepEqual(result.items[1].cast, ['Tom Hanks']); assert.equal(writes[0][2], 604800);
  assert.ok(!JSON.stringify(result).includes('test-only-token')); assert.ok(!JSON.stringify(result).includes('vote_average')); assert.ok(!JSON.stringify(result).includes('popularity'));
});
test('unknown IDs never become an arbitrary TMDB proxy', async () => {
  const result = await getTmdbTitleDetails([999], { token: 'test-only-token', getIdentity: async () => null, fetch: async () => { throw Error('no outbound request allowed'); } });
  assert.deepEqual(result.items, {});
});
test('conflicting movie identities fail without exposing the wrong poster', async () => {
  const result = await getTmdbTitleDetails([1], { token: 'test-only-token', getIdentity: async () => movieIdentity, fetch: async () => json({ ...film, imdb_id: 'tt0000001' }) });
  assert.deepEqual(result.items, {});
});
test('TV remakes with the wrong year never trigger a details request', async () => {
  let count = 0;
  const result = await getTmdbTitleDetails([1000000001], { token: 'test-only-token', getIdentity: async () => ({ mediaType: 'series', title: 'The Show', year: 2020 }), fetch: async () => { count++; return json({ results: [{ id: 5, name: 'The Show', first_air_date: '1990-01-01' }], total_pages: 1 }); } });
  assert.equal(count, 1); assert.deepEqual(result.items, {});
});
test('verified TV titles use whole-series aggregate credits and exclude season units', async () => {
  const show = { id: 5, name: 'The Show', original_name: 'The Show', first_air_date: '2020-01-02', poster_path: '/series123.jpg',
    seasons: [{ season_number: 0, air_date: '2020-01-01' }, { season_number: 1, air_date: '2020-01-02' }],
    aggregate_credits: { cast: [{ name: 'Series Actor' }] }, created_by: [{ name: 'Series Creator' }], vote_average: 9 };
  const result = await getTmdbTitleDetails([1000000001], { token: 'test-only-token', getIdentity: async () => ({ mediaType: 'series', title: 'The Show', year: 2020 }), fetch: async url => {
    if (url.pathname === '/3/search/tv') return json({ results: [show], total_pages: 1 });
    assert.equal(url.pathname, '/3/tv/5'); assert.equal(url.searchParams.get('append_to_response'), 'aggregate_credits'); return json(show);
  } });
  assert.equal(result.items[1000000001].seasonCount, 1); assert.deepEqual(result.items[1000000001].cast, ['Series Actor']);
  assert.deepEqual(result.items[1000000001].creators, ['Series Creator']); assert.equal('vote_average' in result.items[1000000001], false);
});
test('upstream credential errors reveal no response body and are not cached as permanent misses', async () => {
  let writes = 0;
  const result = await getTmdbTitleDetails([1], { token: 'test-only-token', getIdentity: async () => movieIdentity, fetch: async () => new Response('provider error including test-only-token', { status: 401 }), cache: { get: async () => null, set: async () => { writes++; } } });
  assert.equal(result.unavailable, true); assert.deepEqual(result.items, {}); assert.equal(writes, 0); assert.ok(!JSON.stringify(result).includes('test-only-token'));
});
test('public cache hits avoid both identity loading and external API requests', async () => {
  const cached = { posterUrl: 'https://image.tmdb.org/t/p/w342/poster123.jpg' };
  const result = await getTmdbTitleDetails([1], { token: 'test-only-token', getIdentity: async () => { throw Error('should use cache'); }, fetch: async () => { throw Error('should use cache'); }, cache: { get: async () => cached, set: async () => {} } });
  assert.deepEqual(result.items[1], cached);
});
