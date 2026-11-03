# Movie Recommendation System

An end-to-end study of personalized movie retrieval with MovieLens ratings,
genre metadata, and plot text. The central question is whether behavioral
or content-based signals recover more of a user's later likes than a
popularity baseline.

The notebooks expose the reasoning behind each representation, inspect
recommendations, and compare models under one explicit evaluation protocol.
They cover popularity, item-based collaborative filtering, genres, two
TF-IDF variants, two semantic embedding variants, and a collaborative/text hybrid.

## Notebook guide

Read and run the numbered notebooks in order, using a fresh kernel for each.
Each notebook states its inputs, outputs, prerequisites, and interpretation
boundaries. Variables do not carry between notebooks; saved artifacts do.

| Notebook | Purpose | Main outputs |
| --- | --- | --- |
| [01 · Data exploration](notebooks/01_data_exploration.ipynb) | Validate source data, create the canonical split, establish popularity | Split CSVs, split manifest, baseline validation results |
| [02 · Collaborative filtering](notebooks/02_collaborative_filtering.ipynb) | Explain and evaluate similarity from shared positive ratings | Per-user CF validation results |
| [03 · Genre-based filtering](notebooks/03_content_based_filtering.ipynb) | Compare a transparent metadata baseline | Per-user genre validation results |
| [04 · Plot preparation and TF-IDF](notebooks/04_plot_text_preparation.ipynb) | Audit cross-dataset links and evaluate lexical plot similarity | Plot catalogs, catalog manifest, two TF-IDF evaluations |
| [05 · Semantic embeddings](notebooks/05_semantic_embeddings.ipynb) | Preserve complete plots through chunking; evaluate and diagnose semantic scores | Embedding archives, encoder manifest, two embedding evaluations |
| [06 · Model comparison](notebooks/06_model_comparison.ipynb) | Verify comparable results and quantify candidate coverage | Validation comparison and coverage tables |
| [07 · Hybrid and final evaluation](notebooks/07_hybrid_recommender.ipynb) | Tune blends, freeze selection, refit, and assess held-out performance | Frozen configuration, test results, paired gain interval |

[Scratch workspace](notebooks/01_scratch.ipynb) is optional and is not part of
the evaluated pipeline. For a quick review, start with notebook 01's protocol,
notebook 06's comparison, and notebook 07's final assessment.

## Evaluation protocol

- Split each user's rating history chronologically: first 60% for training,
  next 20% for validation, and remaining 20% for testing. Round the cumulative
  boundaries down; break equal-timestamp ties by movie ID.
- Treat ratings of at least 4.0 as positive feedback. Rank only movies observed
  in the fitting interactions and exclude every movie the user has already rated.
- Report macro mean Recall@10 across users with positive held-out feedback.
  Keep all held-out positives in the denominator, including unavailable candidates.
- Select models and settings on validation only. Persist the choice before
  opening test labels, then refit on training plus validation for final assessment.

This is an offline benchmark for existing users, not a new-user evaluation or
a replay at one historical deployment date. Different users have different
time boundaries; external text and pretrained features are not guaranteed
to have existed at those rating dates. Recall measures recovery of recorded
likes, not preferences for every unrated recommendation.

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
*The MovieLens Datasets: History and Context.* [DOI](https://doi.org/10.1145/2827872)

### CMU Movie Summary Corpus

For notebook 04 onward, download the [CMU Movie Summary Corpus](https://www.cs.cmu.edu/~ark/personas/)
and place `movie.metadata.tsv` and `plot_summaries.txt` inside
`data/raw/MovieSummaries/`. The notebook reads these local files without API calls.

Attribution: David Bamman, Brendan O'Connor, and Noah A. Smith.
Plot text is distributed under [CC BY-SA 3.0 US](https://creativecommons.org/licenses/by-sa/3.0/us/);
retain attribution and license information when redistributing it.

Raw datasets are excluded from Git. Generated artifacts are stored under
`data/processed/per_user_chronological_60_20_20_v1/`. Manifests record source and
artifact hashes so downstream notebooks can reject incompatible inputs.
Rerun the dependent notebooks after changing source data, splitting, features,
or scoring settings. Existing saved outputs are a reading aid, not a substitute
for executing the current sources with the required local inputs.
