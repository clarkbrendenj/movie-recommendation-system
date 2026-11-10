# Afterglow

A movie and whole-series rating app with two independently selected pipelines.
Movies use the original MovieLens CF + plots + cast + IMDb winner; series use
the FilmAffinity whole-series hybrid with 25% personalization and 75% training
popularity. Movie and TV recommendation views keep the rankers separate.
Dedicated movie and whole-series rating queues feed titles to rate, with
skip-for-now and haven't-seen controls. Private watchlists save titles; Together
lists combine confirmed friends' preferences without exposing their ratings.
Navigation explicitly separates Movie recommendations, TV recommendations, and
the two rating modes. Opening a list replaces the overview with a dedicated
list view and a prominent Back control.

The movie basis retains all 6,885 original feature rows. A documented exact-ID
IMDb overlay excludes 67 known series/episodes from new movie discovery, leaving
6,818 movie candidates. The TV catalog contains 1,715 provisional whole-series
candidates after the 12 confirmed season-unit vetoes. Signed-in users keep one
private rating collection with distinct source ID namespaces.

## Accounts and ratings

The rating interface hides IMDb scores on movie cards and in the rating dialog,
so users can form their own opinion. IMDb data remains part of the trained
recommendation model, but its score is not displayed while rating movies.

Afterglow uses its own username/password accounts and revocable, HttpOnly
session cookies. Each account ID scopes private database reads and writes.
Ratings live in Cloudflare D1 and survive browser/device changes. Personal API
responses are private and never shared through caches. No LLM or OpenAI API key
is used for accounts, rating, or recommendation requests.

The current private Sites deployment retains the host's outer access gate at
the owner's request. That gate is separate from Afterglow accounts. Independent
hosting below removes the platform gate; app accounts continue to protect data.
Older ratings keyed to platform identities remain stored unchanged. They are
not automatically claimed by new accounts: an import must verify ownership.

All rated movies are excluded from future recommendations. Ratings of **8–10**
contribute to the preference profile, following the evaluated model.
With no liked movies, the app shows training-popularity starter picks, with IMDb
quality and movie ID used as deterministic secondary ordering. Lower ratings
exclude movies but do not create a negative preference vector. Rating a movie
does not retrain the global collaborative model or modify another user's taste.

The app accepts ratings from **1.0 to 10.0 in steps of 0.1**. A vertical
red-to-green fader and changing reaction show the selected value beside the
poster, with an explicit save action. Scores convert without rounding to the
model's 0.5–5 scale: 7.6 becomes 3.8, 8 becomes 4, and 10 becomes 5. An appended
schema migration permits the finer precision while preserving existing rows.
An older 4.5-star rating still appears as 9.0/10. `GET /api/me` declares
`ratingScale: 10`; rating writes must include that field to prevent old clients
from silently submitting ratings on the previous scale.

Rating queues use a large Save & Next arrow to the right of the poster/fader,
including on phones. A confirmed save immediately advances and updates the
account's local ratings; it does not wait for a second profile request. Upcoming
titles prefetch while the current title remains editable. Failed saves retain
the current title and score. Editing an existing rating uses the ordinary Save
action rather than advancing the queue.

TV ratings use that same adapter and storage format. FilmAffinity IDs are encoded
in a separate numeric namespace, so movie and series ratings cannot collide.
Existing ratings, including legacy MovieLens TV entries, remain stored; explicit
ID lookup preserves their correct unit labels. There is no database reset.

MovieLens movie IDs are not guessed into FilmAffinity IDs. The movie pipeline
uses recognized MovieLens history; the TV pipeline currently personalizes from
recognized series ratings. It starts with training-popularity picks before the
first liked series. Cross-source movie-to-TV preference transfer needs a verified
title crosswalk and has not been enabled. The TV basis was learned from the
FilmAffinity users' movie and series histories, but their identities are never
equated with app users or MovieLens users.

## Local development

Use Node.js 22.13 or newer. From this folder:

```powershell
npm run install:ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_mushy_bloodstrike.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_massive_luminals.sql
npm run dev
```

Run both SQL commands only for a fresh database. For an existing local database,
apply only its pending migration files in filename order; do not rerun 0000 or
an already applied migration. The independent config below includes a migrations
directory for Wrangler's tracked migration workflow. Local state is ignored under
`.wrangler/`; it is separate from hosted user data. The development preview is
at `http://127.0.0.1:5173`. Create an Afterglow account to test data persistence.
The preview's starter mock identity does not authorize app data.

Checks:

```powershell
node lib/recommender.test.mjs
node lib/rating-scale.test.mjs
node lib/tv-recommender.test.mjs
node lib/media-catalog.test.mjs
node lib/auth-crypto.test.mjs
node lib/auth-migration.test.mjs
node lib/collaboration-policy.test.mjs
node lib/title-format.test.mjs
node lib/title-details.test.mjs
node scripts/app-smoke.mjs
```

The API smoke test requires the local development server. It targets only
loopback and creates disposable `local_test_*` app accounts, leaving existing
users' ratings untouched. Earlier API smoke commands delegate to this current
suite; run it once, rather than invoking each compatibility entry point.
Type-check with `npx tsc --noEmit`; build with `npm run build`.

