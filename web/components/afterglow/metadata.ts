"use client";

import { useEffect, useState } from 'react';
import { titleOf, type Movie, type TitleDetails } from './types';
import { selectTvmazeMatch, tvmazeDisplayDetails } from '../../lib/title-details.mjs';

type Catalog = { version: number; items: Record<string, TitleDetails> };
let catalog: Catalog | undefined;
let pending: Promise<Catalog> | undefined;
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
    // A poster can appear promptly; a later render adds known, aired seasons.
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
  useEffect(() => {
    if (catalog) { setDetails(catalog); return; }
    let alive = true;
    void loadCatalog().then(value => { if (alive) setDetails(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const overlay = details?.items[String(movie.movieId)];
  const enriched = overlay ? { ...movie, ...overlay, movieId: movie.movieId, mediaType: movie.mediaType } : movie;
  useEffect(() => {
    if (!details || enriched.mediaType !== 'series' || !enriched.year || (enriched.posterUrl && enriched.seasonCount)) return;
    let alive = true;
    void enrichSeries(enriched).then(value => { if (alive && value) setOnline({ movieId: movie.movieId, details: value }); }).catch(() => {});
    return () => { alive = false; };
  }, [details, movie.movieId, enriched.mediaType, enriched.year, enriched.posterUrl, enriched.seasonCount]);
  return online?.movieId === movie.movieId ? { ...enriched, ...online.details } : enriched;
}
