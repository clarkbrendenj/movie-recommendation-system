/** Exact public-catalog identity checks and display-only TMDB extraction. */
import { normalizedTitle } from "./title-details.mjs";

/** @param {unknown} value */
export function isValidImdbId(value) { return typeof value === "string" && /^tt[0-9]{7,10}$/.test(value); }
/** @param {unknown} value */
export function isValidTmdbId(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }

/** @param {unknown} value */
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** Use only with the response from /find/{target.imdbId}?external_source=imdb_id.
 * TV/episode/person results never establish a movie identity.
 * @param {any} response @param {{imdbId:string,tmdbId?:number}} target @returns {any|null}
 */
export function selectTmdbMovieMatch(response, target) {
  if (!isValidImdbId(target.imdbId) || (target.tmdbId !== undefined && !isValidTmdbId(target.tmdbId))) return null;
  const candidates = Array.isArray(response?.movie_results) ? response.movie_results : [];
  const matches = new Map();
  for (const item of candidates) {
    if (isValidTmdbId(item?.id) && (!item.media_type || item.media_type === "movie")) matches.set(item.id, item);
  }
  if (matches.size !== 1) return null;
  const item = [...matches.values()][0];
  return target.tmdbId === undefined || item.id === target.tmdbId ? item : null;
}

/** Validate movie details against an exact IMDb identity or authoritative links.csv ID.
 * A present, conflicting IMDb identity always fails, even when the TMDB ID agrees.
 * @param {any} details @param {{imdbId:string,tmdbId?:number}} target
 */
export function matchesTmdbMovie(details, target) {
  if (!details || !isValidImdbId(target.imdbId) || !isValidTmdbId(details.id)
      || (details.media_type && details.media_type !== "movie")) return false;
  if (target.tmdbId !== undefined && (!isValidTmdbId(target.tmdbId) || details.id !== target.tmdbId)) return false;
  const identities = [details.imdb_id, details.external_ids?.imdb_id].filter(value => value !== null && value !== undefined && value !== "");
  if (identities.some(value => value !== target.imdbId)) return false;
  return identities.length > 0 || target.tmdbId === details.id;
}

/** Match original/translated names, with exact FIRST-air year; ambiguity fails closed.
 * Paginated responses must be completed/merged by the caller, not guessed from page 1.
 * @param {any} candidates @param {{title:string,alternateTitle?:string,year:number|null}} target @returns {any|null}
 */
export function selectTmdbTvMatch(candidates, target) {
  if (!Number.isInteger(target.year) || Number(target.year) < 1800) return null;
  if (!Array.isArray(candidates) && Number(candidates?.total_pages) > 1) return null;
  const entries = Array.isArray(candidates) ? candidates : candidates?.results;
  if (!Array.isArray(entries)) return null;
  const titles = new Set([target.title, target.alternateTitle].map(normalizedTitle).filter(Boolean));
  const matches = new Map();
  for (const item of entries) {
    const firstAirDate = validDate(item?.first_air_date);
    if (isValidTmdbId(item?.id) && (!item.media_type || item.media_type === "tv") && firstAirDate
        && Number(firstAirDate.slice(0, 4)) === target.year
        && [item.name, item.original_name].some(value => titles.has(normalizedTitle(value)))) matches.set(item.id, item);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

/** @param {unknown} posterPath @param {{imageBaseUrl?:string,posterSize?:'w342'|'w500'}} [options] */
export function tmdbPosterUrl(posterPath, options = {}) {
  if (typeof posterPath !== "string" || !/^\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(posterPath)) return undefined;
  const size = options.posterSize ?? "w342";
  if (size !== "w342" && size !== "w500") return undefined;
  try {
    const base = new URL(options.imageBaseUrl ?? "https://image.tmdb.org/t/p/");
    if (base.protocol !== "https:" || base.host !== "image.tmdb.org" || base.pathname !== "/t/p/"
        || base.username || base.password || base.search || base.hash) return undefined;
    return `${base.href}${size}${posterPath}`;
  } catch { return undefined; }
}

/** Select artwork only from the already-verified title's images response.
 * @param {any} response @param {number} expectedId @returns {string|undefined}
 */
export function selectTmdbPoster(response, expectedId) {
  if (!isValidTmdbId(expectedId) || response?.id !== expectedId || !Array.isArray(response.posters)) return undefined;
  const priority = item => item.iso_639_1 === 'en' ? 0 : item.iso_639_1 == null ? 1 : 2;
  const valid = response.posters.filter(item => tmdbPosterUrl(item?.file_path));
  valid.sort((a, b) => priority(a) - priority(b) || (Number(b.width) || 0) - (Number(a.width) || 0));
  return valid[0]?.file_path;
}

/** @param {any} entries */
function names(entries) {
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries.map(item => typeof item?.name === "string" ? item.name.trim() : "").filter(Boolean))].slice(0, 16);
}

/** @typedef {{posterUrl?:string,cast?:string[],directors?:string[],creators?:string[],seasonCount?:number,seasonCountAsOf?:string,endYear?:number,tmdbId?:number,metadataSource?:{name:string,url:string},creditsSource?:{name:string,url:string}}} TmdbDisplayDetails */

/** Call after verifying identity. Never copies scores, popularity, votes, or raw API data.
 * For TV, aggregate_credits covers the series; credits alone covers the latest season.
 * @param {any} details
 * @param {{mediaType:'movie'|'series',imageBaseUrl?:string,posterSize?:'w342'|'w500',asOf?:string}} options
 * @returns {TmdbDisplayDetails}
 */
export function tmdbDisplayDetails(details, options) {
  if (!details || !isValidTmdbId(details.id) || !["movie", "series"].includes(options.mediaType)) return {};
  const series = options.mediaType === "series";
  const source = { name: "TMDB", url: `https://www.themoviedb.org/${series ? "tv" : "movie"}/${details.id}` };
  /** @type {TmdbDisplayDetails} */
  const result = { tmdbId: details.id, metadataSource: source };
  const posterUrl = tmdbPosterUrl(details.poster_path, options);
  if (posterUrl) result.posterUrl = posterUrl;
  const credits = series ? details.aggregate_credits : details.credits;
  const cast = names(credits?.cast);
  const directors = names(Array.isArray(credits?.crew) ? credits.crew.filter(person => person?.job === "Director"
    || (Array.isArray(person?.jobs) && person.jobs.some(job => job?.job === "Director"))) : []);
  if (cast.length) result.cast = cast;
  if (directors.length) result.directors = directors;
  if (cast.length || directors.length) result.creditsSource = source;
  if (series) {
    const creators = names(details.created_by);
    if (creators.length) { result.creators = creators; result.creditsSource = source; }
    const asOf = validDate(options.asOf ?? new Date().toISOString().slice(0, 10));
    if (asOf && Array.isArray(details.seasons)) {
      const aired = new Set(details.seasons.filter(season => Number.isSafeInteger(season?.season_number) && season.season_number > 0
        && validDate(season.air_date) && season.air_date <= asOf).map(season => season.season_number));
      if (aired.size) { result.seasonCount = aired.size; result.seasonCountAsOf = asOf; }
    }
    const lastAir = validDate(details.last_air_date), firstAir = validDate(details.first_air_date);
    if (asOf && ["Ended", "Canceled"].includes(details.status) && lastAir && firstAir && lastAir >= firstAir && lastAir <= asOf) result.endYear = Number(lastAir.slice(0, 4));
  }
  return result;
}
