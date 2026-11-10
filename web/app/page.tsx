"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Bookmark, ChevronDown, Film, LogOut, MonitorPlay, Star, Ticket, UsersRound, X } from "lucide-react";
import { api, initials, message, type Account, type Movie, type Tab } from "../components/afterglow/types";
import { AuthDialog, Busy, ErrorNotice } from "../components/afterglow/ui";
import { DiscoverScreen, HistoryScreen, RatingDialog, RatingScreen } from "../components/afterglow/views";
import { AddToListDialog, ListsScreen } from "../components/afterglow/lists";
import { useTmdbEnabled } from "../components/afterglow/metadata";
import { TmdbCredit } from "../components/afterglow/TmdbCredit";

const NAV = [
  { id: 'movies', label: 'Movie recommendations', icon: Film },
  { id: 'series', label: 'TV recommendations', icon: MonitorPlay },
  { id: 'rate-movies', label: 'Rate movies', icon: Star },
  { id: 'rate-series', label: 'Rate series', icon: Star },
  { id: 'watchlists', label: 'Watchlists', icon: Bookmark },
  { id: 'together', label: 'Together', icon: UsersRound },
] as const;

export default function Home() {
  const tmdbEnabled = useTmdbEnabled();
  const [tab, setTab] = useState<Tab>('movies'), [account, setAccount] = useState<Account | null>(null), [accountLoading, setAccountLoading] = useState(true), [accountError, setAccountError] = useState('');
  const [authOpen, setAuthOpen] = useState(false), [editor, setEditor] = useState<Movie | null>(null), [addTitle, setAddTitle] = useState<Movie | null>(null), [revision, setRevision] = useState(0), [toast, setToast] = useState(''), [loggingOut, setLoggingOut] = useState(false);
  const generation = useRef(0), currentUserId = useRef<string | null>(null), profile = useRef<HTMLDetailsElement>(null);
  const refreshAccount = useCallback(async () => {
    const turn = ++generation.current;
    try { const result = await api<Account>('/api/me'); if (turn === generation.current) { currentUserId.current = result.user?.id || null; setAccount(result); setAccountError(''); } }
    catch (failure) { if (turn === generation.current) setAccountError(message(failure)); throw failure; }
    finally { if (turn === generation.current) setAccountLoading(false); }
  }, []);
  useEffect(() => { void refreshAccount().catch(() => {}); return () => { generation.current++; }; }, [refreshAccount]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer); }, [toast]);
  const user = account?.user ?? null, accountKey = user?.id || 'guest';
  const ratings = useMemo(() => new Map((account?.ratings || []).map(rating => [rating.movieId, rating.rating])), [account?.ratings]);
  const navigate = useCallback((next: Tab) => { setTab(next); if (profile.current) profile.current.open = false; window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  function signIn() { setEditor(null); setAddTitle(null); setAuthOpen(true); if (profile.current) profile.current.open = false; }
  function addToList(movie: Movie) { if (!user) { signIn(); return; } setEditor(null); setAddTitle(movie); }
  async function saved(change?: { movieId: number; rating: number | null }) {
    if (change) {
      // The PUT/DELETE already succeeded. Update this account immediately and
      // invalidate older profile responses without delaying the next title.
      const ownerId = user?.id;
      if (!ownerId || currentUserId.current !== ownerId) return;
      generation.current++;
      setAccount(previous => previous?.user?.id === ownerId ? { ...previous,
        ratings: [...previous.ratings.filter(entry => entry.movieId !== change.movieId),
          ...(change.rating === null ? [] : [{ movieId: change.movieId, rating: change.rating }])] } : previous);
      setAccountError(''); setAccountLoading(false); setRevision(value => value + 1);
      return;
    }
    await refreshAccount(); setRevision(value => value + 1);
  }
  async function signedIn() { setEditor(null); setAddTitle(null); await saved(); setToast('Welcome to your picture house.'); }
  async function logout() {
    if (loggingOut) return; setLoggingOut(true);
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); generation.current++; currentUserId.current = null; setEditor(null); setAddTitle(null); setAccount(null); await saved(); setToast('You’re signed out. See you at the next showing.'); }
    catch (failure) { setToast(message(failure)); }
    finally { setLoggingOut(false); if (profile.current) profile.current.open = false; }
  }
  return <div className="picture-house">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <header className="house-header"><div className="header-inner"><button className="wordmark" onClick={() => navigate('movies')} aria-label="Afterglow home"><span className="brand-emblem"><Star size={30} strokeWidth={1} /></span><span><strong>afterglow<span className="brand-dot">✦</span></strong><small>YOUR PRIVATE PICTURE HOUSE</small></span></button><div className="header-right"><span className="header-welcome">GOOD STORIES. GREAT COMPANY.</span>{user ? <details className="profile-menu" ref={profile}><summary><span className="avatar">{initials(user.displayName)}</span><span>{user.displayName}</span><ChevronDown size={14} /></summary><div className="profile-dropdown"><span className="profile-caption">@{user.username}</span><button onClick={() => navigate('history')}><Star size={15} />My ratings<span>{ratings.size}</span></button><button onClick={() => navigate('together')}><UsersRound size={15} />My friends</button><button onClick={() => void logout()} disabled={loggingOut}><LogOut size={15} />{loggingOut ? 'Signing out…' : 'Sign out'}</button></div></details> : <button className="header-signin" onClick={signIn} disabled={accountLoading}><Ticket size={17} />Sign in <ArrowUpRight size={15} /></button>}</div></div><div className="nav-wrap"><nav aria-label="Main navigation" className="house-nav">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={16} strokeWidth={1.6} /><span>{label}</span></button>)}</nav></div></header>
    <main id="main-content" className="page-content" tabIndex={-1}>
      {accountError && <ErrorNotice text={accountError} retry={() => { setAccountLoading(true); void refreshAccount().catch(() => {}); }} />}
      {accountLoading ? <Busy text="Opening the picture house…" /> : <div className="screen-enter" key={`${accountKey}:${tab}`}>
        {(tab === 'movies' || tab === 'series') && <DiscoverScreen key={`${accountKey}:${tab}`} kind={tab} user={user} ratings={ratings} onRate={setEditor} onAdd={addToList} onNavigate={navigate} revision={revision} />}
        {(tab === 'rate-movies' || tab === 'rate-series') && <RatingScreen key={`${accountKey}:${tab}`} kind={tab === 'rate-movies' ? 'movies' : 'series'} user={user} ratings={ratings} onAuth={signIn} onSaved={saved} onAdd={addToList} onToast={setToast} />}
        {(tab === 'watchlists' || tab === 'together') && <ListsScreen key={`${accountKey}:${tab}`} kind={tab === 'watchlists' ? 'watchlist' : 'together'} user={user} ratings={ratings} onAuth={signIn} onRate={setEditor} onAdd={addToList} onToast={setToast} onNavigate={navigate} revision={revision} />}
        {tab === 'history' && <HistoryScreen key={`${accountKey}:history`} user={user} ratings={ratings} revision={revision} onAuth={signIn} onRate={setEditor} onAdd={addToList} />}
      </div>}
    </main>
    <footer className="house-footer"><div className="footer-inner"><span className="footer-wordmark">afterglow <span>✦</span></span><p>A little less scrolling. A little more cinema.</p><div className="footer-sources">Personal, non-commercial use · Catalogs &amp; research: <a href="https://grouplens.org/datasets/movielens/" target="_blank" rel="noreferrer">MovieLens</a>, <a href="https://developer.imdb.com/non-commercial-datasets/" target="_blank" rel="noreferrer">IMDb</a> &amp; <a href="https://huggingface.co/datasets/naim-prog/filmaffinity-reviews-info" target="_blank" rel="noreferrer">FilmAffinity data</a>. TV metadata &amp; artwork: <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer">TVmaze</a> (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA</a>).</div><TmdbCredit enabled={tmdbEnabled} /></div></footer>
    {toast && <div className="toast" role="status"><Star size={17} /><span>{toast}</span><button className="icon-button" onClick={() => setToast('')} aria-label="Dismiss message"><X size={17} /></button></div>}
    {authOpen && <AuthDialog key={`auth:${accountKey}`} onClose={() => setAuthOpen(false)} onComplete={signedIn} />}
    {editor && <RatingDialog key={`${accountKey}:${editor.movieId}`} movie={editor} initial={ratings.get(editor.movieId) ?? 7} hasRating={ratings.has(editor.movieId)} user={user} onClose={() => setEditor(null)} onAuth={signIn} onSaved={saved} onAdd={() => addToList(editor)} />}
    {addTitle && user && <AddToListDialog key={`${accountKey}:${addTitle.movieId}`} movie={addTitle} onClose={() => setAddTitle(null)} onAdded={() => { setAddTitle(null); setRevision(value => value + 1); setToast('Saved to your watchlist. A future favorite awaits.'); }} />}
  </div>;
}
