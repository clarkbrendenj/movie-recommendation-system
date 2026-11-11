"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, Clapperboard, Image, LoaderCircle, Star, Trash2, X } from "lucide-react";
import { api, message, mediaLabel, titleOf, type MediaType, type Movie, type User } from "./types";
import { useTitleDetails } from "./metadata";
import { RemoveRatingButton, TitleActions, useTitleActivity } from "./activity";
import { useCollectionView } from "./collection-view";
import "./rating-experience.css";

const PALETTES = [["#5a2634", "#f4dfb7", "#b88c4e"], ["#233a3d", "#f5e8c8", "#a87945"], ["#74603c", "#fff1d0", "#391d26"], ["#30354b", "#eee2c2", "#ac7452"], ["#513c49", "#f8e8c3", "#c2a36f"], ["#3c4b3a", "#f2dfb7", "#ac654b"]];
export function useDebounced(value: string) { const [settled, setSettled] = useState(value); useEffect(() => { const timer = setTimeout(() => setSettled(value), 250); return () => clearTimeout(timer); }, [value]); return settled; }
export function ErrorNotice({ text, retry }: { text: string; retry?: () => void }) { return <div className="notice error-notice" role="alert"><span>{text}</span>{retry && <button onClick={retry}>Try again <ArrowRight size={15} /></button>}</div>; }
export function Busy({ text = "Setting the scene…" }: { text?: string }) { return <div className="busy-state" role="status"><LoaderCircle className="spinning" size={22} /><span>{text}</span></div>; }
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <div className="empty-state"><span className="empty-emblem"><Clapperboard size={30} strokeWidth={1.3} /></span><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function AuthGate({ onSignIn, title = "Your seat is waiting." }: { onSignIn: () => void; title?: string }) { return <Empty title={title} action={<button className="button gold-button" onClick={onSignIn}>Sign in or create an account <ArrowRight size={17} /></button>}>Keep your ratings, save a watchlist, and make a selection with the people you love watching with.</Empty>; }
export function Segments({ value, onChange }: { value: MediaType; onChange: (value: MediaType) => void }) { return <div className="segments" role="group" aria-label="Choose title type">{([['movies', 'Movies'], ['series', 'TV series'], ['both', 'Both']] as const).map(([kind, label]) => <button key={kind} aria-pressed={value === kind} className={value === kind ? 'active' : ''} onClick={() => onChange(kind)}>{label}</button>)}</div>; }

export function Modal({ title, children, onClose, busy = false, wide = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose), busyRef = useRef(busy);
  closeRef.current = onClose; busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input, button, select')?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}><button className="icon-button dialog-close" aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={20} /></button>{children}</div></div>;
}

