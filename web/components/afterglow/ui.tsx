"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, Clapperboard, Info, LoaderCircle, Star, Trash2, X } from "lucide-react";
import { api, message, mediaLabel, titleOf, type MediaType, type Movie, type User } from "./types";
import { useTitleDetails } from "./metadata";
import { RemoveRatingButton, TitleActions, useTitleActivity } from "./activity";
import { useCollectionView } from "./collection-view";
import { CollectionColumnHeading, CollectionQuerySummary, useCollectionQuery, type CollectionQuery } from "./collection-query";
import { APP_NAME, APP_TAGLINE } from "../../lib/app-brand.mjs";
import "./rating-experience.css";
import "./rating-editor-mobile.css";

const PALETTES = [["#5a2634", "#f4dfb7", "#b88c4e"], ["#233a3d", "#f5e8c8", "#a87945"], ["#74603c", "#fff1d0", "#391d26"], ["#30354b", "#eee2c2", "#ac7452"], ["#513c49", "#f8e8c3", "#c2a36f"], ["#3c4b3a", "#f2dfb7", "#ac654b"]];
export function useDebounced(value: string) { const [settled, setSettled] = useState(value); useEffect(() => { const timer = setTimeout(() => setSettled(value), 250); return () => clearTimeout(timer); }, [value]); return settled; }
export function usePhoneLayout() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px), (max-height: 500px) and (pointer: coarse)');
    const update = () => setPhone(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return phone;
}
export function ErrorNotice({ text, retry }: { text: string; retry?: () => void }) { return <div className="notice error-notice" role="alert"><span>{text}</span>{retry && <button onClick={retry}>Try again <ArrowRight size={15} /></button>}</div>; }
export function Busy({ text = "Setting the scene…" }: { text?: string }) { return <div className="busy-state" role="status"><LoaderCircle className="spinning" size={22} /><span>{text}</span></div>; }
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <div className="empty-state"><span className="empty-emblem"><Clapperboard size={30} strokeWidth={1.3} /></span><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function AuthGate({ onSignIn, title = "Your seat is waiting." }: { onSignIn: () => void; title?: string }) { return <Empty title={title} action={<button className="button gold-button" onClick={onSignIn}>Sign in or create an account <ArrowRight size={17} /></button>}>Keep your ratings, save a watchlist, and make a selection with the people you love watching with.</Empty>; }
export function Segments({ value, onChange }: { value: MediaType; onChange: (value: MediaType) => void }) { return <div className="segments" role="group" aria-label="Choose title type">{([['movies', 'Movies'], ['series', 'TV series'], ['both', 'Both']] as const).map(([kind, label]) => <button key={kind} aria-pressed={value === kind} className={value === kind ? 'active' : ''} onClick={() => onChange(kind)}>{label}</button>)}</div>; }

const modalStack: string[] = [];
let initialBodyOverflow = '';

