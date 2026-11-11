"use client";

import { useEffect, useSyncExternalStore } from 'react';
import { titleOf, type Movie, type TitleDetails } from './types';
import { selectTvmazeMatch, tvmazeDisplayDetails } from '../../lib/title-details.mjs';

type Catalog = { version: number; items: Record<string, TitleDetails> };
type Cached = { details: TitleDetails | null; expires: number };
export type ResolvedMovie = Movie & { posterFallbackUrls?: string[] };
let catalog: Catalog | undefined, staticTmdb: Catalog | undefined;
let catalogTask: Promise<unknown> | undefined, overlayTask: Promise<unknown> | undefined, overlayLoaded = false;
let version = 0, tmdbConfigured: boolean | null = null, configurationExpires = 0, staticTmdbUsed = false;
let configurationTimer: ReturnType<typeof setTimeout> | undefined, flushTimer: ReturnType<typeof setTimeout> | undefined, activeBatches = 0;
const listeners = new Set<() => void>();
const results = new Map<number, Cached>(), pending = new Map<number, Promise<TitleDetails | null>>();
const queue = new Map<number, (details: TitleDetails | null) => void>();
const seriesDetails = new Map<number, TitleDetails | null>(), seriesPending = new Map<number, Promise<TitleDetails | null>>();
const warmedImages = new Set<string>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish() { version++; for (const listener of listeners) listener(); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeUrl(value: unknown, host: string) { try { const url = new URL(String(value)); return url.protocol === 'https:' && url.host === host && !url.username && !url.password && !url.search && !url.hash ? url.href : undefined; } catch { return undefined; } }

/** The overlay and API may carry only public display fields, never raw scores. */
function tmdbDisplayOnly(value: unknown): TitleDetails | null {
  if (!record(value)) return null;
  const out: TitleDetails = {};
  for (const key of ['displayTitle', 'alternateTitle'] as const) if (typeof value[key] === 'string' && value[key].trim()) out[key] = value[key].trim().slice(0, 400);
  const poster = safeUrl(value.posterUrl, 'image.tmdb.org');
  if (poster && /^\/t\/p\/(?:w342|w500)\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(new URL(poster).pathname)) out.posterUrl = poster;
  for (const key of ['cast', 'directors', 'creators'] as const) if (Array.isArray(value[key])) {
    const names = [...new Set(value[key].filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim().slice(0, 150)))].slice(0, 16);
    if (names.length) out[key] = names;
  }
  if (Number.isInteger(value.seasonCount) && Number(value.seasonCount) > 0 && Number(value.seasonCount) <= 1000) out.seasonCount = Number(value.seasonCount);
  if (typeof value.seasonCountAsOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.seasonCountAsOf)) out.seasonCountAsOf = value.seasonCountAsOf;
  if (Number.isInteger(value.endYear) && Number(value.endYear) >= 1800 && Number(value.endYear) <= new Date().getFullYear() + 1) out.endYear = Number(value.endYear);
  for (const key of ['metadataSource', 'creditsSource'] as const) if (record(value[key])) {
    const url = safeUrl(value[key].url, 'www.themoviedb.org');
    if (value[key].name === 'TMDB' && url && /^\/(?:movie|tv)\/[1-9]\d*\/?$/.test(new URL(url).pathname)) out[key] = { name: 'TMDB', url };
  }
  return Object.keys(out).length ? out : null;
}

function configured(value: boolean) {
  const changed = tmdbConfigured !== value;
  tmdbConfigured = value;
  configurationExpires = value ? Infinity : Date.now() + 45000;
  if (configurationTimer) clearTimeout(configurationTimer);
  if (!value && typeof window !== 'undefined') configurationTimer = setTimeout(() => { tmdbConfigured = null; publish(); }, 45050);
  if (changed) publish();
}
export function useTmdbEnabled() { return useSyncExternalStore(subscribe, () => staticTmdbUsed || tmdbConfigured === true, () => false); }

