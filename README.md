# Movie Recommendation Project

This project explores how movie ratings can be used to generate
personalized recommendations.

## Movie app

[Afterglow](web/README.md) turns the selected CF + plots + cast + IMDb hybrid
into a movie-rating app. It includes ChatGPT sign-in, private persistent ratings,
search and genre filters, editable half-star ratings, starter picks for new
users, and personalized recommendations that exclude movies already rated.
It serves 6,885 movies from the frozen model catalog and makes no LLM API calls.

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
