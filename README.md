# Movie Recommendation Project

This project explores how movie ratings can be used to generate
personalized recommendations.

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