export function Poster({ movie, large = false }: { movie: Movie; large?: boolean }) {
  const details = useTitleDetails(movie);
  movie = details;
  const [failedUrls, setFailedUrls] = useState(new Set<string>());
  const posterUrl = [movie.posterUrl, ...(details.posterFallbackUrls || [])].find((url): url is string => Boolean(url && !failedUrls.has(url)));
  const hash = [...movie.title].reduce((sum, char) => sum + char.charCodeAt(0), movie.movieId);
  const [background, ink, accent] = PALETTES[hash % PALETTES.length], title = titleOf(movie);
  const longest = Math.max(1, ...title.split(/\s+|[-–—]/).map(word => word.length));
  return <div className={`poster poster-${hash % 4} ${large ? 'poster-large' : ''}`} style={{ '--poster-bg': background, '--poster-ink': ink, '--poster-accent': accent, '--longest-word': longest * .72 } as CSSProperties} aria-hidden="true"><div className="poster-border" /><span className="poster-studio">AFTERGLOW PICTURES</span><div className="poster-geometry"><i /><i /><i /></div><span className="poster-symbol">✦</span><span className={`poster-name ${title.length > 25 ? 'poster-name-long' : ''}`}>{title}</span><div className="poster-footer"><span>{movie.mediaType === 'series' ? 'THE SERIES COLLECTION' : 'A PICTURE HOUSE SELECTION'}</span><span>{movie.year || '—'}</span></div>{posterUrl && <img key={posterUrl} className="poster-photo" src={posterUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrls(previous => new Set(previous).add(posterUrl))} />}</div>;
}
export function MovieCard({ movie, rating, onRate, onAdd, onRemove }: { movie: Movie; rating?: number; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onRemove?: () => void }) {
  movie = useTitleDetails(movie);
  return <article className="movie-card"><button className="poster-button" onClick={() => onRate(movie)} aria-label={`Rate ${titleOf(movie)}`}><Poster movie={movie} /><span className="poster-action"><Star size={18} /> {rating ? 'Edit your rating' : 'Give your take'}</span></button><div className="card-meta"><span>{mediaLabel(movie)}</span><span>{movie.year || 'Year unknown'}</span></div><h3><button onClick={() => onRate(movie)}>{titleOf(movie)}</button></h3><p className="card-genres">{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 2).join(' / ') || 'A new story awaits'}</p>{movie.reason && <p className="card-reason">{movie.reason}</p>}<div className="card-actions"><button onClick={() => onRate(movie)} className={rating ? 'is-rated' : ''}><Star size={14} fill={rating ? 'currentColor' : 'none'} />{rating ? `${rating.toFixed(1)}/10` : 'Rate'}</button>{onRemove && <button aria-label={`Remove ${titleOf(movie)} from this watchlist`} onClick={onRemove}><Trash2 size={14} /> Remove from list</button>}</div><TitleActions movie={movie} onAdd={() => onAdd(movie)} compact /></article>;
}
type MovieCollectionProps = { movies: Movie[]; ratings: Map<number, number>; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onRemove?: (movie: Movie) => void };

/** The poster subtree mounts only while requested, keeping compact lists light. */
function CoverPreviewTitle({ movie, onRate, disabled }: { movie: Movie; onRate: () => void; disabled?: boolean }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null), [pinned, setPinned] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null), previewId = useId(), title = titleOf(movie);
  function close() { setPosition(null); setPinned(false); }
  function open(element: HTMLElement, pin = false) {
    const rect = element.getBoundingClientRect(), width = 150, height = 250, margin = 12;
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
  return <span className="collection-title-cell" ref={anchor} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    <button type="button" className="collection-title-trigger" onClick={() => { close(); onRate(); }} disabled={disabled} aria-describedby={position ? previewId : undefined}
      onMouseEnter={event => { if (!pinned) open(event.currentTarget); }} onMouseLeave={() => { if (!pinned) close(); }} onFocus={event => { if (!pinned) open(event.currentTarget); }}>{title}</button>
    <button type="button" className="collection-preview-trigger" aria-label={`${pinned ? 'Hide' : 'Preview'} cover: ${title}`} aria-pressed={pinned} onClick={event => { if (pinned) close(); else open(event.currentTarget, true); }}><Image size={16} /></button>
    {position && createPortal(<div className="collection-cover-preview" role="tooltip" id={previewId} style={{ left: position.left, top: position.top }}><Poster movie={movie} /><span className="collection-cover-caption">{title}{movie.year ? ` (${movie.year})` : ''}</span></div>, document.body)}
  </span>;
}

