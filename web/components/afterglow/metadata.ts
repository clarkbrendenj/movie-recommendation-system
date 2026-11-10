"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import { titleOf, type Movie, type TitleDetails } from './types';
import { selectTvmazeMatch, tvmazeDisplayDetails } from '../../lib/title-details.mjs';

type Catalog = { version: number; items: Record<string, TitleDetails> };
let catalog: Catalog | undefined;
let pending: Promise<Catalog> | undefined;
let tmdbConfigured: boolean | null = null, tmdbFlush: ReturnType<typeof setTimeout> | undefined, tmdbLoading = false;
const tmdbListeners = new Set<() => void>();
const tmdbResults = new Map<number, TitleDetails | null>();
const tmdbPending = new Map<number, Promise<TitleDetails | null>>();
const tmdbQueue = new Map<number, (details: TitleDetails | null) => void>();

function setTmdbConfigured(value: boolean) {
  if (value === tmdbConfigured) return;
  tmdbConfigured = value;
  for (const listener of tmdbListeners) listener();
}
const subscribeTmdb = (listener: () => void) => { tmdbListeners.add(listener); return () => { tmdbListeners.delete(listener); }; };
export function useTmdbEnabled() { return useSyncExternalStore(subscribeTmdb, () => tmdbConfigured === true, () => false); }

async function flushTmdb() {
  tmdbFlush = undefined;
  if (tmdbLoading || !tmdbQueue.size) return;
  tmdbLoading = true;
  const group = [...tmdbQueue.entries()].slice(0, 6);
  for (const [id] of group) tmdbQueue.delete(id);
  try {
    const response = await fetch(`/api/title-details?ids=${group.map(([id]) => id).join(',')}`, { credentials: 'omit', signal: AbortSignal.timeout(16000) });
    if (!response.ok) throw new Error('Artwork is unavailable.');
    const value = await response.json() as { configured: boolean; unavailable?: boolean; items: Record<string, TitleDetails> };
    if (typeof value.configured !== 'boolean' || !value.items) throw new Error('Invalid artwork response.');
    if (value.configured || !value.unavailable) setTmdbConfigured(value.configured);
    for (const [id, resolve] of group) { const item = value.items[String(id)] || null; if (item || !value.unavailable) tmdbResults.set(id, item); resolve(item); }
    if (!value.configured && !value.unavailable) {
      for (const [id, resolve] of tmdbQueue) { tmdbResults.set(id, null); resolve(null); }
      tmdbQueue.clear();
    }
  } catch {
    for (const [, resolve] of group) resolve(null);
  } finally {
    tmdbLoading = false;
    if (tmdbQueue.size) tmdbFlush = setTimeout(() => void flushTmdb(), 35);
  }
}

function tmdbDetails(id: number): Promise<TitleDetails | null> {
  if (tmdbResults.has(id)) return Promise.resolve(tmdbResults.get(id) || null);
  if (tmdbConfigured === false) return Promise.resolve(null);
  const existing = tmdbPending.get(id);
  if (existing) return existing;
  const task = new Promise<TitleDetails | null>(resolve => { tmdbQueue.set(id, resolve); }).finally(() => { tmdbPending.delete(id); });
  tmdbPending.set(id, task);
  if (!tmdbFlush && !tmdbLoading) tmdbFlush = setTimeout(() => void flushTmdb(), 35);
  return task;
}
const seriesDetails = new Map<number, TitleDetails | null>();
const seriesPending = new Map<number, Promise<TitleDetails | null>>();
// One bounded public request at a time, shared by the grid and rating editor.
// Only title names/years go to TVmaze; account data and scores stay in Afterglow.
let requestTail: Promise<unknown> = Promise.resolve(), lastRequest = 0;
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function publicTvmaze(path: string): Promise<unknown> {
  const task = requestTail.catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(Math.max(0, 700 - (Date.now() - lastRequest)));
      lastRequest = Date.now();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`https://api.tvmaze.com${path}`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        if (response.status === 429) { await response.body?.cancel(); await pause((attempt + 1) * 2000); continue; }
        if (!response.ok) { await response.body?.cancel(); return null; }
        return await response.json() as unknown;
      } finally { clearTimeout(timer); }
    }
    return null;
  });
  requestTail = task;
  return task;
}

