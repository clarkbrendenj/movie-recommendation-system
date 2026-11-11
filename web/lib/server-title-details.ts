import { env } from 'cloudflare:workers';
import { getTmdbTitleDetails } from './tmdb-provider.mjs';

type PublicIdentity = { mediaType: 'movie' | 'series'; imdbId?: string; tmdbId?: number; title?: string; alternateTitle?: string; year?: number | null };
type IdentityShard = { version: number; items: Record<string, PublicIdentity> };
const shards = new Map<number, Promise<IdentityShard>>();

async function getIdentity(id: number) {
  const index = id % 32;
  if (!shards.has(index)) shards.set(index, (async () => {
    const assets = (env as unknown as { ASSETS: { fetch: typeof fetch } }).ASSETS;
    const assetOrigin = import.meta.env.DEV ? 'http://127.0.0.1:5173' : 'https://model-assets.local';
    const response = await assets.fetch(new Request(`${assetOrigin}/catalog/artwork-identities-${String(index).padStart(2, '0')}.json`));
    if (!response.ok) throw new Error('Artwork identity asset unavailable.');
    const value = await response.json() as IdentityShard;
    if (value.version !== 1 || !value.items) throw new Error('Invalid artwork identity asset.');
    return value;
  })().catch(error => { shards.delete(index); throw error; }));
  return (await shards.get(index)!).items[String(id)] || null;
}

export async function titleDetails(ids: number[], origin: string) {
  const token = (env as unknown as { TMDB_API_READ_TOKEN?: string }).TMDB_API_READ_TOKEN;
  const cache = (caches as unknown as { default?: Cache }).default;
  const key = (id: number) => new Request(new URL(`/__public-title-cache/tmdb-v2/${id}`, origin));
  return getTmdbTitleDetails(ids, { token, getIdentity, cache: cache ? {
    get: async id => { const response = await cache.match(key(id)); return response ? response.json() : null; },
    set: async (id, details, ttl) => { await cache.put(key(id), Response.json(details, { headers: { 'Cache-Control': `public, max-age=${ttl}` } })); },
  } : undefined });
}