export function MovieTable({ movies, ratings, onRate, onAdd, onRemove, currentMovieId, disabled = false, caption = 'Movies and whole TV series' }: MovieCollectionProps & { currentMovieId?: number; disabled?: boolean; caption?: string }) {
  return <div className="collection-table-scroll" role="region" aria-label={caption} tabIndex={0}><table className="collection-table"><caption className="sr-only">{caption}. Hover or focus a title to preview its cover; select its title or rating to rate it.</caption><thead><tr><th scope="col">Title</th><th scope="col">Year</th><th scope="col">Type</th><th scope="col">Genres</th><th scope="col">Your rating</th><th scope="col">Actions</th></tr></thead><tbody>{movies.map(movie => {
    const rating = ratings.get(movie.movieId);
    return <tr key={movie.movieId} className={currentMovieId === movie.movieId ? 'collection-row-current' : undefined}><th scope="row"><CoverPreviewTitle movie={movie} onRate={() => onRate(movie)} disabled={disabled} /></th><td>{movie.year || '—'}</td><td>{mediaLabel(movie)}</td><td>{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 2).join(' / ') || '—'}</td><td><button type="button" className={`collection-score ${rating !== undefined ? 'is-rated' : ''}`} onClick={() => onRate(movie)} disabled={disabled} aria-label={`${rating === undefined ? 'Rate' : `Edit ${rating.toFixed(1)} out of 10 rating for`} ${titleOf(movie)}`}>{rating === undefined ? 'Rate' : `${rating.toFixed(1)} / 10`}</button></td><td><div className="collection-row-actions"><TitleActions movie={movie} onAdd={() => onAdd(movie)} compact disabled={disabled} />{onRemove && <button type="button" className="collection-remove" disabled={disabled} aria-label={`Remove ${titleOf(movie)} from this list`} onClick={() => onRemove(movie)}><Trash2 size={15} /><span>Remove</span></button>}</div></td></tr>;
  })}</tbody></table></div>;
}

