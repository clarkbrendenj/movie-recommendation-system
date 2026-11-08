# Afterglow

A movie-rating app powered by the project's selected CF + plots + cast + IMDb
hybrid. Visitors browse a frozen catalog of 6,885 MovieLens movies; signed-in
users save private half-star ratings and receive recommendations immediately.

## Accounts and ratings

Hosted authentication is provided by **Sign in with ChatGPT**. Each account's
stable Site user ID scopes every database read, update, and delete. Ratings live
in Cloudflare D1 and survive browser/device changes. Personal API responses are
private and are never shared through caches. The app does not use an LLM or an
OpenAI API key, and rating/recommendation requests do not consume API credits.

All rated movies are excluded from future recommendations. Ratings of four or
five stars contribute to the preference profile, following the evaluated model.
With no liked movies, the app shows training-popularity starter picks, with IMDb
quality and movie ID used as deterministic secondary ordering. Lower ratings
exclude movies but do not create a negative preference vector. Rating a movie
does not retrain the global collaborative model or modify another user's taste.

## Local development

Use Node.js 22.13 or newer. From this folder:

```powershell
npm run install:ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_mushy_bloodstrike.sql
npm run dev
```

Apply the migration once to a fresh local database. Local state is ignored under
`.wrangler/`; it is separate from hosted user data. The development preview is
at `http://127.0.0.1:5173`. Its sign-in link uses the starter's loopback-only
Seedy test identity. That simulation is excluded from production; the hosted
platform controls actual authentication.

Checks:

```powershell
node lib/recommender.test.mjs
node scripts/api-smoke.mjs
```

The API smoke test requires the local development server. It refuses to target
a hosted URL, tests only the local mock account, and restores the rating it uses.
Type-check with `npx tsc --noEmit`; build with `npm run build`.

## Model and data

The versioned [model metadata](public/model/metadata.json) records the frozen
weights, source hashes, candidate universe, inference policy, and feature-array
hashes. Binary sparse features load through the Worker's `ASSETS` binding; no
Python runtime, model API, or private external service is required in production.
The `DB` binding stores ratings. Both bindings are declared in
[hosting.json](.openai/hosting.json) and [vite.config.ts](vite.config.ts).

The model was exported by the parent project's
[export_web_model.py](../scripts/export_web_model.py). Its Python verifier
reproduces all existing users' top tens when they have liked training movies,
and all 594 recorded validation-user metrics. JavaScript tests compare four
frozen reference cases plus seen exclusion, missing features, input validation,
and cold starts. This verifies implementation parity, not new-user accuracy.

The catalog is a historical MovieLens snapshot, not a live new-release feed.
Refreshing or expanding it requires a new offline model export and deployment.
The app cannot recommend movies outside its frozen training-candidate catalog.

MovieLens and IMDb non-commercial dataset terms apply. Dataset attribution is
linked in the footer. Artwork is generated with CSS rather than copied posters.

## Hosting

Sites owns hosted sign-in, D1 provisioning, migrations, source versions, and
deployment. Site audience is configured separately from user-data authorization:
changing who can visit never grants access to another account's ratings.
New publications start private until the owner chooses a broader audience.
No credentials belong in source, model assets, or hosting configuration.