function enrichSeries(movie: Movie): Promise<TitleDetails | null> {
  if (seriesDetails.has(movie.movieId)) return Promise.resolve(seriesDetails.get(movie.movieId) || null);
  const current = seriesPending.get(movie.movieId);
  if (current) return current;
  const task = (async () => {
    const target = { title: titleOf(movie), alternateTitle: movie.alternateTitle, year: movie.year };
    let candidates = await publicTvmaze(`/search/shows?q=${encodeURIComponent(target.title)}`);
    let match = selectTvmazeMatch(candidates, target);
    if (!match && target.alternateTitle && target.alternateTitle !== target.title) {
      candidates = await publicTvmaze(`/search/shows?q=${encodeURIComponent(target.alternateTitle)}`);
      match = selectTvmazeMatch(candidates, target);
    }
    if (!match) { seriesDetails.set(movie.movieId, null); return null; }
    // Retain verified artwork even when season information is unavailable.
    let seasons: unknown = null;
    try { seasons = await publicTvmaze(`/shows/${match.id}/seasons`); } catch { /* Preserve the verified artwork even if this optional lookup fails. */ }
    const details = tvmazeDisplayDetails(match, seasons);
    seriesDetails.set(movie.movieId, details);
    return details;
  })().finally(() => { seriesPending.delete(movie.movieId); });
  seriesPending.set(movie.movieId, task);
  return task;
}

function loadCatalog() {
  if (!pending) pending = fetch('/catalog/title-details.json', { credentials: 'omit' })
    .then(async response => {
      if (!response.ok) throw new Error('Title details are unavailable.');
      const value = await response.json() as Catalog;
      if (value.version !== 1 || !value.items || typeof value.items !== 'object') throw new Error('Invalid title details.');
      catalog = value;
      return value;
    }).catch(error => { pending = undefined; throw error; });
  return pending;
}

/** Shared public metadata only. Missing artwork or enrichment never blocks a rating. */
export function useTitleDetails(movie: Movie): Movie {
  const [details, setDetails] = useState(catalog);
  const [online, setOnline] = useState<{ movieId: number; details: TitleDetails } | null>(null);
  const [tmdb, setTmdb] = useState<{ movieId: number; details: TitleDetails | null } | null>(null);
  useEffect(() => {
    if (movie.mediaType === 'other') return;
    let alive = true;
    void tmdbDetails(movie.movieId).then(value => { if (alive) setTmdb({ movieId: movie.movieId, details: value }); });
    return () => { alive = false; };
  }, [movie.movieId, movie.mediaType]);
  useEffect(() => {
    if (catalog) { setDetails(catalog); return; }
    let alive = true;
    void loadCatalog().then(value => { if (alive) setDetails(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const overlay = details?.items[String(movie.movieId)];
  const enriched = overlay ? { ...movie, ...overlay, movieId: movie.movieId, mediaType: movie.mediaType } : movie;
  const preferred = tmdb?.movieId === movie.movieId && tmdb.details ? { ...enriched, ...tmdb.details } : enriched;
  useEffect(() => {
    if (!details || tmdb?.movieId !== movie.movieId || preferred.mediaType !== 'series' || !preferred.year || (preferred.posterUrl && preferred.seasonCount)) return;
    let alive = true;
    void enrichSeries(preferred).then(value => { if (alive && value) setOnline({ movieId: movie.movieId, details: value }); }).catch(() => {});
    return () => { alive = false; };
  }, [details, tmdb, movie.movieId, preferred.mediaType, preferred.year, preferred.posterUrl, preferred.seasonCount]);
  const withFallback = online?.movieId === movie.movieId ? { ...enriched, ...online.details } : enriched;
  return tmdb?.movieId === movie.movieId && tmdb.details ? { ...withFallback, ...tmdb.details } : withFallback;
}