export function MovieGrid(props: MovieCollectionProps) {
  const { view } = useCollectionView();
  return view === 'compact' ? <MovieTable {...props} /> : <div className="movie-grid">{props.movies.map(movie => <MovieCard key={movie.movieId} movie={movie} rating={props.ratings.get(movie.movieId)} onRate={props.onRate} onAdd={props.onAdd} onRemove={props.onRemove ? () => props.onRemove?.(movie) : undefined} />)}</div>;
}
export function SkeletonGrid() {
  const { view } = useCollectionView();
  return view === 'compact' ? <div className="collection-table-scroll collection-table-loading" aria-busy="true" aria-label="Loading titles"><table className="collection-table"><thead><tr>{['Title', 'Year', 'Type', 'Genres', 'Your rating', 'Actions'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{Array.from({ length: 6 }, (_, index) => <tr key={index}><td colSpan={6}><span className="collection-loading-line">Loading titles…</span></td></tr>)}</tbody></table></div> : <div className="movie-grid" aria-busy="true" aria-label="Loading titles">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-card" key={index}><div /><span /><span /></div>)}</div>;
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
  useEffect(() => { if (previousRating.current !== undefined && savedRating === undefined) onChange(5); previousRating.current = savedRating; }, [savedRating, movie.movieId, onChange]);
  busy = busy || activity.pending.has(movie.movieId);
  const response = feeling(value);
  const years = movie.year ? `${movie.year}${movie.endYear && movie.endYear !== movie.year ? `–${movie.endYear}` : ''}` : 'YOUR TAKE';
  return <div className={`rating-composition ${next ? 'rating-queue-composition' : ''}`}><div className="rating-art"><Poster movie={movie} large /></div><Fader title={titleOf(movie)} value={value} onChange={onChange} disabled={busy} /><div className="rating-story"><span className="eyebrow">{mediaLabel(movie)} · {years}{movie.mediaType === 'series' && movie.seasonCount ? ` · ${movie.seasonCount} ${movie.seasonCount === 1 ? 'season' : 'seasons'}` : ''}</span><h2>{titleOf(movie)}</h2><p className="rating-genres">{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 3).join(' · ')}</p>{(movie.cast?.length || movie.directors?.length || movie.creators?.length) ? <dl className="rating-title-details">{Boolean(movie.directors?.length) && <div><dt>{movie.directors?.length === 1 ? 'Director' : 'Directors'}</dt><dd>{movie.directors?.slice(0, 3).join(', ')}</dd></div>}{Boolean(movie.creators?.length) && <div><dt>{movie.creators?.length === 1 ? 'Creator' : 'Creators'}</dt><dd>{movie.creators?.slice(0, 3).join(', ')}</dd></div>}{Boolean(movie.cast?.length) && <div><dt>Starring</dt><dd>{movie.cast?.slice(0, 5).join(', ')}</dd></div>}</dl> : null}{movie.mediaType === 'series' && <p className="whole-series-note">Your take on the whole series. Seasons and episodes stay out of this score.</p>}<TitleActions movie={movie} onAdd={onAdd} disabled={busy} /><div className="rating-expression" aria-live="polite"><span className="rating-emoji" aria-hidden="true">{response.emoji}</span><div><strong>{value.toFixed(1)}<small>/ 10</small></strong><span>{response.label}</span></div></div><p className="fader-instruction">Slide to find your score. Use the arrow keys for 0.1 steps.</p>{!next && <button className="button burgundy-button save-score" onClick={onSave} disabled={busy}>{busy ? <LoaderCircle size={17} className="spinning" /> : <Check size={17} />}{user ? `Save ${value.toFixed(1)} / 10` : 'Sign in to save your rating'}</button>}{children}<RemoveRatingButton movieId={movie.movieId} disabled={busy} onRemoved={onRatingRemoved} />{movie.metadataSource && <p className="title-metadata-credit">Title details: <a href={movie.metadataSource.url} target="_blank" rel="noreferrer">{movie.metadataSource.name}</a>{movie.creditsSource && movie.creditsSource.url !== movie.metadataSource.url && <> · Credits: <a href={movie.creditsSource.url} target="_blank" rel="noreferrer">{movie.creditsSource.name}</a></>}</p>}</div>{next && <button className="save-next-control" onClick={onSave} disabled={busy} aria-label={user ? `Save your ${value.toFixed(1)} out of 10 rating and show the next title` : 'Sign in to save your rating'}>{busy ? <LoaderCircle size={35} className="spinning" /> : <ArrowRight size={39} strokeWidth={1.7} />}<strong>{busy ? 'Saving…' : user ? 'Save & Next' : 'Sign in'}</strong><span>{value.toFixed(1)} / 10</span></button>}</div>;
}

export function AuthDialog({ onClose, onComplete }: { onClose: () => void; onComplete: () => Promise<void> }) {
  const [register, setRegister] = useState(false), [username, setUsername] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await api(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ username, password, ...(register && name.trim() ? { displayName: name.trim() } : {}) }) }); await onComplete(); onClose(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); } }
  return <Modal title={register ? 'Create your Afterglow account' : 'Sign in to Afterglow'} onClose={onClose} busy={busy}><div className="auth-heading"><span className="eyebrow">YOUR PRIVATE PICTURE HOUSE</span><h2>{register ? 'Make yourself at home.' : 'Welcome back.'}</h2><p>One account for your movies, series, and shared watch nights.</p></div><div className="auth-tabs" role="group" aria-label="Account action"><button className={!register ? 'active' : ''} onClick={() => { setRegister(false); setError(''); }} disabled={busy}>Sign in</button><button className={register ? 'active' : ''} onClick={() => { setRegister(true); setError(''); }} disabled={busy}>Create account</button></div><form onSubmit={submit} className="stack-form"><label>Username<input autoComplete="username" name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" value={username} onChange={event => setUsername(event.target.value)} placeholder="Your picture-house name" disabled={busy} /></label>{register && <label>Display name <span className="optional">optional</span><input autoComplete="nickname" maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="What your friends call you" disabled={busy} /></label>}<label>Password<input type="password" name="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 10 : 1} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />{register && <small>At least 10 characters. Use a password unique to Afterglow.</small>}</label>{error && <ErrorNotice text={error} />}<button className="button burgundy-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spinning" size={17} /> : <ArrowRight size={17} />}{register ? 'Create my account' : 'Sign in'}</button></form></Modal>;
}