export function Modal({ title, children, onClose, busy = false, wide = false, rating = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean; rating?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const modalId = useId();
  const closeRef = useRef(onClose), busyRef = useRef(busy);
  closeRef.current = onClose; busyRef.current = busy;
  useEffect(() => { setPortalHost(document.querySelector<HTMLElement>('.picture-house') || document.body); }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!modalStack.length) initialBodyOverflow = document.body.style.overflow;
    modalStack.push(modalId);
    document.body.style.overflow = 'hidden';
    function focusable() {
      return Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]') || [])
        .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    }
    const frame = requestAnimationFrame(() => { if (modalStack.at(-1) === modalId) focusable()[0]?.focus(); });
    function keydown(event: KeyboardEvent) {
      if (modalStack.at(-1) !== modalId) return;
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown);
      const index = modalStack.lastIndexOf(modalId); if (index >= 0) modalStack.splice(index, 1);
      if (!modalStack.length) document.body.style.overflow = initialBodyOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const content = <div className={`modal-backdrop ${rating ? 'rating-editor-backdrop' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget && !busy && modalStack.at(-1) === modalId) onClose(); }}><div className={`dialog ${wide ? 'dialog-wide' : ''} ${rating ? 'rating-editor-dialog' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}><button className="icon-button dialog-close" aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={20} /></button>{children}</div></div>;
  return portalHost ? createPortal(content, portalHost) : content;
}

export function Poster({ movie, large = false }: { movie: Movie; large?: boolean }) {
  const details = useTitleDetails(movie);
  movie = details;
  const [failedUrls, setFailedUrls] = useState(new Set<string>());
  const posterUrl = [movie.posterUrl, ...(details.posterFallbackUrls || [])].find((url): url is string => Boolean(url && !failedUrls.has(url)));
  const hash = [...movie.title].reduce((sum, char) => sum + char.charCodeAt(0), movie.movieId);
  const [background, ink, accent] = PALETTES[hash % PALETTES.length], title = titleOf(movie);
  const longest = Math.max(1, ...title.split(/\s+|[-–—]/).map(word => word.length));
  return <div className={`poster poster-${hash % 4} ${large ? 'poster-large' : ''}`} style={{ '--poster-bg': background, '--poster-ink': ink, '--poster-accent': accent, '--longest-word': longest * .72 } as CSSProperties} aria-hidden="true"><div className="poster-border" /><span className="poster-studio">MIDNIGHT THEATER</span><div className="poster-geometry"><i /><i /><i /></div><span className="poster-symbol">✦</span><span className={`poster-name ${title.length > 25 ? 'poster-name-long' : ''}`}>{title}</span><div className="poster-footer"><span>{movie.mediaType === 'series' ? 'TV SERIES' : 'MOVIE'}</span><span>{movie.year || '—'}</span></div>{posterUrl && <img key={posterUrl} className="poster-photo" src={posterUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrls(previous => new Set(previous).add(posterUrl))} />}</div>;
}
export function MovieCard({ movie, rating, onRate, onAdd, onRemove }: { movie: Movie; rating?: number; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onRemove?: () => void }) {
  movie = useTitleDetails(movie);
  return <article className="movie-card"><button className="poster-button" onClick={() => onRate(movie)} aria-label={`Rate ${titleOf(movie)}`}><Poster movie={movie} /><span className="poster-action"><Star size={18} /> {rating ? 'Edit your rating' : 'Give your take'}</span></button><div className="card-meta"><span>{mediaLabel(movie)}</span><span>{movie.year || 'Year unknown'}</span></div><h3><button onClick={() => onRate(movie)}>{titleOf(movie)}</button></h3><p className="card-genres">{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 2).join(' / ') || 'A new story awaits'}</p>{movie.reason && <p className="card-reason">{movie.reason}</p>}<div className="card-actions"><button onClick={() => onRate(movie)} className={rating ? 'is-rated' : ''}><Star size={14} fill={rating ? 'currentColor' : 'none'} />{rating ? `${rating.toFixed(1)}/10` : 'Rate'}</button>{onRemove && <button aria-label={`Remove ${titleOf(movie)} from this watchlist`} onClick={onRemove}><Trash2 size={14} /> Remove from list</button>}</div><TitleActions movie={movie} onAdd={() => onAdd(movie)} compact /></article>;
}
type MovieCollectionProps = { movies: Movie[]; ratings: Map<number, number>; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onRemove?: (movie: Movie) => void; query?: CollectionQuery };
const NO_MOVIES: Movie[] = [];

