/** Exact serving identities only; this does not change either trained model. */
import { readFile, writeFile } from 'node:fs/promises';
import { formatTitle } from '../lib/title-format.mjs';
const root = new URL('../../', import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const [movies, tv, exclusions] = await Promise.all([read('web/public/model/metadata.json'), read('web/public/tv-model/metadata.json'), read('web/public/catalog/movie-unit-exclusions.json')]);
const links = new Map((await readFile(new URL('data/raw/ml-latest-small/links.csv', root), 'utf8')).trim().split(/\r?\n/).slice(1).map(line => {
  const [id, imdb, tmdb] = line.split(',');
  return [Number(id), { imdbId: `tt${imdb.padStart(7, '0')}`, ...(tmdb ? { tmdbId: Number(tmdb) } : {}) }];
}));
const veto = new Set(exclusions.excludedItems.map(item => item.movieId));
const shards = Array.from({ length: 32 }, () => ({}));
let count = 0;
for (const movie of movies.movies.filter(item => !veto.has(item.movieId))) {
  const ids = links.get(movie.movieId);
  if (!ids || !/^tt\d{7,10}$/.test(ids.imdbId)) throw new Error('Missing authoritative movie identity.');
  shards[movie.movieId % 32][movie.movieId] = { mediaType: 'movie', ...ids }; count++;
}
for (const item of tv.items.filter(item => item.eligible && item.candidate && item.mediaType === 'series')) {
  shards[item.movieId % 32][item.movieId] = { mediaType: 'series', title: formatTitle(item), alternateTitle: item.alternateTitle, year: item.year }; count++;
}
if (count !== 8533) throw new Error('Artwork identity catalog does not match the deployed eligible catalogs.');
for (let index = 0; index < shards.length; index++) await writeFile(new URL(`web/public/catalog/artwork-identities-${String(index).padStart(2, '0')}.json`, root), JSON.stringify({ version: 1, items: shards[index] }) + '\n');
console.log(`Exported ${count} exact artwork identities into 32 small shards. Models unchanged.`);
