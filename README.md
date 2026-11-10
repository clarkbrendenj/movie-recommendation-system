# Movie Recommendation Project

This project explores how movie ratings can be used to generate
personalized recommendations.

## Movie app

[Afterglow](web/README.md) uses separate MovieLens/IMDb movie and FilmAffinity
whole-series recommendation models. It includes its own accounts, private
ratings, dedicated movie/series rating queues, watchlists, and Together lists.
A vertical 1–10 slider saves scores in tenths. It exposes 6,818 film candidates
and 1,715 series candidates and makes no LLM API calls.

[Deploy the complete app on Cloudflare](web/INDEPENDENT-HOSTING.md), with source
and a manual deployment workflow on GitHub. GitHub Pages alone cannot run its
account, database, or recommendation APIs. The existing private Site remains
separate while independent hosting is set up.

The [web app](web/) contains the interface, user-scoped D1 APIs, deployment
configuration, and sparse JavaScript inference. The
[model exporter](scripts/export_web_model.py) verifies parity with notebook 10
before emitting portable features. See the app README for local setup and tests.

I am building it to develop practical machine learning and NLP skills,
with an emphasis on understanding model behavior and evaluating results.

## Planned approach

- Explore the MovieLens ratings dataset.
- Establish a popularity-based recommendation baseline.
- Build and evaluate personalized recommendation models.
- Explore natural-language movie discovery using text embeddings.

## Current status

The notebooks cover exploration, popularity and collaborative baselines,
genre and plot-text features, embeddings, hybrid recommendations, and learned
collaborative models. Notebook 09 tests director, writer, and cast features.
Notebook 10 tests whether vote-aware IMDb ratings improve the credits hybrid.
Notebook 11 benchmarks a budget-limited LLM reranker against EASE and that hybrid.
Notebook 12 tests direct LLM movie generation from full user rating histories.
Notebook 13 tests graded rating profiles and explicit dislike penalties against
the selected IMDb hybrid.
Notebook 14 tests lowering binary likes from 8/10 to 7/10 in the selected model.
Notebook 15 extends the selected hybrid to whole TV series using frozen content
features, with a separate audit of the small observed TV-rating subset.
Notebook 16 audits public individual-rating sources for whole-series and joint
movie/TV recommendation experiments.

## Environment

The notebooks use a Python 3.14 environment. Core package versions are recorded
in [requirements.txt](requirements.txt). Select the project environment as the
Jupyter kernel and run notebooks from inside the repository.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Notebook 05, and notebook 07 if an embedding model is selected, additionally
require `sentence-transformers`, `torch`, and `tqdm`. These packages are not
included in the current core requirements file:

```bash
python -m pip install sentence-transformers torch tqdm
```

The encoder runs on CPU. Its first load needs internet access unless the model
is cached; full-corpus chunk encoding is substantially slower than the ratings
baselines. The embedding manifest records the encoder revision used by a run.

## Data

### MovieLens Latest Small

Download and extract the September 26, 2018 dataset snapshot into
`data/raw/ml-latest-small/`. The required files are `movies.csv` and `ratings.csv`.

