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

The Python environment and initial dependencies are configured.
Data exploration and model development have not started.

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