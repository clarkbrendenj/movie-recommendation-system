"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BookmarkPlus, Eye, Heart, LoaderCircle, Trash2 } from "lucide-react";
import { api, message, titleOf, type ActivityChange, type Movie, type TitleState, type User } from "./types";

type ActivityContextValue = {
  user: User | null;
  ratings: Map<number, number>;
  states: Map<number, TitleState>;
  pending: Set<number>;
  draftRatings: Map<number, number>;
  setDraftRating: (movieId: number, rating: number) => void;
  discardDraftRating: (movieId: number) => void;
  updateState: (movieId: number, patch: Partial<Pick<TitleState, "liked" | "watched">>) => Promise<boolean>;
  saveRating: (movieId: number, rating: number) => Promise<boolean>;
  removeRating: (movieId: number, clearWatched?: boolean) => Promise<boolean>;
};
const ActivityContext = createContext<ActivityContextValue | null>(null);

/** One account-scoped mutation lock keeps score and activity writes in order. */
export function TitleActivityProvider({ user, ratings, states, onAuth, onCommit, children }: {
  user: User | null; ratings: Map<number, number>; states: Map<number, TitleState>;
  onAuth: () => void; onCommit: (change: ActivityChange) => void; children: ReactNode;
}) {
  const [pending, setPending] = useState(new Set<number>());
  // Drafts stay inside this account provider, not row components or browser
  // storage, so refreshing another shelf cannot erase an unsaved slider value.
  const [draftRatings, setDraftRatings] = useState(new Map<number, number>());
  const locks = useRef(new Set<number>()), alive = useRef(true), owner = useRef(user?.id);
  owner.current = user?.id;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  function setDraftRating(movieId: number, rating: number) {
    if (locks.current.has(movieId) || !Number.isFinite(rating) || rating < 1 || rating > 10) return;
    setDraftRatings(previous => new Map(previous).set(movieId, Math.round(rating * 10) / 10));
  }
  function discardDraftRating(movieId: number) {
    setDraftRatings(previous => {
      if (!previous.has(movieId)) return previous;
      const next = new Map(previous); next.delete(movieId); return next;
    });
  }

  async function mutate(movieId: number, operation: () => Promise<ActivityChange>) {
    const ownerId = user?.id;
    if (!ownerId) { onAuth(); return false; }
    if (locks.current.has(movieId)) return false;
    locks.current.add(movieId); setPending(new Set(locks.current));
    try {
      const change = await operation();
      if (!alive.current || owner.current !== ownerId) return false;
      onCommit(change);
      return true;
    } finally {
      locks.current.delete(movieId);
      if (alive.current) setPending(new Set(locks.current));
    }
  }
  async function updateState(movieId: number, patch: Partial<Pick<TitleState, "liked" | "watched">>) {
    const saved = await mutate(movieId, async () => {
      const response = await api<{ state: TitleState; ratingRemoved?: boolean }>("/api/title-state", {
        method: "PUT", body: JSON.stringify({ movieId, ...patch }),
      });
      return { movieId, state: response.state, ...(response.ratingRemoved || patch.watched === false ? { rating: null } : {}) };
    });
    if (saved && patch.watched === false) discardDraftRating(movieId);
    return saved;
  }
  async function saveRating(movieId: number, rating: number) {
    const saved = await mutate(movieId, async () => {
      await api("/api/ratings", { method: "PUT", body: JSON.stringify({ movieId, rating, ratingScale: 10 }) });
      return { movieId, rating, state: { movieId, liked: states.get(movieId)?.liked || false, watched: true } };
    });
    if (saved) discardDraftRating(movieId);
    return saved;
  }
  async function removeRating(movieId: number, clearWatched = false) {
    const saved = await mutate(movieId, async () => {
      await api(`/api/ratings?movieId=${movieId}${clearWatched ? "&watched=false" : ""}`, { method: "DELETE" });
      return { movieId, rating: null, ...(clearWatched ? { state: { movieId, liked: states.get(movieId)?.liked || false, watched: false } } : {}) };
    });
    if (saved) discardDraftRating(movieId);
    return saved;
  }
  return <ActivityContext.Provider value={{ user, ratings, states, pending, draftRatings, setDraftRating, discardDraftRating, updateState, saveRating, removeRating }}>{children}</ActivityContext.Provider>;
}