- [Dataset and download](https://grouplens.org/datasets/movielens/latest/)
- [Documentation and usage terms](https://files.grouplens.org/datasets/movielens/ml-latest-small-README.html)

Reference: F. Maxwell Harper and Joseph A. Konstan. 2015.
The MovieLens Datasets: History and Context.
https://doi.org/10.1145/2827872

### CMU Movie Summary Corpus

For notebooks 04 and 09, download the
[Movie Summary Corpus archive](https://www.cs.cmu.edu/~ark/personas/data/MovieSummaries.tar.gz)
and extract it into `data/raw/`, preserving the `MovieSummaries/` directory.
Notebook 04 requires `movie.metadata.tsv` and `plot_summaries.txt`.
See the [corpus documentation and attribution](https://www.cs.cmu.edu/~ark/personas/)
and its CC BY-SA license before redistributing plot text.

### IMDb credits experiment (notebook 09)

Run [notebook 01](notebooks/01_data_exploration.ipynb), then
[notebook 04](notebooks/04_plot_text_preparation.ipynb), then
[notebook 09](notebooks/09_credits_based_recommendations.ipynb).
Notebook 09 prepares its own credit data, or prepare it in advance from the
repository root:

```powershell
.\.venv\Scripts\python.exe scripts/prepare_imdb_credits.py
```

The helper streams the official IMDb crew, principal-credit, and name datasets
(about 1.2 GB transferred on the first run), retaining only MovieLens matches
under `data/raw/imdb/`. It uses `links.csv` for exact IMDb-ID joins, needs no API
key, verifies cached subsets, and records source URLs, retrieval times, and
checksums. Reruns reuse the cache; `--force` explicitly refreshes it. If HTTPS
certificate verification fails on Windows, install `truststore` in the project
environment; the helper uses it when available. Certificate verification is
never disabled.

IMDb's [non-commercial dataset terms](https://data.imdb.com/non-commercial-datasets/)
apply. Cast features use the first five actor/actress principal credits in IMDb
ordering as a proxy for prominent cast, not verified lead roles. Writer roles
are not differentiated in the crew source.

Notebook 09 compares popularity, item-based CF, genre controls, and a tuned
CF + log-TF-IDF plot control with director, writer, and cast additions. It fits
features on the training candidate catalog, evaluates the same validation
users and Recall@10 denominators, and preserves movies with missing credits.
Results and provenance are saved under
`data/processed/per_user_chronological_60_20_20_v1/notebook09_credits/`.
Selection is exploratory and validation-only: notebook 09 never reads test
feedback or changes notebook 07's frozen selection.

Run the numerical, linkage, fallback, and ranking checks with:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

### IMDb ratings experiment (notebook 10)

After notebooks 01, 04, and 09, run
[notebook 10](notebooks/10_imdb_ratings_recommendations.ipynb). It reconstructs
notebook 09's selected CF + plots + credits control and verifies its saved
per-user validation results before adding an IMDb audience-rating signal.

The notebook prepares its ratings automatically, or prepare them in advance:

```powershell
.\.venv\Scripts\python.exe scripts/prepare_imdb_ratings.py
```

The helper streams IMDb's official `title.ratings.tsv.gz`, joins `averageRating`
and `numVotes` through exact IDs in MovieLens `links.csv`, and caches only
matching rows with source timestamps and checksums. No API key is required.
Reruns verify and reuse the cache; `--force` refreshes it. The same IMDb
[non-commercial dataset terms](https://data.imdb.com/non-commercial-datasets/)
and HTTPS verification policy as the credits helper apply.

To reduce the influence of small vote counts, the model shrinks each IMDb
average toward the mean among rated training-candidate movies, with a fixed
1,000-vote prior. A tunable centered quality adjustment reranks personalized
scores; missing ratings contribute zero adjustment and never remove movies.
This smoothing is our model choice, not IMDb's internal rating formula.

Notebook 10 compares popularity, IMDb-only, CF + plots, and the credits hybrid,
with and without ratings. It uses the same validation users, seen exclusions,
Recall@10 and NDCG@10 denominators, checks the zero-weight control, and saves
the full weight grid, paired changes, per-user results, readable examples, and
provenance under
`data/processed/per_user_chronological_60_20_20_v1/notebook10_imdb_ratings/`.

IMDb aggregates are current snapshots and can include votes posted after the
MovieLens interactions. Results are retrospective and validation-selected;
they are not evidence of historically available performance. Notebook 10 never
reads test feedback or changes notebook 07's frozen selection. Run its linkage,
cache, smoothing, and reranking checks with the unittest command above.

### LLM reranking pilot (notebook 11)

After notebooks 01, 04, 09, and 10, open
[notebook 11](notebooks/11_llm_reranking_experiment.ipynb). It samples 100
validation users reproducibly, retrieves 100 unseen movies per user with EASE
(fixed regularization 50), and asks GPT-6 Luna to rank ten of those movies.
Only the most recent 30 training ratings and movie metadata enter the prompts.
Validation positives never enter prompts or candidate construction. EASE and
the IMDb hybrid are scored on the same users, with shared-shortlist and
full-catalog baselines reported separately.

Prepare requests and evaluate baselines without making API calls:

```powershell
.\.venv\Scripts\python.exe scripts/llm_recommendation_experiment.py
```

Set `OPENAI_API_KEY` securely in the environment, or copy
[.env.example](.env.example) to a local `.env` and fill it in. The real key must
never appear in notebook source, chat, or Git. The existing ignore rules cover
`.env` and all caches under `data/`. The runner uses Python's HTTPS client;
no OpenAI SDK installation is needed.

Make live requests explicitly (or set `RUN_LIVE = True` in notebook 11):

```powershell
.\.venv\Scripts\python.exe scripts/llm_recommendation_experiment.py --live
```

If a key is rejected with HTTP 401, replace it locally and resume explicitly:

```powershell
.\.venv\Scripts\python.exe scripts/llm_recommendation_experiment.py --live --retry-auth-failures
```

This preserves the failed attempt and its original budget reservation. Other
failed or uncertain calls are never automatically retried.

The client permits at most **$1 in cumulative conservative cost reservations**
at the recorded GPT-6 Luna rates, limits output to 512 tokens, disables tools
and reasoning, makes one call at a time, and never retries automatically.
It caches successful, invalid, and failed responses by complete request hash.
Uncertain calls retain their cost reservation; concurrent live runs are blocked.
This client safeguard is not an account-level billing limit. Check current
[model pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
before future runs, keep Auto Recharge off when using only included credits,
and do not delete the ledger to bypass the ceiling.

Results include shortlist coverage, Recall@10, NDCG@10, paired user-bootstrap
intervals, response validity, latency, returned model versions, and token cost
estimates. Failed LLM responses count as empty lists; a separately labeled EASE
fallback is also evaluated. Users are never dropped, all validation positives
remain in metric denominators, and partial live runs do not produce an LLM
leaderboard. Exports and provenance are saved under
`data/processed/per_user_chronological_60_20_20_v1/notebook11_llm_reranking/`.
This is an exploratory retrospective pilot, not an independent test result.

### Direct LLM recommendations (notebook 12)

[Notebook 12](notebooks/12_llm_direct_recommendations.ipynb) tests an LLM as an
independent movie recommender. It receives each user's **entire training-rating
history**, as movie titles and star ratings, and generates ten recommendations
using its pretrained knowledge. It receives no shortlist, model scores, movie
IDs, plot/cast metadata, or IMDb averages. No browsing tools are enabled.

The experiment reuses notebook 11's 100 users and verified full-catalog EASE
and IMDb hybrid baselines. Match generated titles and years to the catalog
only after generation. The fixed matcher uses normalized titles, MovieLens
aliases, and exact release years; ambiguous matches are not guessed. Invalid,
unmatched, duplicate, already-rated, and outside-training-catalog suggestions
receive no hits and retain their original rank positions. Every validation
positive remains in metric denominators. Catalog mismatches and incomplete
rating labels limit what this offline benchmark says about open-world quality.

Prepare offline, then enable API calls explicitly if desired:

```powershell
.\.venv\Scripts\python.exe scripts/llm_direct_recommendations.py
.\.venv\Scripts\python.exe scripts/llm_direct_recommendations.py --live
```

Credentials use the same local setup as notebook 11. Both experiments share
notebook 11's **existing $1 reservation ledger and lock**; previous reservations
are preserved. The full pending batch must fit the remaining allowance before
new requests start. Calls are cached, automatic retries are disabled, and
notebook 12 defaults to no API calls. Output includes generated titles, matching
audits, full-catalog metrics, paired intervals, usage, and provenance under
`data/processed/per_user_chronological_60_20_20_v1/notebook12_llm_direct/`.
This remains exploratory validation and does not read test feedback.

### Negative and graded ratings (notebook 13)

[Notebook 13](notebooks/13_negative_ratings_recommendations.ipynb) compares the
selected notebook-10 model against weighted likes and centered all-rating
profiles, each with a small prespecified grid of dislike penalties. It keeps
the training-only feature basis, candidate catalog and hybrid weights frozen,
verifies the original per-user validation metrics, excludes all rated movies,
and evaluates the same validation-positive users and full denominators.

The notebook displays ratings on a 1–10 scale; MovieLens storage remains
0.5–5. Graded likes distinguish 8/9/10. Explicit dislikes use 1–4/10; the
all-centered variant uses 6/10 as neutral, 7–10 as positive, and 1–5 as negative.
Positive and negative affinities are normalized separately, then a penalty is
subtracted before adding the frozen IMDb prior once. These are profile-scoring
experiments, not retraining the collaborative feature basis on dislikes.

Run top-to-bottom with the existing project kernel, or run locally:

```powershell
.\.venv\Scripts\python.exe scripts/negative_ratings_experiment.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_notebook13.py -v
```

No API key, new download, or service charge is required. Results, per-user
comparisons, profile coverage, selected recommendations, examples and provenance
are saved under
`data/processed/per_user_chronological_60_20_20_v1/notebook13_negative_ratings/`.
The notebook also plots the penalty tradeoff. Selection uses validation Recall@10;
paired user-bootstrap intervals are descriptive and not selection-adjusted.
Observed low-rating hits are an incomplete secondary diagnostic, with unknown
movies never treated as dislikes. Test feedback and the app model are unchanged.

The recorded 594-user run tested 15 variants. The original binary-like control
retained the highest Recall@10 (0.122573). The best nonzero dislike penalty
(binary likes, penalty 0.25) reached Recall@10 0.120948 and NDCG@10 0.143580,
versus control NDCG@10 0.143483: a tiny ranking improvement with lower recall.
All three profile families selected zero penalty under the primary recall
criterion. This does not establish that negative ratings cannot help with a
different model or loss; it evaluates these frozen-basis profile variants.

### Like threshold: 7/10 versus 8/10 (notebook 14)

[Notebook 14](notebooks/14_like_threshold_experiment.ipynb) takes the selected
CF + plots + cast + IMDb model and counts ratings of at least 7/10 (3.5 MovieLens
stars) as likes. It compares four prespecified variants: the original 8+ model,
lowering only the user-profile threshold, lowering only the CF training-like
threshold, and lowering both. Only the collaborative item basis is refit when
its threshold changes; the candidate catalog, content features and blend
weights remain fixed. All previously rated movies remain excluded.

Every variant is evaluated at both 8+ and 7+ held-out relevance thresholds.
Compare models within the same relevance definition and user cohort; changing
the metric's positive definition changes its denominators. A second table
holds the original validation-user cohort fixed. The original model must
reproduce notebook 10's per-user validation metrics before accepting results.

Run the notebook top-to-bottom with the existing project kernel, or run:

```powershell
.\.venv\Scripts\python.exe scripts/like_threshold_experiment.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_notebook14.py -v
```

No API calls or new downloads are required. Artifacts are saved under
`data/processed/per_user_chronological_60_20_20_v1/notebook14_like_threshold/`.
Results include both evaluation definitions, fixed-cohort comparisons, paired
user-bootstrap intervals, full recommendation IDs, examples and provenance.
This is exploratory validation; it does not read test feedback, retune blend
weights, or update the app's model.

In the recorded run, lowering both thresholds to 7+ did not improve Recall@10.
With 8+ held-out relevance (594 users), the original model scored 0.122573 and
the requested 7+ model scored 0.112325 (-8.36% relative). With 7+ relevance
(598 users), the same comparison was 0.115584 versus 0.109538 (-5.23%).
The lower training threshold added 7,266 like events and increased CF movie
coverage from 4,389 to 5,082, but that additional feedback did not translate
into higher macro recall in this experiment.

### Whole TV series (notebook 15)

[Notebook 15](notebooks/15_tv_series_recommendations.ipynb) extends the best
Recall@10 hybrid to whole series and mini-series, retaining binary 8+/10 likes.
It adds a bounded English-language TVmaze page-zero catalog, verified through
exact IMDb title types. Cast uses official IMDb person IDs; episodes, specials
and whole series retain distinct identities. Existing MovieLens series are
not added twice.

New summaries and cast are transformed through the original training-only
TF-IDF and cast vocabulary/IDF. The movie CF basis, hybrid weights, and IMDb
prior center stay fixed. New series have zero collaborative rows because no
individual training histories are available for them. Whole-series ratings
can still contribute content preferences to movie and TV recommendations.
Normalization stays anchored to the original unseen catalog, preserving
original candidate scores.

Prepare metadata once, then run the offline experiment:

```powershell
.\.venv\Scripts\python.exe scripts/prepare_tv_series.py
.\.venv\Scripts\python.exe scripts/tv_series_experiment.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_notebook15.py -v
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_tv_series_data.py -v
```

No paid API is used. The first run streams roughly 1 GB of IMDb data, stores
only matching subsets, and caches TVmaze metadata separately under
`data/raw/notebook15_tv_series/`. Reruns verify and reuse hashes. TVmaze
summaries are attributed under its [CC BY-SA API terms](https://www.tvmaze.com/api);
IMDb's [non-commercial dataset terms](https://data.imdb.com/non-commercial-datasets/)
apply to its data.

The notebook reproduces the original benchmark, reports mixed-catalog metrics
under existing labels, audits the tiny observed TV subset, and compares using
versus ignoring existing TV likes in affected user profiles. Most new series
lack held-out ratings, so generated TV recommendations do not establish measured
TV accuracy. It includes editable personal ratings, examples, feature coverage,
an empty actual-feedback CSV template and provenance. Outputs are under
`data/processed/per_user_chronological_60_20_20_v1/notebook15_tv_series/`.
Test feedback, existing caches and the app model remain unchanged.

The recorded run added 223 series (223 with usable plot features, 188 with
known cast features) to 6,885 original candidates. Original candidate scores
were preserved for all 610 training users, and the 594-user control reproduced
Recall@10 0.122573. The mixed-catalog score remained 0.122573 under the existing
labels. Exact type classification found 27 whole-series validation likes from
17 users; the new series mostly lack individual held-out ratings, so this does
not establish their recommendation accuracy.

The placement audit shows the calibration limitation: new series fill 929 of
6,100 TV-only recommendation slots, but only 12 mixed-list slots, all for users
without training likes. No existing personalized profile receives a new series
in its mixed top 10 with these frozen weights. Use the separate TV list to
inspect content transfer; mixed-list calibration needs further labeled feedback.

### Whole-series ratings source audit (notebook 16)

[Notebook 16](notebooks/16_tv_ratings_dataset_audit.ipynb) audits FilmAffinity,
MyAnimeList 2020, and Douban MovieData-10M against the app's whole-series rating
unit. It joins actual individual ratings to metadata, separates seasons and
episodes, measures shared movie/TV users and history depth, checks date fields,
and records source identities, access failures and usage evidence.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-audit.txt
.\.venv\Scripts\python.exe scripts/prepare_ratings_dataset_audit.py
.\.venv\Scripts\python.exe scripts/ratings_dataset_audit.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_notebook16.py -v
```

The optional requirements file adds PyArrow to the existing environment. The
fetcher pins repository revisions, verifies hashes and byte counts, and stores
inputs separately under `data/raw/notebook16_dataset_audit/`. Its default first
run retrieves both FilmAffinity Parquet tables (about 450 MB), full MAL metadata
and the curator's small rating samples, plus Douban documentation and a bounded
public sample probe. It never accesses the password-gated Douban full archive.
Use `--offline` to verify existing cache without network requests.

Measured results are saved under `data/processed/notebook16_dataset_audit/`.
The comparison distinguishes full snapshots, ordered samples, documented totals,
and inaccessible data. Unit classification is conservative metadata inference;
movie/series candidates and proposed exact-title/year links need review.
FilmAffinity review dates are not verified original rating-event timestamps.
The uploader's license declaration is recorded separately from upstream rights;
Douban's dataset conditions are separate from its code license. This audit
neither trains a model nor changes the app or earlier benchmark feedback.

The recorded audit selected **FilmAffinity as the strongest retrieved prototype
candidate**: 419,827 valid individual scores, including 35,489 ratings on 2,502
likely whole-series entries from 13,094 users. There are 8,350 users with both
movie-candidate and series-candidate ratings, including 1,063 with at least five
of each. These unit counts are metadata inferences; ordinary FilmAffinity movie
entries are inferred from untagged feature-length records. Known examples
include Breaking Bad (497 ratings), The Wire (390), and Dark (184).

The MAL audit retrieved all 17,562 metadata rows but only the curator's 499-row
rating sample (four users); its 57-million-rating population is documented,
not measured here. TV anime entries can be season-specific and have no rating
timestamps in the published sample. Douban remains unranked: its public sample
host returned `[Errno 11001] getaddrinfo failed`, and its full archive is gated.
A current authorized archive or working public sample URL is needed to measure
its whole-series coverage. FilmAffinity still needs manual unit review and a
verified IMDb/TMDB crosswalk before joining its titles to the app's catalog.

### FilmAffinity movie and whole-series model (notebook 17)

[Notebook 17](notebooks/17_filmaffinity_hybrid_recommendations.ipynb) trains a fresh
FilmAffinity version of the hybrid model using the audited notebook-16 exports.
It works offline with the existing environment and downloaded data:

```powershell
.\.venv\Scripts\python.exe scripts/filmaffinity_experiment.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_notebook17.py -v
```

The retrospective cohort requires at least ten retained ratings and three
distinct review dates. Whole review-day groups stay together in an approximately
60/20/20 split. Likes are scores of **8/10 or higher**. The 15-model comparison
includes popularity, training-only Bayesian quality, content, item collaborative
filtering, and a prespecified hybrid grid. Training-only Spanish synopsis TF-IDF,
genres, and normalized cast-name features share FilmAffinity's movie/series IDs.
The hybrid score is additive: `CF + p*synopsis + m*(genres+cast)/2 + q*quality`.
CF/content components are scaled by each user's maximum unseen-item score.

Selection maximizes the equal-weight mean of movie-only and series-only macro
Recall@10. Mixed-catalog Recall/NDCG and separate domain results are also saved.
Every training-rated item is excluded, including low ratings; unavailable
validation positives remain in the metric denominators. All training ratings
contribute to the quality prior, while personalized profiles use likes only.

Outputs, the frozen split/plan, and a reload-verified trained model are saved
under `data/processed/notebook17_filmaffinity/`. The new reserved test is created
and integrity-checked but never parsed for model selection. Earlier MovieLens
feedback and app files are not loaded or changed.

This is an established-user, validation-only study of review-associated scores.
Review dates are proxies, title-unit labels are provisional, metadata is current,
and cast names can collide. Its scores cannot be compared directly with the
earlier MovieLens or LLM experiments. The app model is not automatically replaced.

The recorded run trained on 173,232 ratings from 5,505 users and 10,722 titles
(8,995 movie candidates, 1,727 whole-series candidates). Best personalized weights
were `p=0.25, m=0.25, q=0.10`: movie-only Recall@10 0.048873, series-only 0.072629,
and mixed 0.043430. Plain CF reached 0.046070 / 0.058050 / 0.041024 respectively.
Training popularity won the balanced separate-shelf objective (0.091496), driven
by series-only Recall 0.151309; this is not a personalized-model win.

[Post-selection diagnostics](scripts/filmaffinity_diagnostics.py) reproduce both
frozen winners' mixed and TV-only results against the saved leaderboard and audit
TV placement without retuning. Run them independently after the experiment:

```powershell
.\.venv\Scripts\python.exe scripts/filmaffinity_diagnostics.py
```

The hybrid assigns 7.00% of mixed-list slots to series, but TV Recall for its 985
TV-positive users falls from 7.26% on the TV-only shelf to 0.44% in the actual
mixed top ten. Popularity assigns only 0.024% of mixed slots to series. A future
study should test TV fallbacks for sparse histories and movie/series calibration;
neither shelf scores nor exposure alone justify replacing the app model.

### TV ranking blends and mixed-list policy (notebook 18)

[Notebook 18](notebooks/18_filmaffinity_tv_ranking_policy.ipynb) reuses the frozen
FilmAffinity split and fitted basis, then tests the policy used to compose an
actual ten-title movie/TV list. It makes no paid calls or app changes:

```powershell
.\.venv\Scripts\python.exe scripts/filmaffinity_ranking_policy.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_notebook18.py -v
```

A training-only [source-unit review](scripts/filmaffinity_series_spotcheck.py)
found 12 confirmed season-scoped entries, including independently rated Stranger
Things seasons. Notebook 18 disables those IDs in profiles and candidates and
removes their ineligible validation labels uniformly for all policies. It does
not aggregate season scores into series scores or alter notebooks 16/17. The
fixed sample yielded eight source-supported whole-series entries, three ambiguous
entries, and one season entry; expanded marker review covered 204 descriptions.
Unflagged and ambiguous entries are still provisional, not independently verified.

The original notebook-17 mixed controls are reproduced before cleanup. All
notebook-18 policies then use the same corrected eligibility: 8,995 movie candidates,
1,715 series candidates, 4,143 validation-positive users and 972 TV-positive
users. The original training-user cohort and feature basis are inherited rather
than refitted; original minimum-history eligibility included now-excluded events.

Movie ranking is fixed at the prior best personalized hybrid. TV ranking blends
max-scaled unseen-TV popularity and personalization at weights 0, 0.25, 0.5, 1,
or training-TV-like-count / (count + 5). Each TV choice is crossed with 2, 4 or 6
TV slots, evenly interleaved within ten total titles. Two corrected mixed-list
controls complete the 17 policies. The primary objective is the equal mean of
movie and TV Recall from the actual mixed list; separate shelves, NDCG, exposure,
coverage and 0/1-4/5+ training-TV-like groups are diagnostics.

The selected policy was a **50/50 TV blend with 6 TV and 4 movie slots**. Its
movie / TV / overall mixed Recall was **0.024147 / 0.112027 / 0.035297**, compared
with the corrected hybrid control's **0.047917 / 0.004655 / 0.043512**. TV improves
at a substantial movie cost. The same blend with 2 TV and 8 movie slots reached
**0.040924 / 0.052463 / 0.042900**, a useful tradeoff to inspect rather than the
primary-objective winner. The best observed TV-only shelf used 25% personalization
and 75% popularity: Recall 0.156498 versus popularity's 0.153394. That small
validation difference is not an independent accuracy claim.

Outputs and saved-policy settings are under `data/processed/notebook18_filmaffinity/`.
The notebook reloads the actual selected policy and reproduces per-user metrics
for three training profiles, then demonstrates an editable new-user profile.
No deployment is performed, and the reserved test is never read. This remains
a repeated-validation policy study with provisional units and review-date
proxies, not a fully retrained clean-series model or a general win over an LLM.
