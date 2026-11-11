import { isValidImdbId, isValidTmdbId, matchesTmdbMovie, selectTmdbMovieMatch, selectTmdbTvMatch, tmdbDisplayDetails, selectTmdbPoster, tmdbPosterUrl } from './tmdb-details.mjs';

/** @param {string|null} raw */
export function parseArtworkIds(raw) {
  if (!raw || raw.length > 160 || !/^\d+(,\d+)*$/.test(raw)) throw new RangeError('Choose one to six valid catalog IDs.');
  const values = raw.split(',').map(Number);
  if (values.length > 6 || values.some(id => !Number.isSafeInteger(id) || id < 1)) throw new RangeError('Choose one to six valid catalog IDs.');
  return [...new Set(values)];
}

/**
 * Credentials and raw upstream responses stay inside this provider. The
 * supplied identity resolver reads the frozen public catalog, never ratings.
 * @typedef {{kind:'http',status:number}|{kind:'timeout'|'fetch'|'parse'|'budget'}} TmdbFailure
 */
/**
 * @param {number[]} ids
 * @param {{token?:string,getIdentity:(id:number)=>Promise<any>,fetch?:typeof fetch,onFailure?:(failure:TmdbFailure)=>void,cache?:{get:(id:number)=>Promise<any|null>,set:(id:number,details:any,ttl:number)=>Promise<void>}} options
 */
export async function getTmdbTitleDetails(ids, options) {
  if (ids.length > 6 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new RangeError('Invalid artwork batch.');
  if (!options.token) return { configured: false, items: {} };
  const token = options.token, transport = options.fetch || fetch, deadline = Date.now() + 12000;
  let unavailable = false, requests = 0;
  /** Only fixed categories and HTTP status may leave the credential boundary.
   * @param {TmdbFailure} failure
   */
  function reportFailure(failure) {
    unavailable = true;
    try { options.onFailure?.(failure); } catch { /* Diagnostics are optional. */ }
  }
  /** @param {string} path @param {Record<string,string>} [params] */
  async function request(path, params = {}) {
    if (++requests > 20 || Date.now() >= deadline) { reportFailure({ kind: 'budget' }); return null; }
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(4500, Math.max(1, deadline - Date.now())));
    let parsing = false;
    try {
      // Workers support manual/follow only. Reject every redirect as a non-OK
      // response below, so the bearer token never follows a different target.
      const response = await transport(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { reportFailure({ kind: 'http', status: response.status }); await response.body?.cancel(); return null; }
      parsing = true;
      return await response.json();
    } catch { reportFailure({ kind: controller.signal.aborted ? 'timeout' : parsing ? 'parse' : 'fetch' }); return null; }
    finally { clearTimeout(timer); }
  }
  async function display(details, mediaType) {
    const result = tmdbDisplayDetails(details, { mediaType });
    if (!result.posterUrl) {
      const images = await request(`/${mediaType === 'movie' ? 'movie' : 'tv'}/${details.id}/images`);
      const poster = selectTmdbPoster(images, details.id);
      if (poster) result.posterUrl = tmdbPosterUrl(poster);
    }
    return result;
  }
  const entries = await Promise.all(ids.map(async id => {
    let cached;
    try { cached = await options.cache?.get(id); } catch { /* The public cache is optional. */ }
    if (cached !== undefined && cached !== null) return [id, cached];
    const identity = await options.getIdentity(id);
    if (!identity) return [id, {}];
    let details = null;
    if (identity.mediaType === 'movie') {
      if (!isValidImdbId(identity.imdbId)) return [id, {}];
      let tmdbId = identity.tmdbId;
      if (!isValidTmdbId(tmdbId)) {
        const result = await request(`/find/${identity.imdbId}`, { external_source: 'imdb_id' });
        tmdbId = selectTmdbMovieMatch(result, identity)?.id;
      }
      if (isValidTmdbId(tmdbId)) {
        const movie = await request(`/movie/${tmdbId}`, { append_to_response: 'credits', language: 'en-US' });
        if (matchesTmdbMovie(movie, identity)) details = await display(movie, 'movie');
      }
    } else if (identity.mediaType === 'series') {
      const search = async query => selectTmdbTvMatch(await request('/search/tv', { query, first_air_date_year: String(identity.year), include_adult: 'false', language: 'en-US' }), identity);
      let match = await search(identity.title);
      if (!match && identity.alternateTitle && identity.alternateTitle !== identity.title) match = await search(identity.alternateTitle);
      if (match) {
        const show = await request(`/tv/${match.id}`, { append_to_response: 'aggregate_credits', language: 'en-US' });
        if (show?.id === match.id && selectTmdbTvMatch([show], identity)) details = await display(show, 'series');
      }
    }
    const result = details || {};
    if (!unavailable) { try { await options.cache?.set(id, result, details ? 604800 : 21600); } catch { /* Artwork can still render without cache persistence. */ } }
    return [id, result];
  }));
  return { configured: true, items: Object.fromEntries(entries.filter(([, details]) => Object.keys(details).length)), ...(unavailable ? { unavailable: true } : {}) };
}