function loadCatalogs() {
  if (!catalog && !catalogTask) catalogTask = fetch('/catalog/title-details.json', { credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('Title details are unavailable.');
    const value = await response.json() as Catalog;
    if (value.version !== 1 || !record(value.items)) throw new Error('Invalid title details.');
    catalog = value; publish();
  }).catch(error => { catalogTask = undefined; throw error; });
  if (!overlayLoaded && !overlayTask) overlayTask = fetch('/catalog/title-details-tmdb.json', { credentials: 'same-origin' }).then(async response => {
    if (response.status === 404) { overlayLoaded = true; return; }
    if (!response.ok) throw new Error('Additional artwork is unavailable.');
    const value: unknown = await response.json();
    if (!record(value) || value.version !== 1 || value.provider !== 'TMDB' || !record(value.items)) throw new Error('Invalid artwork catalog.');
    const items: Record<string, TitleDetails> = {};
    for (const [id, candidate] of Object.entries(value.items)) if (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) { const details = tmdbDisplayOnly(candidate); if (details) items[id] = details; }
    staticTmdb = { version: 1, items }; overlayLoaded = true; publish();
  }).catch(error => { overlayTask = undefined; throw error; });
  return Promise.allSettled([catalogTask, overlayTask]);
}

function scheduleFlush() { if (!flushTimer && activeBatches < 2 && queue.size) flushTimer = setTimeout(flush, 35); }
function flush() {
  flushTimer = undefined;
  while (queue.size && activeBatches < 2) {
    const group = [...queue.entries()].slice(0, 6); for (const [id] of group) queue.delete(id);
    activeBatches++;
    void fetchBatch(group).finally(() => { activeBatches--; scheduleFlush(); });
  }
}
async function fetchBatch(group: [number, (details: TitleDetails | null) => void][]) {
  const received = new Map<number, TitleDetails | null>();
  const partialArtwork = new Set<number>();
  let unresolved = group.map(([id]) => id), temporary = false;
  for (let attempt = 0; attempt < 2 && unresolved.length; attempt++) {
    if (attempt) await pause(650);
    try {
      const response = await fetch(`/api/title-details?ids=${unresolved.join(',')}`, { credentials: 'same-origin', signal: AbortSignal.timeout(16000) });
      if (!response.ok) throw new Error('Artwork is unavailable.');
      const value: unknown = await response.json();
      if (!record(value) || typeof value.configured !== 'boolean' || !record(value.items)) throw new Error('Invalid artwork response.');
      temporary = value.unavailable === true;
      if (value.configured || !temporary) configured(value.configured);
      const retry: number[] = [];
      for (const id of unresolved) {
        const incoming = tmdbDisplayOnly(value.items[String(id)]);
        const previous = received.get(id);
        const details = incoming ? { ...previous, ...incoming } : previous || null;
        const retryPoster = temporary && !details?.posterUrl;
        if (retryPoster) partialArtwork.add(id);
        else if (details?.posterUrl) partialArtwork.delete(id);
        if (details || !temporary) { received.set(id, details); results.set(id, { details, expires: partialArtwork.has(id) ? Date.now() + 30000 : value.configured ? Date.now() + (details ? 3600000 : 900000) : configurationExpires }); }
        if (retryPoster) retry.push(id);
      }
      unresolved = retry;
      if (!value.configured && !temporary) {
        for (const [id, resolve] of queue) { results.set(id, { details: null, expires: configurationExpires }); resolve(null); } queue.clear();
      }
    } catch { temporary = true; }
  }
  for (const [id, resolve] of group) { const details = received.get(id) || null; if (!received.has(id) || partialArtwork.has(id)) results.set(id, { details, expires: Date.now() + 30000 }); resolve(details); }
  publish();
}
function tmdbDetails(id: number): Promise<TitleDetails | null> {
  const saved = results.get(id); if (saved && saved.expires > Date.now()) return Promise.resolve(saved.details);
  if (tmdbConfigured === false && configurationExpires > Date.now()) return Promise.resolve(null);
  const existing = pending.get(id); if (existing) return existing;
  const task = new Promise<TitleDetails | null>(resolve => { queue.set(id, resolve); }).finally(() => { pending.delete(id); });
  pending.set(id, task); scheduleFlush(); return task;
}