/** A permanent small poster leads the row; hover/focus enlarges either target. */
function CoverPreviewTitle({ movie, onRate, disabled }: { movie: Movie; onRate: () => void; disabled?: boolean }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null), [pinned, setPinned] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null), previewId = useId(), title = titleOf(movie);
  function close() { setPosition(null); setPinned(false); }
  function open(element: HTMLElement, pin = false) {
    const rect = element.getBoundingClientRect(), width = 220, height = 350, margin = 12;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const top = rect.bottom + height + margin <= window.innerHeight ? rect.bottom + 8 : Math.max(margin, rect.top - height - 8);
    setPosition({ left, top }); setPinned(pin);
  }
  useEffect(() => {
    if (!position) return;
    function outside(event: PointerEvent) { if (!anchor.current?.contains(event.target as Node)) close(); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [Boolean(position)]);
  return <span className="collection-title-cell" ref={anchor} onMouseLeave={() => { if (!pinned) close(); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    <button type="button" className="collection-thumbnail-trigger" aria-label={`${pinned ? 'Hide' : 'Preview'} cover: ${title}`} aria-pressed={pinned} aria-describedby={position ? previewId : undefined}
      onMouseEnter={event => { if (!pinned) open(event.currentTarget); }} onFocus={event => { if (!pinned) open(event.currentTarget); }}
      onClick={event => { if (pinned) close(); else open(event.currentTarget, true); }}><Poster movie={movie} /></button>
    <button type="button" className="collection-title-trigger" onClick={() => { close(); onRate(); }} disabled={disabled} aria-describedby={position ? previewId : undefined}
      onMouseEnter={event => { if (!pinned) open(event.currentTarget); }} onFocus={event => { if (!pinned) open(event.currentTarget); }}>{title}</button>
    {position && createPortal(<div className="collection-cover-preview" role="tooltip" id={previewId} style={{ left: position.left, top: position.top }}><Poster movie={movie} /><span className="collection-cover-caption">{title}{movie.year ? ` (${movie.year})` : ''}</span></div>, document.body)}
  </span>;
}

/** Inline editing reuses the same account-scoped persistence and mutation lock. */
function CompactRating({ movie, rating, disabled = false, onSaved }: { movie: Movie; rating?: number; disabled?: boolean; onSaved?: (movie: Movie, rating: number) => void }) {
  const activity = useTitleActivity(), title = titleOf(movie);
  const [error, setError] = useState('');
  const alive = useRef(true), saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const value = activity.draftRatings.get(movie.movieId) ?? rating ?? 5;
  const response = feeling(value), pending = activity.pending.has(movie.movieId), busy = disabled || pending;
  const changed = rating === undefined || Math.abs(value - rating) > .000001;
  const canSave = changed || Boolean(onSaved);
  async function save() {
    if (disabled || pending || saving.current) return;
    saving.current = true; setError('');
    try {
      // A successful save may refresh and unmount this row. The callback still
      // advances its queue after persistence; account guards live in the provider.
      if (await activity.saveRating(movie.movieId, value)) onSaved?.(movie, value);
    } catch (failure) { if (alive.current) setError(message(failure)); }
    finally { saving.current = false; }
  }
  return <div className="collection-inline-rating" role="group" aria-label={`Rate ${title} in this row`}>
    <div className="collection-inline-summary"><span className="collection-inline-emoji" aria-hidden="true">{response.emoji}</span><span className="collection-inline-value"><strong>{value.toFixed(1)}<small> / 10</small></strong><span className="collection-inline-feedback">{rating === undefined ? 'Not rated yet' : changed ? 'Unsaved change' : 'Saved rating'}</span></span></div>
    <input type="range" className="collection-inline-range" min="1" max="10" step="0.1" value={value} disabled={busy} aria-label={`Your rating for ${title}`} aria-valuetext={`${value.toFixed(1)} out of 10, ${response.label}`} onChange={event => { setError(''); activity.setDraftRating(movie.movieId, Number(event.target.value)); }} />
    <button type="button" className="collection-inline-save" onClick={() => void save()} disabled={busy || (Boolean(activity.user) && !canSave)} aria-label={`${activity.user ? 'Save' : 'Sign in to save'} ${value.toFixed(1)} out of 10 rating for ${title}${onSaved ? ' and show the next title' : ''}`}>
      {pending ? <LoaderCircle size={14} className="spinning" /> : <Check size={14} />}<span>{pending ? 'Saving…' : activity.user ? onSaved ? 'Save & next' : changed ? 'Save' : 'Saved' : 'Sign in to save'}</span>
    </button>
    {error && <p className="collection-inline-error" role="alert">{error}</p>}
  </div>;
}

export function MovieTable({ movies, ratings, onRate, onAdd, onRemove, query: suppliedQuery, currentMovieId, disabled = false, caption = 'Movies and whole TV series', onInlineSaved }: MovieCollectionProps & { currentMovieId?: number; disabled?: boolean; caption?: string; onInlineSaved?: (movie: Movie, rating: number) => void }) {
  const activity = useTitleActivity();
  const ownQuery = useCollectionQuery(suppliedQuery ? NO_MOVIES : movies, ratings, activity.states);
  const query = suppliedQuery ?? ownQuery;
  return <>{!suppliedQuery && <CollectionQuerySummary query={query} />}<p className="collection-mobile-hint">Swipe sideways to see all columns. Tap a title to open the full rating view.</p><div className="collection-table-scroll" role="region" aria-label={caption} tabIndex={0}><table className="collection-table"><caption className="sr-only">{caption}. Hover or focus a poster or title for a larger cover. Select a column heading to sort; use its filter button to narrow titles. Adjust the slider and save your rating in its row.</caption><thead><tr><th scope="col">Poster and title</th><CollectionColumnHeading field="year" label="Year" query={query} /><th scope="col">Type</th><CollectionColumnHeading field="genre" label="Genre" query={query} /><CollectionColumnHeading field="rating" label="Your rating" query={query} /><CollectionColumnHeading field="favorite" label="Favorite" query={query} /><CollectionColumnHeading field="watched" label="Watched" query={query} /><th scope="col">Actions</th></tr></thead><tbody>{query.items.map(movie => {
    const rating = ratings.get(movie.movieId);
    return <tr key={movie.movieId} className={currentMovieId === movie.movieId ? 'collection-row-current' : undefined}><th scope="row"><CoverPreviewTitle movie={movie} onRate={() => onRate(movie)} disabled={disabled} /></th><td>{movie.year || '—'}</td><td>{mediaLabel(movie)}</td><td>{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 2).join(' / ') || '—'}</td><td><CompactRating movie={movie} rating={rating} disabled={disabled} onSaved={onInlineSaved} /></td><td className="collection-status-cell"><TitleActions movie={movie} onAdd={() => onAdd(movie)} compact disabled={disabled} actions={['favorite']} /></td><td className="collection-status-cell"><TitleActions movie={movie} onAdd={() => onAdd(movie)} compact disabled={disabled} actions={['watched']} /></td><td><div className="collection-row-actions"><TitleActions movie={movie} onAdd={() => onAdd(movie)} compact disabled={disabled} actions={['list']} />{onRemove && <button type="button" className="collection-remove" disabled={disabled} aria-label={`Remove ${titleOf(movie)} from this list`} onClick={() => onRemove(movie)}><Trash2 size={15} /><span>Remove</span></button>}</div></td></tr>;
  })}{!query.items.length && <tr><td colSpan={8} className="collection-empty-result"><p>{query.error || 'No titles match these filters.'}</p>{query.active && <button type="button" className="collection-query-reset" onClick={query.clearFilters}>Clear all filters</button>}</td></tr>}</tbody></table></div></>;
}

export function MovieGrid(props: MovieCollectionProps) {
  const { view } = useCollectionView();
  const movies = props.query?.items ?? props.movies;
  return view === 'compact' ? <MovieTable {...props} /> : movies.length ? <div className="movie-grid">{movies.map(movie => <MovieCard key={movie.movieId} movie={movie} rating={props.ratings.get(movie.movieId)} onRate={props.onRate} onAdd={props.onAdd} onRemove={props.onRemove ? () => props.onRemove?.(movie) : undefined} />)}</div> : <div className="collection-empty-result"><p>{props.query?.error || 'No titles match these filters.'}</p>{props.query?.active && <button type="button" className="collection-query-reset" onClick={props.query.clearFilters}>Clear all filters</button>}</div>;
}
export function SkeletonGrid() {
  const { view } = useCollectionView();
  return view === 'compact' ? <div className="collection-table-scroll collection-table-loading" aria-busy="true" aria-label="Loading titles"><table className="collection-table"><thead><tr>{['Poster and title', 'Year', 'Type', 'Genre', 'Your rating', 'Favorite', 'Watched', 'Actions'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{Array.from({ length: 6 }, (_, index) => <tr key={index}><td colSpan={8}><span className="collection-loading-line">Loading titles…</span></td></tr>)}</tbody></table></div> : <div className="movie-grid" aria-busy="true" aria-label="Loading titles">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-card" key={index}><div /><span /><span /></div>)}</div>;
}

function feeling(value: number) {
  if (value < 2.5) return { emoji: '😖', label: 'Not for me' };
  if (value < 4) return { emoji: '🙁', label: 'A little disappointing' };
  if (value < 5.5) return { emoji: '😐', label: 'Somewhere in the middle' };
  if (value < 7) return { emoji: '🙂', label: 'A good watch' };
  if (value < 8) return { emoji: '😊', label: 'Really enjoyed it' };
  if (value < 9) return { emoji: '🤩', label: 'Loved every minute' };
  if (value < 9.8) return { emoji: '😍', label: 'An instant favorite' };
  return { emoji: '🏆', label: 'An all-time great' };
}
export function Fader({ value, onChange, title, disabled }: { value: number; onChange: (rating: number) => void; title: string; disabled?: boolean }) {
  const response = feeling(value);
  return <div className="rating-fader"><span className="fader-end">10 <span>Excellent</span></span><div className="fader-rail"><div className="fader-colors" /><input className="fader-input" type="range" min="1" max="10" step="0.1" value={value} onChange={event => onChange(Number(event.target.value))} disabled={disabled} aria-label={`Your rating for ${title}`} aria-valuetext={`${value.toFixed(1)} out of 10, ${response.label}`} /></div><span className="fader-end">1 <span>Not for me</span></span></div>;
}
export function RatingEditor({ movie, value, onChange, busy, user, onSave, onAdd, children, next = false, onRatingRemoved }: { movie: Movie; value: number; onChange: (value: number) => void; busy: boolean; user: User | null; onSave: () => void; onAdd: () => void; children?: ReactNode; next?: boolean; onRatingRemoved?: () => void }) {
  movie = useTitleDetails(movie);
  const activity = useTitleActivity(), savedRating = activity.ratings.get(movie.movieId), previousRating = useRef(savedRating);
  const phone = usePhoneLayout(), [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => { setDetailsOpen(false); }, [movie.movieId]);
  useEffect(() => { if (previousRating.current !== undefined && savedRating === undefined) onChange(5); previousRating.current = savedRating; }, [savedRating, movie.movieId, onChange]);
  busy = busy || activity.pending.has(movie.movieId);
  const response = feeling(value);
  const years = movie.year ? `${movie.year}${movie.endYear && movie.endYear !== movie.year ? `–${movie.endYear}` : ''}` : 'YOUR TAKE';
  if (phone) return <div className="rating-editor">
    <header className="rating-editor-heading"><span className="eyebrow">{mediaLabel(movie)} · {years}{movie.mediaType === 'series' && movie.seasonCount ? ` · ${movie.seasonCount} seasons` : ''}</span><h2>{titleOf(movie)}</h2></header>
    <div className="rating-art"><Poster movie={movie} large /></div>
    <Fader title={titleOf(movie)} value={value} onChange={onChange} disabled={busy} />
    <div className="rating-expression" aria-live="polite"><span className="rating-emoji" aria-hidden="true">{response.emoji}</span><div><strong>{value.toFixed(1)}<small>/ 10</small></strong><span>{response.label}</span></div></div>
    <div className="rating-editor-activity"><TitleActions movie={movie} onAdd={onAdd} disabled={busy} compact actions={['favorite', 'list']} /></div>
    <div className="rating-editor-more"><button type="button" className="button outline-button" onClick={() => setDetailsOpen(true)} disabled={busy}><Info size={16} />Details &amp; activity</button><RemoveRatingButton movieId={movie.movieId} disabled={busy} onRemoved={onRatingRemoved} /></div>
    <div className="rating-editor-footer"><button type="button" className="button burgundy-button save-score" onClick={onSave} disabled={busy} aria-label={user ? `Save your ${value.toFixed(1)} out of 10 rating${next ? ' and show the next title' : ''}` : 'Sign in to save your rating'}>{busy ? <LoaderCircle size={19} className="spinning" /> : next ? <ArrowRight size={22} /> : <Check size={19} />}{busy ? 'Saving…' : user ? next ? 'Save & next' : `Save ${value.toFixed(1)} / 10` : 'Sign in to save'}{next && user && <span>{value.toFixed(1)} / 10</span>}</button>{children}</div>
    {detailsOpen && <Modal title={`Details and activity: ${titleOf(movie)}`} onClose={() => setDetailsOpen(false)} busy={busy}><div className="rating-details-panel"><span className="eyebrow">TITLE DETAILS &amp; ACTIVITY</span><h2>{titleOf(movie)}</h2><p>{mediaLabel(movie)} · {years}{movie.seasonCount ? ` · ${movie.seasonCount} seasons` : ''}</p><p>{movie.genres.filter(genre => genre !== '(no genres listed)').join(' · ')}</p><dl className="rating-title-details">{Boolean(movie.directors?.length) && <div><dt>Director</dt><dd>{movie.directors?.join(', ')}</dd></div>}{Boolean(movie.creators?.length) && <div><dt>Creator</dt><dd>{movie.creators?.join(', ')}</dd></div>}{Boolean(movie.cast?.length) && <div><dt>Cast</dt><dd>{movie.cast?.join(', ')}</dd></div>}</dl>{movie.mediaType === 'series' && <p>Rate the whole series. Seasons and episodes are not rated separately.</p>}<TitleActions movie={movie} onAdd={onAdd} disabled={busy} /><RemoveRatingButton movieId={movie.movieId} disabled={busy} onRemoved={onRatingRemoved} />{movie.metadataSource && <p className="title-metadata-credit">Title details: <a href={movie.metadataSource.url} target="_blank" rel="noreferrer">{movie.metadataSource.name}</a>{movie.creditsSource && movie.creditsSource.url !== movie.metadataSource.url && <> · Credits: <a href={movie.creditsSource.url} target="_blank" rel="noreferrer">{movie.creditsSource.name}</a></>}</p>}<button type="button" className="button outline-button" onClick={() => setDetailsOpen(false)} disabled={busy}>Back to rating</button></div></Modal>}
  </div>;
  return <div className={`rating-composition ${next ? 'rating-queue-composition' : ''}`}><div className="rating-art"><Poster movie={movie} large /></div><Fader title={titleOf(movie)} value={value} onChange={onChange} disabled={busy} /><div className="rating-story"><span className="eyebrow">{mediaLabel(movie)} · {years}{movie.mediaType === 'series' && movie.seasonCount ? ` · ${movie.seasonCount} ${movie.seasonCount === 1 ? 'season' : 'seasons'}` : ''}</span><h2>{titleOf(movie)}</h2><p className="rating-genres">{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 3).join(' · ')}</p>{(movie.cast?.length || movie.directors?.length || movie.creators?.length) ? <dl className="rating-title-details">{Boolean(movie.directors?.length) && <div><dt>{movie.directors?.length === 1 ? 'Director' : 'Directors'}</dt><dd>{movie.directors?.slice(0, 3).join(', ')}</dd></div>}{Boolean(movie.creators?.length) && <div><dt>{movie.creators?.length === 1 ? 'Creator' : 'Creators'}</dt><dd>{movie.creators?.slice(0, 3).join(', ')}</dd></div>}{Boolean(movie.cast?.length) && <div><dt>Starring</dt><dd>{movie.cast?.slice(0, 5).join(', ')}</dd></div>}</dl> : null}{movie.mediaType === 'series' && <p className="whole-series-note">Your take on the whole series. Seasons and episodes stay out of this score.</p>}<TitleActions movie={movie} onAdd={onAdd} disabled={busy} /><div className="rating-expression" aria-live="polite"><span className="rating-emoji" aria-hidden="true">{response.emoji}</span><div><strong>{value.toFixed(1)}<small>/ 10</small></strong><span>{response.label}</span></div></div><p className="fader-instruction">Slide to find your score. Use the arrow keys for 0.1 steps.</p>{!next && <button className="button burgundy-button save-score" onClick={onSave} disabled={busy}>{busy ? <LoaderCircle size={17} className="spinning" /> : <Check size={17} />}{user ? `Save ${value.toFixed(1)} / 10` : 'Sign in to save your rating'}</button>}{children}<RemoveRatingButton movieId={movie.movieId} disabled={busy} onRemoved={onRatingRemoved} />{movie.metadataSource && <p className="title-metadata-credit">Title details: <a href={movie.metadataSource.url} target="_blank" rel="noreferrer">{movie.metadataSource.name}</a>{movie.creditsSource && movie.creditsSource.url !== movie.metadataSource.url && <> · Credits: <a href={movie.creditsSource.url} target="_blank" rel="noreferrer">{movie.creditsSource.name}</a></>}</p>}</div>{next && <button className="save-next-control" onClick={onSave} disabled={busy} aria-label={user ? `Save your ${value.toFixed(1)} out of 10 rating and show the next title` : 'Sign in to save your rating'}>{busy ? <LoaderCircle size={35} className="spinning" /> : <ArrowRight size={39} strokeWidth={1.7} />}<strong>{busy ? 'Saving…' : user ? 'Save & Next' : 'Sign in'}</strong><span>{value.toFixed(1)} / 10</span></button>}</div>;
}

export function AuthDialog({ onClose, onComplete }: { onClose: () => void; onComplete: () => Promise<void> }) {
  const [register, setRegister] = useState(false), [username, setUsername] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await api(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ username, password, ...(register && name.trim() ? { displayName: name.trim() } : {}) }) }); await onComplete(); onClose(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); } }
  return <Modal title={register ? `Create your ${APP_NAME} account` : `Sign in to ${APP_NAME}`} onClose={onClose} busy={busy}><div className="auth-heading"><span className="eyebrow">{APP_TAGLINE}</span><h2>{register ? 'Make yourself at home.' : 'Welcome back.'}</h2><p>One account for your movies, series, and shared watch nights.</p></div><div className="auth-tabs" role="group" aria-label="Account action"><button className={!register ? 'active' : ''} onClick={() => { setRegister(false); setError(''); }} disabled={busy}>Sign in</button><button className={register ? 'active' : ''} onClick={() => { setRegister(true); setError(''); }} disabled={busy}>Create account</button></div><form onSubmit={submit} className="stack-form"><label>Username<input autoComplete="username" name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" value={username} onChange={event => setUsername(event.target.value)} placeholder="Your picture-house name" disabled={busy} /></label>{register && <label>Display name <span className="optional">optional</span><input autoComplete="nickname" maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="What your friends call you" disabled={busy} /></label>}<label>Password<input type="password" name="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 10 : 1} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />{register && <small>At least 10 characters. Use a password unique to this app.</small>}</label>{error && <ErrorNotice text={error} />}<button className="button burgundy-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spinning" size={17} /> : <ArrowRight size={17} />}{register ? 'Create my account' : 'Sign in'}</button></form></Modal>;
}
