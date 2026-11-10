/** Public catalog matching only. This module never accepts ratings or user data. */

/** @param {unknown} value */
export function normalizedTitle(value) {
  return typeof value === "string" ? value.normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]/gu, "") : "";
}

/** @param {unknown} value */
function dateYear(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Number(value.slice(0, 4)) : null;
}

/** Require one exact normalized title and premiere-year match. Ambiguity fails closed.
 * @param {unknown} candidates
 * @param {{title:string,alternateTitle?:string,year:number|null}} target
 * @returns {any|null}
 */
export function selectTvmazeMatch(candidates, target) {
  if (!Array.isArray(candidates) || !Number.isInteger(target.year) || Number(target.year) < 1800) return null;
  const titles = new Set([target.title, target.alternateTitle].map(normalizedTitle).filter(Boolean));
  const matches = new Map();
  for (const candidate of candidates) {
    const show = candidate?.show ?? candidate;
    if (show && Number.isSafeInteger(show.id) && show.id > 0 && dateYear(show.premiered) === target.year
        && titles.has(normalizedTitle(show.name))) matches.set(show.id, show);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

/** @param {unknown} value @param {string} host */
function safeUrl(value, host) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === host && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** @typedef {{posterUrl?:string,seasonCount?:number,seasonCountAsOf?:string,endYear?:number,tvmazeId?:number,metadataSource?:{name:string,url:string}}} TvmazeDetails */

/** Whitelist display fields; TVmaze community ratings are deliberately omitted.
 * @param {any} show @param {unknown} [seasons] @param {string} [asOf]
 * @returns {TvmazeDetails}
 */
export function tvmazeDisplayDetails(show, seasons, asOf = new Date().toISOString().slice(0, 10)) {
  if (!show || !Number.isSafeInteger(show.id) || show.id < 1) return {};
  const url = safeUrl(show.url, "www.tvmaze.com");
  if (!url || !new URL(url).pathname.startsWith(`/shows/${show.id}/`)) return {};
  /** @type {TvmazeDetails} */
  const result = { tvmazeId: show.id, metadataSource: { name: "TVmaze", url } };
  const posterUrl = safeUrl(show.image?.medium || show.image?.original, "static.tvmaze.com");
  if (posterUrl) result.posterUrl = posterUrl;
  const endYear = dateYear(show.ended), startYear = dateYear(show.premiered);
  if (endYear && startYear && endYear >= startYear) result.endYear = endYear;
  if (Array.isArray(seasons)) {
    const numbers = new Set(seasons.filter(season => Number.isSafeInteger(season?.number) && season.number > 0
      && dateYear(season.premiereDate) !== null && season.premiereDate <= asOf).map(season => season.number));
    if (numbers.size) { result.seasonCount = numbers.size; result.seasonCountAsOf = asOf; }
  }
  return result;
}