export function useTitleActivity() {
  const activity = useContext(ActivityContext);
  if (!activity) throw new Error("Title activity requires the account provider.");
  return activity;
}

export function TitleActions({ movie, onAdd, disabled = false, compact = false }: { movie: Movie; onAdd: () => void; disabled?: boolean; compact?: boolean }) {
  const activity = useTitleActivity();
  const [error, setError] = useState(""), [confirm, setConfirm] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; setError(""); setConfirm(false); return () => { alive.current = false; }; }, [movie.movieId]);
  const state = activity.states.get(movie.movieId), favorite = state?.liked || false;
  const watched = state?.watched ?? activity.ratings.has(movie.movieId);
  const pending = activity.pending.has(movie.movieId), busy = disabled || pending;
  async function update(patch: Partial<Pick<TitleState, "liked" | "watched">>) {
    setError("");
    try { if (await activity.updateState(movie.movieId, patch)) { if (alive.current) setConfirm(false); } }
    catch (failure) { if (alive.current) setError(message(failure)); }
  }
  function watch() {
    if (watched && activity.ratings.has(movie.movieId)) { setConfirm(true); return; }
    void update({ watched: !watched });
  }
  return <div className={`title-activity ${compact ? "title-activity-compact" : ""}`}>
    <div className={`title-actions ${compact ? "title-actions-compact" : ""}`} role="group" aria-label={`Your activity for ${titleOf(movie)}`}>
      <button type="button" className={`title-action ${watched ? "is-watched is-active" : ""}`} aria-pressed={watched} aria-label={`${watched ? "Mark unwatched" : "Mark watched"}: ${titleOf(movie)}`} onClick={watch} disabled={busy} title={watched ? "Mark unwatched" : "Mark watched without giving a score"}><Eye size={compact ? 16 : 21} /><span>{watched ? "Watched" : "Mark watched"}</span></button>
      <button type="button" className={`title-action ${favorite ? "is-favorite is-active" : ""}`} aria-pressed={favorite} aria-label={`${favorite ? "Remove favorite" : "Favorite"}: ${titleOf(movie)}`} onClick={() => void update({ liked: !favorite })} disabled={busy} title="Favorites count as positive preferences, even with a low rating"><Heart size={compact ? 16 : 21} fill={favorite ? "currentColor" : "none"} /><span>{favorite ? "Favorited" : "Favorite"}</span></button>
      {movie.mediaType !== "other" && <button type="button" className="title-action" onClick={onAdd} disabled={busy}><BookmarkPlus size={compact ? 16 : 21} /><span>Add to list</span></button>}
    </div>
    {!compact && <p className="title-action-note">Favorites count as positive preferences, even with a low rating. Your score stays unchanged.</p>}
    {confirm && <div className="title-action-confirm" role="group" aria-label="Confirm marking this title unwatched"><p>Marking this title unwatched also removes your saved rating. Your favorite stays as it is.</p><button type="button" className="title-action-remove" onClick={() => void update({ watched: false })} disabled={busy}>{pending ? <LoaderCircle size={15} className="spinning" /> : <Trash2 size={15} />}Remove rating &amp; mark unwatched</button><button type="button" className="text-button" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button></div>}
    {error && <p className="title-action-error" role="alert">{error}</p>}
  </div>;
}

export function RemoveRatingButton({ movieId, disabled = false, onRemoved }: { movieId: number; disabled?: boolean; onRemoved?: () => void }) {
  const activity = useTitleActivity();
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!activity.ratings.has(movieId)) return null;
  const pending = activity.pending.has(movieId);
  async function remove() {
    setError("");
    try { if (await activity.removeRating(movieId)) { if (alive.current) onRemoved?.(); } }
    catch (failure) { if (alive.current) setError(message(failure)); }
  }
  return <div className="remove-rating-control"><button type="button" className="text-button remove-score title-action-remove" onClick={() => void remove()} disabled={disabled || pending}>{pending ? <LoaderCircle size={15} className="spinning" /> : <Trash2 size={15} />}Remove rating</button>{error && <p className="title-action-error" role="alert">{error}</p>}</div>;
}