VS Code's existing Afterglow tasks use the verified portable Node runtime under
the parent project's `data/app-tools/node-v22.23.4-win-x64/`. If Node is not
installed on PATH, add that directory for the current shell before running the
commands above:

```powershell
$nodeDirectory = (Resolve-Path ../data/app-tools/node-v22.23.4-win-x64).Path
$env:Path = "$nodeDirectory;$env:Path"
```

## Model and data

The versioned [model metadata](public/model/metadata.json) records the frozen
weights, source hashes, candidate universe, inference policy, and feature-array
hashes. Binary sparse features load through the Worker's `ASSETS` binding; no
Python runtime, model API, or private external service is required in production.
The `DB` binding stores ratings. Both bindings are declared in
[hosting.json](.openai/hosting.json) and [vite.config.ts](vite.config.ts).

The movie model was exported by the parent project's
[export_web_model.py](../scripts/export_web_model.py). Its Python verifier
reproduces all existing users' top tens when they have liked training movies,
and all 594 recorded validation-user metrics. JavaScript tests compare four
frozen reference cases plus seen exclusion, missing features, input validation,
and cold starts. This verifies implementation parity, not new-user accuracy.

The original movie binary arrays and metadata remain byte-for-byte unchanged.
Its recorded **Recall@10 0.122573** belongs to the original 6,885-candidate
MovieLens validation benchmark. The film-only eligibility overlay is a serving
filter and has not been assigned that unfiltered benchmark score as a new result.
Known TV units were classified by exact IMDb IDs in cached title basics and
MovieLens links; title strings never establish identity. Unknown units remain
unverified. The [overlay generator](../scripts/prepare_movie_unit_overlay.py)
records hashes and exclusions in `public/catalog/movie-unit-exclusions.json`.

The [TV exporter](../scripts/export_tv_web_model.py) preserves the frozen
FilmAffinity scorer selected in notebooks 18/19, with recorded TV-only validation
**Recall@10 0.156498** on 972 users. It exports all 10,722 feature rows for profile
scoring while exposing only eligible series candidates. The 12 confirmed season
entries are blocked from profiles, ratings and recommendations. Feature payloads
use about 5.96 MB. Export verification reproduces every recorded TV-user top ten;
JavaScript checks compare frozen Python reference profiles and numeric scores.
These two datasets' Recall values are separate benchmarks, not a head-to-head
comparison or a promise of live-user accuracy. Unit inference, review-associated
selection and publication-date proxies remain limitations of FilmAffinity data.

The catalog is a historical MovieLens snapshot, not a live new-release feed.
Refreshing or expanding it requires a new offline model export and deployment.
The app cannot recommend movies outside its frozen training-candidate catalog.

MovieLens and IMDb non-commercial dataset terms apply. FilmAffinity source
provenance and uploader terms are recorded in the source audit; candidate units
remain provisional beyond the confirmed exclusions. Dataset attribution is
linked in the footer.

## Display metadata and artwork

`public/catalog/title-details.json` supplies display-only cast/director names
from the existing exact-ID IMDb and FilmAffinity data. Years remain associated
with those same source IDs. The alias-label cleanup matches both the known
series ID and its original title, so genuine names containing `aka` are kept.
Neither title formatting nor display enrichment changes model features, user
ratings, recommendation weights, or the movie/series identity namespaces.

TVmaze supplies verified TV artwork, ended years, and known premiered season
counts. A match must have one exact normalized title and premiere year;
ambiguous matches are omitted. Specials and unaired planned seasons do not
inflate the count. A bounded cached export seeds popular titles, and the client
can enrich other series through the public API. Only public title queries are
sent, without app cookies, user identities, or ratings. Community scores are
never included in the display overlay or shown beside the fader. TVmaze-derived
data is attributed to [TVmaze](https://www.tvmaze.com/) under
[CC BY-SA](https://creativecommons.org/licenses/by-sa/4.0/), with source links
on title details. The JSON overlay is public and may be reused under the
applicable source terms; its TVmaze-derived fields retain that license.

Artwork falls back to the existing theater-style CSS cover when unavailable
or when an image fails. Movie posters need a separate provider connection
(for example, a free non-commercial TMDB API account); no paid service or key
is enabled by this update. Cast, crew, and season details appear when known.

To regenerate display data in the original project checkout with its existing
Python environment and cached raw data:

```powershell
node scripts/build-title-cleanup.mjs
node scripts/build-title-details.mjs --tvmaze-limit 100 --max-requests 200
```

The second command defaults to offline operation without those options. Its
network request budget is explicit; it never trains or modifies either model.

## Hosting

The active independent app is hosted at
https://afterglow.clarkbrendenj.workers.dev with Cloudflare Workers and D1.
Afterglow accounts authorize app data; it has no outer ChatGPT sign-in gate.
The older Sites deployment remains owner-private and separate. Changing hosting
never grants access to another account's ratings. Independent hosting commands
are documented below.
No credentials belong in source, model assets, or hosting configuration.

The app remains part of the parent project checkout. Sites publication keeps
its own source history and sanitized build copy under the ignored parent
`data/afterglow-site-source/`, so it does not replace or nest Git metadata in the
working app. Source access credentials are passed to helpers through memory and
stdin; they are not written into that checkout or the app.
