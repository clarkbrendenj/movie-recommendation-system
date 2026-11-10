"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Bookmark, Check, Clapperboard, LoaderCircle, Star, Trash2, X } from "lucide-react";
import { api, message, mediaLabel, titleOf, type MediaType, type Movie, type User } from "./types";

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
  const hash = [...movie.title].reduce((sum, char) => sum + char.charCodeAt(0), movie.movieId);
  const [background, ink, accent] = PALETTES[hash % PALETTES.length], title = titleOf(movie);
  const longest = Math.max(1, ...title.split(/\s+|[-–—]/).map(word => word.length));
  return <div className={`poster poster-${hash % 4} ${large ? 'poster-large' : ''}`} style={{ '--poster-bg': background, '--poster-ink': ink, '--poster-accent': accent, '--longest-word': longest * .72 } as CSSProperties} aria-hidden="true"><div className="poster-border" /><span className="poster-studio">AFTERGLOW PICTURES</span><div className="poster-geometry"><i /><i /><i /></div><span className="poster-symbol">✦</span><span className={`poster-name ${title.length > 25 ? 'poster-name-long' : ''}`}>{title}</span><div className="poster-footer"><span>{movie.mediaType === 'series' ? 'THE SERIES COLLECTION' : 'A PICTURE HOUSE SELECTION'}</span><span>{movie.year || '—'}</span></div></div>;
}
export function MovieCard({ movie, rating, onRate, onAdd, onRemove }: { movie: Movie; rating?: number; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onRemove?: () => void }) {
  return <article className="movie-card"><button className="poster-button" onClick={() => onRate(movie)} aria-label={`Rate ${titleOf(movie)}`}><Poster movie={movie} /><span className="poster-action"><Star size={18} /> {rating ? 'Edit your rating' : 'Give your take'}</span></button><div className="card-meta"><span>{mediaLabel(movie)}</span><span>{movie.year || 'Year unknown'}</span></div><h3><button onClick={() => onRate(movie)}>{titleOf(movie)}</button></h3><p className="card-genres">{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 2).join(' / ') || 'A new story awaits'}</p>{movie.reason && <p className="card-reason">{movie.reason}</p>}<div className="card-actions"><button onClick={() => onRate(movie)} className={rating ? 'is-rated' : ''}><Star size={14} fill={rating ? 'currentColor' : 'none'} />{rating ? `${rating.toFixed(1)}/10` : 'Rate'}</button>{onRemove ? <button aria-label={`Remove ${titleOf(movie)} from this watchlist`} onClick={onRemove}><Trash2 size={14} /> Remove</button> : movie.mediaType !== 'other' && <button aria-label={`Save ${titleOf(movie)} to a watchlist`} onClick={() => onAdd(movie)}><Bookmark size={14} /> Save</button>}</div></article>;
}
export function MovieGrid({ movies, ratings, onRate, onAdd, onRemove }: { movies: Movie[]; ratings: Map<number, number>; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onRemove?: (movie: Movie) => void }) { return <div className="movie-grid">{movies.map(movie => <MovieCard key={movie.movieId} movie={movie} rating={ratings.get(movie.movieId)} onRate={onRate} onAdd={onAdd} onRemove={onRemove ? () => onRemove(movie) : undefined} />)}</div>; }
export function SkeletonGrid() { return <div className="movie-grid" aria-busy="true" aria-label="Loading titles">{Array.from({ length: 8 }, (_, index) => <div className="skeleton-card" key={index}><div /><span /><span /></div>)}</div>; }

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
export function RatingEditor({ movie, value, onChange, busy, user, onSave, onAdd, children }: { movie: Movie; value: number; onChange: (value: number) => void; busy: boolean; user: User | null; onSave: () => void; onAdd: () => void; children?: ReactNode }) {
  const response = feeling(value);
  return <div className="rating-composition"><div className="rating-art"><Poster movie={movie} large /></div><Fader title={titleOf(movie)} value={value} onChange={onChange} disabled={busy} /><div className="rating-story"><span className="eyebrow">{mediaLabel(movie)} · {movie.year || 'YOUR TAKE'}</span><h2>{titleOf(movie)}</h2><p className="rating-genres">{movie.genres.filter(genre => genre !== '(no genres listed)').slice(0, 3).join(' · ')}</p>{movie.mediaType === 'series' && <p className="whole-series-note">Your take on the whole series. Seasons and episodes stay out of this score.</p>}<div className="rating-expression" aria-live="polite"><span className="rating-emoji" aria-hidden="true">{response.emoji}</span><div><strong>{value.toFixed(1)}<small>/ 10</small></strong><span>{response.label}</span></div></div><p className="fader-instruction">Slide to find your score. Use the arrow keys for 0.1 steps.</p><button className="button burgundy-button save-score" onClick={onSave} disabled={busy}>{busy ? <LoaderCircle size={17} className="spinning" /> : <Check size={17} />}{user ? `Save ${value.toFixed(1)} / 10` : 'Sign in to save your rating'}</button>{children}{movie.mediaType !== 'other' && <button className="text-button save-later" onClick={onAdd} disabled={busy}><Bookmark size={15} />Save to a watchlist</button>}</div></div>;
}

export function AuthDialog({ onClose, onComplete }: { onClose: () => void; onComplete: () => Promise<void> }) {
  const [register, setRegister] = useState(false), [username, setUsername] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await api(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ username, password, ...(register && name.trim() ? { displayName: name.trim() } : {}) }) }); await onComplete(); onClose(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); } }
  return <Modal title={register ? 'Create your Afterglow account' : 'Sign in to Afterglow'} onClose={onClose} busy={busy}><div className="auth-heading"><span className="eyebrow">YOUR PRIVATE PICTURE HOUSE</span><h2>{register ? 'Make yourself at home.' : 'Welcome back.'}</h2><p>One account for your movies, series, and shared watch nights.</p></div><div className="auth-tabs" role="group" aria-label="Account action"><button className={!register ? 'active' : ''} onClick={() => { setRegister(false); setError(''); }} disabled={busy}>Sign in</button><button className={register ? 'active' : ''} onClick={() => { setRegister(true); setError(''); }} disabled={busy}>Create account</button></div><form onSubmit={submit} className="stack-form"><label>Username<input autoComplete="username" name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" value={username} onChange={event => setUsername(event.target.value)} placeholder="Your picture-house name" disabled={busy} /></label>{register && <label>Display name <span className="optional">optional</span><input autoComplete="nickname" maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="What your friends call you" disabled={busy} /></label>}<label>Password<input type="password" name="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 10 : 1} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />{register && <small>At least 10 characters. Use a password unique to Afterglow.</small>}</label>{error && <ErrorNotice text={error} />}<button className="button burgundy-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spinning" size={17} /> : <ArrowRight size={17} />}{register ? 'Create my account' : 'Sign in'}</button></form></Modal>;
}
