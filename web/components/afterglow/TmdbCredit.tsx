import "./tmdb-credit.css";

/**
 * Approved artwork: TMDB's Primary short (blue) logo, used without alteration.
 * https://www.themoviedb.org/about/logos-attribution?language=en-US
 */
export function TmdbCredit({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;

  return (
    <section className="tmdb-credit" aria-labelledby="tmdb-credit-heading">
      <div className="tmdb-credit-brand">
        <h2 id="tmdb-credit-heading">Credits</h2>
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" aria-label="TMDB — The Movie Database (opens in a new tab)">
          <img src="/credits/tmdb-logo.svg" alt="TMDB" width="78" loading="lazy" decoding="async" />
        </a>
      </div>
      <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </section>
  );
}
