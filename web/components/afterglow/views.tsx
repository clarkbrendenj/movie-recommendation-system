"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, EyeOff, Search, SkipForward, Star, X } from "lucide-react";
import { api, message, titleOf, type MediaType, type Movie, type MoviePage, type Recommendations, type Tab, type User } from "./types";
import { prefetchTitleDetails } from "./metadata";
import { useTitleActivity } from "./activity";
import { useCollectionView } from "./collection-view";
import { CollectionQueryControls, useCollectionQuery } from "./collection-query";
import { AuthGate, Busy, Empty, ErrorNotice, Modal, MovieGrid, MovieTable, Poster, RatingEditor, Segments, SkeletonGrid, useDebounced } from "./ui";

export function DiscoverScreen({ kind, user, ratings, onRate, onAdd, onNavigate, revision }: { kind: 'movies' | 'series'; user: User | null; ratings: Map<number, number>; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onNavigate: (tab: Tab) => void; revision: number }) {
  const [data, setData] = useState<Recommendations | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(''); api<Recommendations>(`/api/recommendations?type=${kind}&limit=12`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch(failure => { if (!controller.signal.aborted) setError(message(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [kind, user?.id, revision, retry]);
  return <><div className="page-intro"><div><span className="eyebrow">{kind === 'movies' ? 'THE FEATURE PRESENTATION' : 'ONE MORE EPISODE, PLEASE'}</span><h1>{kind === 'movies' ? 'Make tonight a movie night.' : 'Your next great series.'}</h1><p>{data?.mode === 'personalized' ? 'A selection shaped by your favorites and highly rated stories.' : kind === 'series' ? 'A starting selection of whole series. Rate a few favorites to make it yours.' : 'A starting selection of memorable movies. Your ratings make it personal.'}</p></div><button className="button outline-button" onClick={() => onNavigate(kind === 'movies' ? 'rate-movies' : 'rate-series')}><Star size={16} />Rate {kind === 'movies' ? 'movies' : 'series'}</button></div><div className="marquee-line"><span>NOW SHOWING</span><i /><span>{kind === 'movies' ? 'MOVIES FOR YOU' : 'SERIES FOR YOU'}</span><i /><span>{user ? `A SELECTION FOR ${user.displayName.toUpperCase()}` : 'YOUR NEXT FAVORITE IS WAITING'}</span></div>{error ? <ErrorNotice text={error} retry={() => setRetry(value => value + 1)} /> : loading ? <SkeletonGrid /> : data?.movies.length ? <MovieGrid movies={data.movies} ratings={ratings} onRate={onRate} onAdd={onAdd} /> : <Empty title="A fresh selection starts with you." action={<button className="button burgundy-button" onClick={() => onNavigate(kind === 'movies' ? 'rate-movies' : 'rate-series')}>Find something to rate <ArrowRight size={16} /></button>}>Add a few more ratings and discover another corner of the catalog.</Empty>}</>;
}

export function RatingScreen({ kind, user, ratings, onAuth, onAdd, onToast, overlayOpen = false }: { kind: 'movies' | 'series'; user: User | null; ratings: Map<number, number>; onAuth: () => void; onAdd: (movie: Movie) => void; onToast: (text: string) => void; overlayOpen?: boolean }) {
  const [queue, setQueue] = useState<Movie[]>([]), [current, setCurrent] = useState<Movie | null>(null), [value, setValue] = useState(5), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState(''), [results, setResults] = useState<Movie[]>([]), [searchLoading, setSearchLoading] = useState(false), [searchError, setSearchError] = useState('');
  const activity = useTitleActivity();
  const { view } = useCollectionView();
  const [compactEditorOpen, setCompactEditorOpen] = useState(false);
  const [confirmUnseen, setConfirmUnseen] = useState(false);
  const isBusy = busy || Boolean(current && activity.pending.has(current.movieId));
  const consumed = useRef(new Set<number>()), generation = useRef(0), alive = useRef(true), mutating = useRef(false), queueRef = useRef(queue), currentRef = useRef(current);
  queueRef.current = queue; currentRef.current = current;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (overlayOpen || view !== 'compact') setCompactEditorOpen(false); }, [overlayOpen, view]);
  // Inline row edits live in the shared draft map. Restore the current draft
  // when switching back to the full poster view or selecting its next title.
  useEffect(() => {
    if (view === 'posters' && current) {
      const draft = activity.draftRatings.get(current.movieId);
      if (draft !== undefined) setValue(draft);
    }
  }, [view, current?.movieId]);
  const settled = useDebounced(query);
  const loadQueue = useCallback(async () => {
    const turn = ++generation.current; setLoading(true); setError('');
    try { const exclude = [...consumed.current].slice(-200).join(','); const data = await api<{ movies: Movie[]; remaining: number }>(`/api/rating-queue?type=${kind}&limit=12&exclude=${exclude}`); if (turn !== generation.current) return; const fresh = data.movies.filter(movie => !consumed.current.has(movie.movieId)); setQueue(fresh); setCurrent(fresh[0] || null); setValue(5); }
    catch (failure) { if (turn === generation.current) setError(message(failure)); }
    finally { if (turn === generation.current) setLoading(false); }
  }, [kind, user?.id]);
  useEffect(() => { consumed.current = new Set(); setCurrent(null); setQuery(''); void loadQueue(); return () => { generation.current++; }; }, [loadQueue]);
  useEffect(() => { prefetchTitleDetails(queue.filter(movie => movie.movieId !== current?.movieId && !consumed.current.has(movie.movieId)).slice(0, 3)); }, [queue, current?.movieId]);
  useEffect(() => {
    if (loading || !queue.length || queue.length > 3) return;
    const controller = new AbortController(), turn = generation.current;
    const excluded = [...new Set([...consumed.current, ...queue.map(movie => movie.movieId)])].slice(-200).join(',');
    api<{ movies: Movie[] }>(`/api/rating-queue?type=${kind}&limit=12&exclude=${excluded}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted || !alive.current || turn !== generation.current) return;
      setQueue(previous => { const existing = new Set(previous.map(movie => movie.movieId)); const fresh = data.movies.filter(movie => !consumed.current.has(movie.movieId) && !existing.has(movie.movieId)); return fresh.length ? [...previous, ...fresh] : previous; });
    }).catch(() => { /* Keep the current title; a normal queue load can be retried if needed. */ });
    return () => controller.abort();
  }, [kind, loading, queue]);
  useEffect(() => {
    if (!settled.trim()) { setResults([]); setSearchError(''); setSearchLoading(false); return; }
    const controller = new AbortController(); setSearchLoading(true); setSearchError('');
    api<MoviePage>(`/api/movies?type=${kind}&q=${encodeURIComponent(settled)}&page=1`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setResults(data.movies); }).catch(failure => { if (!controller.signal.aborted) setSearchError(message(failure)); }).finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    return () => controller.abort();
  }, [kind, settled]);
  function choose(movie: Movie) {
    if (mutating.current || isBusy) return;
    setConfirmUnseen(false); generation.current++; setLoading(false);
    if (view !== 'compact' && current && current.movieId !== movie.movieId) consumed.current.add(current.movieId);
    const draft = activity.draftRatings.get(movie.movieId);
    if (draft !== undefined || current?.movieId !== movie.movieId) setValue(draft ?? ratings.get(movie.movieId) ?? 5);
    currentRef.current = movie; setCurrent(movie); setQuery(''); setError('');
    if (view === 'compact') setCompactEditorOpen(true);
  }
  function consumeTitle(movieId: number) {
    consumed.current.add(movieId);
    const remaining = queueRef.current.filter(movie => !consumed.current.has(movie.movieId));
    queueRef.current = remaining; setQueue(remaining);
    if (!currentRef.current || consumed.current.has(currentRef.current.movieId)) {
      const next = remaining[0] || null;
      currentRef.current = next; setCurrent(next); setConfirmUnseen(false);
      setValue(next ? activity.draftRatings.get(next.movieId) ?? ratings.get(next.movieId) ?? 5 : 5);
      if (!next) void loadQueue();
    }
  }
  function advance() { if (currentRef.current) consumeTitle(currentRef.current.movieId); }
  function inlineSaved(movie: Movie, rating: number) {
    if (!alive.current) return;
    consumeTitle(movie.movieId); setError('');
    onToast(`Saved ${rating.toFixed(1)} / 10 for ${titleOf(movie)}.`);
  }
  function changeScore(rating: number) {
    setValue(rating);
    if (currentRef.current) activity.setDraftRating(currentRef.current.movieId, rating);
  }
  async function save() {
    if (!current || mutating.current || isBusy) return;
    if (!user) { setCompactEditorOpen(false); onAuth(); return; }
    mutating.current = true; setBusy(true); setError('');
    try { if (!await activity.saveRating(current.movieId, value) || !alive.current) return; advance(); onToast(`Saved ${value.toFixed(1)} / 10. On to the next story.`); }
    catch (failure) { if (alive.current) setError(message(failure)); }
    finally { mutating.current = false; if (alive.current) setBusy(false); }
  }
  async function skip(status: 'skip' | 'unseen', confirmed = false) {
    if (!current || mutating.current || isBusy) return;
    if (status === 'unseen' && ratings.has(current.movieId) && !confirmed) { setConfirmUnseen(true); return; }
    mutating.current = true; setBusy(true); setError('');
    try {
      if (user) {
        if (status === 'unseen') { if (!await activity.updateState(current.movieId, { watched: false })) return; }
        else await api('/api/rating-queue', { method: 'POST', body: JSON.stringify({ movieId: current.movieId, status }) });
      } else onToast('Skipped for this visit. Sign in to remember your skipped titles.');
      if (alive.current) advance();
    } catch (failure) { if (alive.current) setError(message(failure)); }
    finally { mutating.current = false; if (alive.current) setBusy(false); }
  }
  const compactQueue = current ? [current, ...queue.filter(movie => movie.movieId !== current.movieId && !consumed.current.has(movie.movieId))] : queue;
  const ratingContent = current && <><RatingEditor key={current.movieId} movie={current} value={value} onChange={changeScore} busy={isBusy} user={user} onSave={() => void save()} onAdd={() => { setCompactEditorOpen(false); onAdd(current); }} next><div className="queue-actions"><button className="button soft-button" onClick={() => void skip('skip')} disabled={isBusy}><SkipForward size={16} />Skip for now</button><button className="button soft-button" onClick={() => void skip('unseen')} disabled={isBusy}><EyeOff size={16} />Haven’t seen it</button></div>{confirmUnseen && <div className="title-action-confirm queue-unseen-confirm" role="group" aria-label="Confirm removing the accidental rating"><p>This removes your rating and marks this title unwatched. Your Favorite stays as it is.</p><button className="button outline-button title-action-remove" onClick={() => void skip('unseen', true)} disabled={isBusy}>Remove rating &amp; next</button><button className="text-button" onClick={() => setConfirmUnseen(false)} disabled={isBusy}>Keep my rating</button></div>}</RatingEditor><div className="rating-stage-footnote"><span>YOUR OPINION GETS THE SPOTLIGHT.</span><p>Skipping is never a dislike. “Skip for now” returns later; unseen titles stay out of the rating queue until you search for them.</p></div></>;
  return <><div className="page-intro"><div><span className="eyebrow">YOUR HONEST TAKE, ONE TITLE AT A TIME</span><h1>{kind === 'movies' ? 'How was the movie?' : 'How was the whole series?'}</h1><p>{view === 'compact' ? 'Use the slider and Save button in each row. Hover a poster or title for a larger cover.' : 'Move the fader, find your feeling, and save. We’ll bring you another title.'}</p></div><span className="mode-stamp"><Star size={18} />RATING MODE</span></div>
    <label className="search-box queue-search"><Search size={19} /><span className="sr-only">Find a {kind === 'movies' ? 'movie' : 'series'} to rate</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} disabled={isBusy} placeholder={`Looking for a particular ${kind === 'movies' ? 'movie' : 'series'}? Search here…`} /><button className="icon-button" aria-label="Clear title search" onClick={() => setQuery('')} hidden={!query} disabled={isBusy}><X size={17} /></button></label>
    {settled && <div className="queue-search-results">{searchLoading ? <Busy text="Finding that title…" /> : searchError ? <ErrorNotice text={searchError} /> : results.length ? <><div className="search-result-heading"><span>CHOOSE A TITLE TO RATE</span><button className="text-button" onClick={() => setQuery('')} disabled={isBusy}>Back to the queue</button></div>{view === 'compact' ? <MovieTable movies={results} ratings={ratings} onRate={choose} onAdd={onAdd} onInlineSaved={inlineSaved} disabled={isBusy} caption="Rating search results" /> : <div className="search-results-list">{results.map(movie => <button key={movie.movieId} onClick={() => choose(movie)} disabled={isBusy}><span className="rating-search-title"><span className="rating-search-poster"><Poster movie={movie} /></span><span>{titleOf(movie)} <small>{movie.year || ''}</small></span></span><span>{ratings.has(movie.movieId) ? 'Edit your rating' : 'Rate this'} <ArrowRight size={15} /></span></button>)}</div>}</> : <p className="quiet-copy">No matching titles. Try another name.</p>}</div>}
    {error && <ErrorNotice text={error} retry={current ? undefined : () => void loadQueue()} />}
    {loading ? <Busy text="Choosing your next title…" /> : current ? view === 'compact' ? <>
      {!settled && <section aria-label="Titles waiting for a rating"><div className="compact-queue-heading"><p className="quiet-copy">Your rating queue · Adjust a score and save in its row.</p><button type="button" className="button outline-button" onClick={() => choose(current)} disabled={isBusy}>Open full editor <ArrowRight size={16} /></button></div><MovieTable movies={compactQueue} ratings={ratings} onRate={choose} onAdd={onAdd} onInlineSaved={inlineSaved} currentMovieId={current.movieId} disabled={isBusy} caption="Titles waiting for your rating" /></section>}
      {compactEditorOpen && !overlayOpen && <Modal key={current.movieId} title={`Rate ${titleOf(current)}`} onClose={() => setCompactEditorOpen(false)} busy={isBusy} wide><div className="compact-rating-modal">{error && <ErrorNotice text={error} />}{ratingContent}</div></Modal>}
    </> : <section className="rating-stage" aria-label="Rate the current title">{ratingContent}</section> : !error && <Empty title="You’ve reached the end of this queue.">Search for a title above, or come back later for another selection.</Empty>}
  </>;
}

export function RatingDialog({ movie, initial, user, onClose, onAuth, onAdd }: { movie: Movie; initial: number; user: User | null; onClose: () => void; onAuth: () => void; onAdd: () => void }) {
  const activity = useTitleActivity();
  const [value, setValue] = useState(() => activity.draftRatings.get(movie.movieId) ?? initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), mutating = useRef(false);
  const isBusy = busy || activity.pending.has(movie.movieId);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function changeScore(rating: number) { setValue(rating); activity.setDraftRating(movie.movieId, rating); }
  async function save() {
    if (mutating.current || isBusy) return;
    if (!user) { onAuth(); return; }
    mutating.current = true; setBusy(true); setError('');
    try { if (await activity.saveRating(movie.movieId, value) && alive.current) onClose(); }
    catch (failure) { if (alive.current) setError(message(failure)); }
    finally { mutating.current = false; if (alive.current) setBusy(false); }
  }
  return <Modal title={`Rate ${titleOf(movie)}`} onClose={onClose} busy={isBusy} wide><div className="dialog-rating"><RatingEditor movie={movie} value={value} onChange={changeScore} busy={isBusy} user={user} onSave={() => void save()} onAdd={onAdd} onRatingRemoved={onClose} />{error && <ErrorNotice text={error} />}</div></Modal>;
}

export function HistoryScreen({ user, ratings, revision, onAuth, onRate, onAdd }: { user: User | null; ratings: Map<number, number>; revision: number; onAuth: () => void; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void }) {
  const [items, setItems] = useState<Movie[]>([]), [kind, setKind] = useState<MediaType>('both'), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const activity = useTitleActivity();
  useEffect(() => { if (!user) { setItems([]); setLoading(false); return; } const controller = new AbortController(); const ids = [...ratings.keys()]; if (!ids.length) { setItems([]); setLoading(false); return; } setLoading(true); setError(''); const chunks = Array.from({ length: Math.ceil(ids.length / 24) }, (_, index) => ids.slice(index * 24, (index + 1) * 24)); Promise.all(chunks.map(chunk => api<MoviePage>(`/api/movies?type=both&ids=${chunk.join(',')}`, { signal: controller.signal }))).then(data => { if (!controller.signal.aborted) { const indexed = new Map(data.flatMap(page => page.movies).map(movie => [movie.movieId, movie])); setItems(ids.map(id => indexed.get(id)).filter((movie): movie is Movie => Boolean(movie))); } }).catch(failure => { if (!controller.signal.aborted) setError(message(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [user?.id, ratings, revision]);
  const sourceItems = useMemo(() => items.filter(movie => kind === 'both' || (kind === 'series' ? movie.mediaType === 'series' : !movie.mediaType || movie.mediaType === 'movie')), [items, kind]);
  const collectionQuery = useCollectionQuery(sourceItems, ratings, activity.states);
  return <><div className="page-intro"><div><span className="eyebrow">YOUR PERSONAL ARCHIVE</span><h1>Every take tells a story.</h1><p>Your ratings live here. Change your mind whenever the credits settle.</p></div><Segments value={kind} onChange={setKind} /></div>{!user ? <AuthGate onSignIn={onAuth} /> : error ? <ErrorNotice text={error} /> : loading ? <SkeletonGrid /> : sourceItems.length ? <><CollectionQueryControls query={collectionQuery} label="Sort and filter my ratings" /><p className="quiet-copy">Your saved scores are private.</p><MovieGrid movies={sourceItems} query={collectionQuery} ratings={ratings} onRate={onRate} onAdd={onAdd} /></> : <Empty title="Your first take is still to come.">Rate a movie or a whole series to start your own personal archive.</Empty>}</>;
}