let requestTail: Promise<unknown> = Promise.resolve(), lastRequest = 0;
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
function publicTvmaze(path: string): Promise<unknown> {
  const task = requestTail.catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(Math.max(0, 700 - (Date.now() - lastRequest))); lastRequest = Date.now();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`https://api.tvmaze.com${path}`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        if (response.status === 429) { await response.body?.cancel(); await pause((attempt + 1) * 2000); continue; }
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new Error('Series details are temporarily unavailable.'); }
        return await response.json() as unknown;
      } finally { clearTimeout(timer); }
    }
    throw new Error('Series details are temporarily unavailable.');
  }); requestTail = task; return task;
}
function enrichSeries(movie: Movie): Promise<TitleDetails | null> {
  if (seriesDetails.has(movie.movieId)) return Promise.resolve(seriesDetails.get(movie.movieId) || null);
  const existing = seriesPending.get(movie.movieId); if (existing) return existing;
  const task = (async () => {
    const target = { title: titleOf(movie), alternateTitle: movie.alternateTitle, year: movie.year };
    let candidates = await publicTvmaze(`/search/shows?q=${encodeURIComponent(target.title)}`), match = selectTvmazeMatch(candidates, target);
    if (!match && target.alternateTitle && target.alternateTitle !== target.title) { candidates = await publicTvmaze(`/search/shows?q=${encodeURIComponent(target.alternateTitle)}`); match = selectTvmazeMatch(candidates, target); }
    if (!match) { seriesDetails.set(movie.movieId, null); return null; }
    let seasons: unknown = null; try { seasons = await publicTvmaze(`/shows/${match.id}/seasons`); } catch { /* Verified artwork is still useful. */ }
    const details = tvmazeDisplayDetails(match, seasons); seriesDetails.set(movie.movieId, details); publish(); return details;
  })().finally(() => { seriesPending.delete(movie.movieId); }); seriesPending.set(movie.movieId, task); return task;
}

function resolved(movie: Movie): ResolvedMovie {
  const base = catalog?.items[String(movie.movieId)], offline = staticTmdb?.items[String(movie.movieId)];
  const online = results.get(movie.movieId)?.details, tvmaze = seriesDetails.get(movie.movieId);
  const merged = { ...movie, ...base, ...tvmaze, ...online, ...offline, movieId: movie.movieId, mediaType: movie.mediaType };
  const primary = merged.posterUrl;
  const alternatives = [tvmaze?.posterUrl, base?.posterUrl, movie.posterUrl].filter((url): url is string => Boolean(url && url !== primary && safeUrl(url, 'static.tvmaze.com')));
  return { ...merged, ...(alternatives.length ? { posterFallbackUrls: [...new Set(alternatives)] } : {}) };
}
async function ensureDetails(movie: Movie, onDetails?: () => void) {
  await loadCatalogs();
  onDetails?.();
  if (movie.mediaType === 'other') return;
  const offline = staticTmdb?.items[String(movie.movieId)];
  if (offline && !staticTmdbUsed) { staticTmdbUsed = true; publish(); }
  const current = resolved(movie);
  const complete = current.posterUrl && (current.cast?.length || current.directors?.length || current.creators?.length) && (movie.mediaType !== 'series' || current.seasonCount);
  if (!offline?.posterUrl && !complete) await tmdbDetails(movie.movieId);
  onDetails?.();
  const preferred = resolved(movie);
  if (preferred.mediaType === 'series' && preferred.year && (!preferred.posterUrl || !preferred.seasonCount)) await enrichSeries(preferred).catch(() => {});
}
function warmPoster(movie: Movie) {
  const url = resolved(movie).posterUrl; if (!url || typeof Image === 'undefined' || warmedImages.has(url)) return;
  warmedImages.add(url); const image = new Image(); image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.src = url;
}
/** Prefetch public details and image bytes only; user scores never enter this path. */
export function prefetchTitleDetails(movies: Movie[]) { for (const movie of movies.slice(0, 3)) void ensureDetails(movie, () => warmPoster(movie)).then(() => warmPoster(movie)).catch(() => {}); }

/** Shared display-only data across cards, editors and search. */
export function useTitleDetails(movie: Movie): ResolvedMovie {
  const changed = useSyncExternalStore(subscribe, () => version, () => 0);
  useEffect(() => { void ensureDetails(movie).catch(() => {}); }, [movie.movieId, movie.mediaType, changed]);
  return resolved(movie);
}
