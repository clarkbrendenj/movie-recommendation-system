"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Clapperboard, Film, LoaderCircle, LogOut, Search, Sparkles, Star, X } from "lucide-react";

type Movie = { movieId: number; title: string; genres: string[]; year: number | null; popularity: number; score?: number; reason?: string };
type Rating = { movieId: number; rating: number };
type Account = { ratingScale: 10; user: { id: string; displayName: string } | null; ratings: Rating[]; model: { name: string; candidateCount: number } };
type MoviePage = { movies: Movie[]; total: number; page: number; pageSize: number };
type Recommendations = { movies: Movie[]; mode: "personalized" | "starter"; likes: number; ratingsCount: number };
type Tab = "for-you" | "explore" | "ratings";

const SIGN_IN = "/signin-with-chatgpt?return_to=%2F";
const GENRES = ["Action", "Adventure", "Animation", "Children", "Comedy", "Crime", "Documentary", "Drama", "Fantasy", "Film-Noir", "Horror", "Musical", "Mystery", "Romance", "Sci-Fi", "Thriller", "War", "Western"];
const PALETTES = [
  ["#173e3c", "#f0dfb7", "#dc6a40"], ["#e9b56a", "#302f27", "#a54935"],
  ["#a34837", "#fff0d6", "#e3b768"], ["#283d55", "#f3e9d3", "#c6a775"],
  ["#cecbbc", "#303c32", "#a3543f"], ["#434337", "#f1e3ba", "#c7925f"],
  ["#755766", "#f8dfb4", "#b9b79b"], ["#c76c44", "#f9edcd", "#5b5141"],
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) throw new Error(response.status === 401 ? "Please sign in to save your ratings." : "Something went wrong. Please try again.");
  return response.json() as Promise<T>;
}

function movieTitle(movie: Movie) {
  const title = movie.title.replace(/\s*\(\d{4}\)\s*$/, "");
  return title.replace(/^(.*), (The|A|An)$/, "$2 $1");
}

function Poster({ movie, small = false }: { movie: Movie; small?: boolean }) {
  const hash = [...movie.title].reduce((sum, letter) => sum + letter.charCodeAt(0), movie.movieId);
  const [background, ink, accent] = PALETTES[hash % PALETTES.length];
  const title = movieTitle(movie);
  const longestWord = Math.max(1, ...title.split(/\s+|[-–—]/).map(word => word.length));
  return (
    <div className={`poster-art poster-variation-${hash % 4} ${small ? "poster-small" : ""}`} style={{ "--poster-bg": background, "--poster-ink": ink, "--poster-accent": accent, "--poster-word-width": longestWord * 0.8 } as CSSProperties} aria-hidden="true">
      <div className="poster-grain" /><div className="poster-frame" />
      <span className="poster-kicker">THE CINEMA COLLECTION</span>
      <div className="poster-orbit"><span /><span /></div><div className="poster-rays" />
      <span className={`poster-title ${title.length > 28 ? "poster-title-long" : ""}`}>{title}</span>
      <div className="poster-caption"><span>AN AFTERGLOW SELECTION</span><span>{movie.year || "FILM"}</span></div>
    </div>
  );
}

function MovieCard({ movie, rating, onRate, showReason }: { movie: Movie; rating?: number; onRate: (movie: Movie) => void; showReason?: boolean }) {
  return (
    <article className="movie-card">
      <button className="poster-button" onClick={() => onRate(movie)} aria-label={`Rate ${movieTitle(movie)}`}>
        <Poster movie={movie} />

        <span className="poster-hover"><Star size={18} /> Rate this film</span>
      </button>
      <div className="movie-information">
        <h3><button onClick={() => onRate(movie)}>{movieTitle(movie)}</button></h3>
        <p className="movie-meta">{movie.year || "Year unknown"}<span>·</span>{movie.genres.filter(genre => genre !== "(no genres listed)").slice(0, 2).join(" / ") || "Cinema"}</p>
        {showReason && movie.reason && <p className="movie-reason">{movie.reason}</p>}
        <button className={`rate-button ${rating ? "is-rated" : ""}`} onClick={() => onRate(movie)}>
          <Star size={15} fill={rating ? "currentColor" : "none"} />
          {rating ? <><strong>{rating}/10</strong><span>Your rating</span></> : <span>Seen it? Rate it</span>}
          <span className="rate-button-arrow"><ArrowUpRight size={15} /></span>
        </button>
      </div>
    </article>
  );
}

function LoadingFilms() {
  return <div className="movie-grid" aria-label="Loading films" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div className="movie-skeleton" key={index}><div /><span /><span /></div>)}</div>;
}

function EmptyState({ icon = "film", title, description, action }: { icon?: "film" | "star"; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon === "star" ? <Star size={29} /> : <Film size={29} />}</span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export default function Home() {
  const [account, setAccount] = useState<Account | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("for-you");
  const [recommendations, setRecommendations] = useState<Recommendations | null>(null);
  const [recommendationsLoading, setRecommendationsLoading] = useState(true);
  const [recommendationsError, setRecommendationsError] = useState(false);
  const [recRevision, setRecRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [sort, setSort] = useState("popular");
  const [page, setPage] = useState(1);
  const [catalogue, setCatalogue] = useState<MoviePage | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState(false);
  const [browseRevision, setBrowseRevision] = useState(0);
  const [ratedMovies, setRatedMovies] = useState<Movie[]>([]);
  const [ratingsLoading, setRatingsLoading] = useState(false);
  const [ratingsError, setRatingsError] = useState(false);
  const [ratingsRevision, setRatingsRevision] = useState(0);
  const [activeMovie, setActiveMovie] = useState<Movie | null>(null);
  const [selectedRating, setSelectedRating] = useState(0);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const filmsRef = useRef<HTMLElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const ratingsById = useMemo(() => new Map((account?.ratings || []).map(rating => [rating.movieId, rating.rating])), [account?.ratings]);
  const likes = (account?.ratings || []).filter(rating => rating.rating >= 8).length;
  const personal = recommendations?.mode === "personalized";
  const ratingsCount = account ? account.ratings.length : recommendations?.ratingsCount || 0;

  useEffect(() => {
    let cancelled = false;
    api<Account>("/api/me").then(result => { if (!cancelled) setAccount(result); }).catch(() => { if (!cancelled) setToast("We couldn’t load your profile. Refresh to try again."); }).finally(() => { if (!cancelled) setAccountLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Pending state follows this cancellable network request, including refreshes after a rating.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecommendationsLoading(true); setRecommendationsError(false);
    api<Recommendations>("/api/recommendations?limit=12", { signal: controller.signal }).then(setRecommendations).catch(error => { if (error.name !== "AbortError") setRecommendationsError(true); }).finally(() => { if (!controller.signal.aborted) setRecommendationsLoading(false); });
    return () => controller.abort();
  }, [recRevision]);

  useEffect(() => { const timeout = setTimeout(() => setDebouncedQuery(query), 280); return () => clearTimeout(timeout); }, [query]);

  useEffect(() => {
    if (tab !== "explore") return;
    const controller = new AbortController();
    // Search, filtering and pagination share this cancellable request lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBrowseLoading(true); setBrowseError(false);
    const params = new URLSearchParams({ q: debouncedQuery, genre, page: String(page), sort });
    api<MoviePage>(`/api/movies?${params}`, { signal: controller.signal }).then(result => {
      setCatalogue(previous => page > 1 && previous ? { ...result, movies: [...previous.movies, ...result.movies] } : result);
    }).catch(error => { if (error.name !== "AbortError") setBrowseError(true); }).finally(() => { if (!controller.signal.aborted) setBrowseLoading(false); });
    return () => controller.abort();
  }, [tab, debouncedQuery, genre, page, sort, browseRevision]);

  useEffect(() => {
    if (tab !== "ratings" || !account?.user) return;
    const controller = new AbortController();
    // Clear the remote collection when its final rating is removed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!account.ratings.length) { setRatedMovies([]); setRatingsLoading(false); return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRatingsLoading(true); setRatingsError(false);
    const ids = account.ratings.map(rating => rating.movieId);
    const chunks = Array.from({ length: Math.ceil(ids.length / 24) }, (_, index) => ids.slice(index * 24, (index + 1) * 24));
    Promise.all(chunks.map(chunk => api<MoviePage>(`/api/movies?ids=${chunk.join(",")}`, { signal: controller.signal }))).then(results => {
      const movies = new Map(results.flatMap(result => result.movies).map(movie => [movie.movieId, movie]));
      setRatedMovies(ids.map(id => movies.get(id)).filter((movie): movie is Movie => Boolean(movie)));
    }).catch(error => { if (error.name !== "AbortError") setRatingsError(true); }).finally(() => { if (!controller.signal.aborted) setRatingsLoading(false); });
    return () => controller.abort();
  }, [tab, account, ratingsRevision]);

  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timeout); }, [toast]);

  useEffect(() => {
    if (!activeMovie) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modalRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function keyHandler(event: KeyboardEvent) {
      if (event.key === "Escape") { if (!saving) setActiveMovie(null); return; }
      if (event.key !== "Tab") return;
      const elements = modalRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, select, [tabindex='0']");
      if (!elements?.length) return;
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keyHandler);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keyHandler); previousFocus?.focus(); };
  }, [activeMovie, saving]);

  const changeTab = useCallback((next: Tab, scroll = false) => {
    setTab(next); if (next === "explore") setPage(1);
    if (scroll) requestAnimationFrame(() => filmsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  function openRating(movie: Movie) { setSelectedRating(ratingsById.get(movie.movieId) || 0); setActiveMovie(movie); }

  async function saveRating(remove = false) {
    if (!activeMovie || !account?.user || saving) return;
    setSaving(true);
    try {
      if (remove) await api(`/api/ratings?movieId=${activeMovie.movieId}`, { method: "DELETE" });
      else await api("/api/ratings", { method: "PUT", body: JSON.stringify({ movieId: activeMovie.movieId, rating: selectedRating, ratingScale: 10 }) });
      const movieId = activeMovie.movieId;
      setAccount(previous => previous ? { ...previous, ratings: [...previous.ratings.filter(rating => rating.movieId !== movieId), ...(remove ? [] : [{ movieId, rating: selectedRating }])] } : previous);
      setActiveMovie(null); setRecRevision(revision => revision + 1);
      setToast(remove ? "Rating removed. Your picks are being refreshed." : "Rating saved. Your next great watch is getting closer.");
    } catch (error) { setToast(error instanceof Error ? error.message : "We couldn’t save that rating. Please try again."); }
    finally { setSaving(false); }
  }

  const displayedRating = selectedRating;
  const ratingDescription = displayedRating === 0 ? "What did you think?" : displayedRating <= 4 ? "Not for me" : displayedRating <= 6 ? "It was okay" : displayedRating < 9 ? "Really liked it" : "Loved it";
  const shownMovies = tab === "for-you" ? recommendations?.movies || [] : tab === "explore" ? catalogue?.movies || [] : ratedMovies;
  const loading = tab === "for-you" ? recommendationsLoading : tab === "explore" ? browseLoading && page === 1 : ratingsLoading;
  const error = tab === "for-you" ? recommendationsError : tab === "explore" ? browseError && page === 1 : ratingsError;

  return (
    <div className="afterglow-app">
      <a className="skip-link" href="#films">Skip to films</a>
      <header className="site-header"><div className="header-inner">
        <button className="brand" onClick={() => { changeTab("for-you"); window.scrollTo({ top: 0, behavior: "smooth" }); }} aria-label="Afterglow home"><span className="brand-symbol"><Clapperboard size={24} strokeWidth={1.6} /></span><span>afterglow<span className="brand-dot">.</span></span></button>
        <span className="header-tagline">GOOD FILMS STAY WITH YOU.</span>
        <div className="header-account">{accountLoading ? <span className="account-placeholder" aria-label="Loading profile" /> : account?.user ? <details className="account-menu"><summary><span className="avatar">{(account.user.displayName || "F").slice(0, 1).toUpperCase()}</span><span className="account-name">{account.user.displayName || "Film lover"}</span><ChevronDown size={14} /></summary><div className="account-dropdown"><span>Your personal film club</span><button onClick={() => changeTab("ratings", true)}><Star size={15} /> My ratings</button><a href="/signout-with-chatgpt?return_to=%2F" target="_top"><LogOut size={15} /> Sign out</a></div></details> : <a className="header-signin" href={SIGN_IN} target="_top">Sign in <ArrowUpRight size={16} /></a>}</div>
      </div></header>
      <main>
        <section className="hero content-width">
          <div className="hero-copy"><div className="eyebrow"><span className="tiny-star">✳</span> YOUR VERY OWN FILM CLUB</div><h1>Find your next<br /><em>favorite film.</em></h1><p>Less scrolling. More great cinema.<br className="desktop-break" /> Rate the films you’ve seen and discover the ones you’ll love.</p><button className="primary-button" onClick={() => changeTab("explore", true)}>Find a film to rate <ArrowUpRight size={18} /></button><div className="hero-footnote"><span className="small-rule" />{account?.model.candidateCount ? `${account.model.candidateCount.toLocaleString()} films. A world of possibilities.` : "A world of films. A little help finding yours."}</div></div>
          <div className="hero-art" aria-hidden="true"><div className="hero-art-top"><span>AFTERGLOW PICTURE CLUB</span><span>EST. NOW</span></div><div className="hero-art-orbit"><span /><span /></div><span className="hero-art-spark">✳</span><div className="hero-art-title">THE NEXT<br /><i>GOOD</i><br />THING.</div><div className="hero-art-bottom"><span>A FILM YOU HAVEN’T<br />FALLEN IN LOVE WITH. YET.</span><span className="hero-art-arrow">↗</span></div><span className="hero-art-index">01 — INFINITE POSSIBILITIES</span></div>
        </section>
        <section className="film-section content-width" id="films" ref={filmsRef}>
          <div className="discovery-nav"><nav aria-label="Film collection"><button className={tab === "for-you" ? "active" : ""} aria-pressed={tab === "for-you"} onClick={() => changeTab("for-you")}><Sparkles size={16} /> For you</button><button className={tab === "explore" ? "active" : ""} aria-pressed={tab === "explore"} onClick={() => changeTab("explore")}>Explore films</button><button className={tab === "ratings" ? "active" : ""} aria-pressed={tab === "ratings"} onClick={() => changeTab("ratings")}>My ratings{Boolean(account?.ratings.length) && <span className="tab-count">{account?.ratings.length}</span>}</button></nav><span className="nav-aside">YOUR NEXT MOVIE NIGHT, SORTED.</span></div>
          {tab === "for-you" && !personal && !recommendationsError && <div className="taste-note"><div className="taste-note-icon"><Star size={21} strokeWidth={1.5} /></div><div><strong>Your taste is the starting point.</strong><p>Give a film you love 8/10 or higher to unlock personal recommendations.</p></div><button onClick={() => changeTab("explore")}>Start rating <ArrowRight size={16} /></button></div>}
          {tab === "for-you" && personal && <div className="personal-note"><span className="live-dot" />Made for your taste, shaped by {ratingsCount} {ratingsCount === 1 ? "rating" : "ratings"}.<button onClick={() => changeTab("ratings")}>View your ratings <ArrowUpRight size={14} /></button></div>}
          <div className="section-heading"><div><div className="eyebrow section-eyebrow">{tab === "for-you" ? personal ? "YOUR PERSONAL SELECTION" : "THE OPENING SCENE" : tab === "explore" ? "CURIOSITY LOOKS GOOD ON YOU" : "A LITTLE MORE YOU"}</div><h2>{tab === "for-you" ? personal ? "Made for your movie nights." : "A good place to begin." : tab === "explore" ? "There’s a whole world to watch." : "Your life in films."}</h2><p>{tab === "for-you" ? personal ? "Familiar feelings. New favorites. All picked with you in mind." : "Well-loved films to get your taste story started." : tab === "explore" ? "Find an old favorite. Meet a future one. Tell us what you think." : "Every rating tells a little more of your story. Change your mind anytime."}</p></div>{tab === "for-you" && <span className="selection-mark"><Clapperboard size={21} strokeWidth={1.4} /><span>THE AFTERGLOW<br />SELECTION</span></span>}</div>
          {tab === "explore" && <div className="browse-toolbar"><label className="search-field"><Search size={19} /><span className="sr-only">Search films</span><input type="search" placeholder="Search for a film…" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />{query && <button aria-label="Clear search" onClick={() => { setQuery(""); setPage(1); }}><X size={16} /></button>}</label><div className="filter-field"><label className="sr-only" htmlFor="genre-filter">Filter by genre</label><select id="genre-filter" value={genre} onChange={event => { setGenre(event.target.value); setPage(1); }}><option value="">All genres</option>{GENRES.map(value => <option key={value} value={value}>{value}</option>)}</select><ChevronDown size={16} /></div><div className="filter-field sort-field"><label className="sr-only" htmlFor="sort-filter">Sort films</label><select id="sort-filter" value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}><option value="popular">Most popular</option><option value="year">Newest first</option><option value="title">Title A–Z</option></select><ChevronDown size={16} /></div></div>}
          {tab === "ratings" && !account?.user && !accountLoading ? <EmptyState icon="star" title="Your film story starts here." description="Sign in to keep your ratings and get a selection that feels a little more like you." action={<a className="primary-button" href={SIGN_IN} target="_top">Sign in with ChatGPT <ArrowUpRight size={17} /></a>} /> : error ? <EmptyState title="The projector needs a moment." description="We couldn’t load these films. Let’s give it another try." action={<button className="secondary-button" onClick={() => tab === "for-you" ? setRecRevision(value => value + 1) : tab === "explore" ? setBrowseRevision(value => value + 1) : setRatingsRevision(value => value + 1)}>Try again <ArrowRight size={16} /></button>} /> : loading || (tab === "ratings" && accountLoading) ? <LoadingFilms /> : shownMovies.length ? <>
            {tab === "explore" && catalogue && <div className="results-label">{catalogue.total.toLocaleString()} {catalogue.total === 1 ? "film" : "films"}{debouncedQuery && <> matching <strong>“{debouncedQuery}”</strong></>}{genre && <> in <strong>{genre}</strong></>}</div>}
            {tab === "ratings" && <div className="results-label">{account?.ratings.length} {account?.ratings.length === 1 ? "film" : "films"} rated<span className="results-dot">·</span>{likes} loved</div>}
            <div className="movie-grid">{shownMovies.map(movie => <MovieCard key={movie.movieId} movie={movie} rating={ratingsById.get(movie.movieId)} onRate={openRating} showReason={tab === "for-you" && personal} />)}</div>
            {tab === "explore" && catalogue && catalogue.movies.length < catalogue.total && <div className="load-more"><p>Showing {catalogue.movies.length} of {catalogue.total.toLocaleString()} films</p><button className="secondary-button" disabled={browseLoading} onClick={() => browseError ? setBrowseRevision(value => value + 1) : setPage(value => value + 1)}>{browseLoading ? <><LoaderCircle size={17} className="spinning" /> Loading films</> : <>{browseError ? "Try loading again" : "A few more films"} <ArrowRight size={17} /></>}</button>{browseError && <p role="alert">We couldn’t load the next films. Please try again.</p>}</div>}
          </> : tab === "ratings" ? <EmptyState icon="star" title="Every great list starts with one film." description="Find a film you’ve seen and give it a rating. Your collection will live right here." action={<button className="primary-button" onClick={() => changeTab("explore")}>Explore films <ArrowUpRight size={17} /></button>} /> : <EmptyState title={tab === "explore" ? "No films in this scene." : "Time for a new scene."} description={tab === "explore" ? "Try a different title or genre. Your next favorite is out there." : "Explore more films and add a few ratings to find your next great watch."} action={<button className="secondary-button" onClick={() => { setQuery(""); setGenre(""); setPage(1); changeTab("explore"); }}>Explore all films <ArrowRight size={16} /></button>} />}
        </section>
        <section className="closing-note content-width"><span className="closing-asterisk">✳</span><p>Some films end.<br /><em>The good ones stay with you.</em></p><span className="closing-label">HERE’S TO YOUR<br />NEXT FAVORITE.</span></section>
      </main>
      <footer className="site-footer content-width"><span className="footer-brand">afterglow.</span><span>A personal film club. An ever-growing story.</span><span className="data-credits">Film data: <a href="https://grouplens.org/datasets/movielens/" target="_blank" rel="noreferrer">MovieLens</a> &amp; <a href="https://developer.imdb.com/non-commercial-datasets/" target="_blank" rel="noreferrer">IMDb</a><br />A noncommercial research project.</span></footer>
      {activeMovie && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !saving) setActiveMovie(null); }}><div className="rating-modal" role="dialog" aria-modal="true" aria-labelledby="rating-title" ref={modalRef}><button className="modal-close" aria-label="Close rating dialog" onClick={() => setActiveMovie(null)} disabled={saving}><X size={21} /></button><div className="modal-film"><div className="modal-poster"><Poster movie={activeMovie} small /></div><div><div className="eyebrow">YOUR TAKE</div><h2 id="rating-title">{movieTitle(activeMovie)}</h2><p>{activeMovie.year || "Film"}<span>·</span>{activeMovie.genres.slice(0, 2).join(" / ")}</p></div></div>{account?.user ? <div className="rating-content"><h3>{ratingsById.has(activeMovie.movieId) ? "A second take?" : "How did it make you feel?"}</h3><p>Your honest opinion makes the next pick better.</p><div className="rating-options" role="radiogroup" aria-label="Your rating out of 10" onKeyDown={event => {
              const current = selectedRating || 1;
              let next: number | undefined;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(10, current + 1);
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(1, current - 1);
              else if (event.key === "Home") next = 1;
              else if (event.key === "End") next = 10;
              if (next !== undefined) {
                event.preventDefault();
                setSelectedRating(next);
                event.currentTarget.querySelector<HTMLButtonElement>('[data-rating-value="' + next + '"]')?.focus();
              }
            }}>
              {Array.from({ length: 10 }, (_, index) => index + 1).map(value => <button type="button" role="radio" aria-checked={selectedRating === value} aria-label={"Rate " + value + " out of 10"} data-rating-value={value} tabIndex={selectedRating === value || (!selectedRating && value === 1) ? 0 : -1} className={"rating-option " + (selectedRating === value ? "is-selected" : "")} key={value} onClick={() => setSelectedRating(value)} disabled={saving}>{value}</button>)}
            </div><div className="rating-value" aria-live="polite">{displayedRating > 0 && <strong>{displayedRating} <span>/ 10</span></strong>}<span>{ratingDescription}</span></div><button className="primary-button save-rating" disabled={!selectedRating || saving} onClick={() => saveRating()}>{saving ? <><LoaderCircle size={17} className="spinning" /> Saving your take…</> : <><Check size={17} /> Save rating</>}</button>{ratingsById.has(activeMovie.movieId) && <button className="remove-rating" onClick={() => saveRating(true)} disabled={saving}>Remove my rating</button>}<p className="rating-hint">Choose a score from 1 to 10. You can change it anytime.</p></div> : <div className="signin-content"><span className="empty-icon"><Star size={25} /></span><h3>A little taste goes a long way.</h3><p>Sign in to save your ratings and find films that feel made for you.</p><a className="primary-button" href={SIGN_IN} target="_top">Sign in with ChatGPT <ArrowUpRight size={17} /></a><span>Your ratings stay in your own collection.</span></div>}</div></div>}
      {toast && <div className="toast" role="status"><span className="toast-icon"><Check size={16} /></span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}
    </div>
  );
}
