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

Notebooks 01–07 cover exploration, a canonical per-user chronological split,
popularity, collaborative and content models, semantic embeddings, and hybrid
selection with a final holdout evaluation.

Notebook [08_learned_collaborative_filtering.ipynb](notebooks/08_learned_collaborative_filtering.ipynb)
adds BPR matrix factorization and EASE. It compares fixed validation search
grids against recomputed popularity, item-based CF, and hybrid rankings using
Recall@10 and binary NDCG@10.

To run notebook 08, first run notebook 01 to create the canonical split and
notebook 04 to create the plot catalogs. Run notebook 08 from top to bottom
using the project environment. It uses the existing NumPy/SciPy dependencies;
no additional model library is required. Compatible validation results from
notebooks 01, 02, and 07 are checked when present.

Notebook 08 writes its search tables, selected settings, ordered
recommendations, BPR factors, chart, and provenance manifest under
`data/processed/per_user_chronological_60_20_20_v1/notebook08_learned_cf/`.
It is a validation development experiment and does not read test labels or
replace notebook 07's frozen selection. A fresh evaluation phase is needed
for a final claim after further model development.

Focused numerical and ranking checks can be run with:

```powershell
.venv/Scripts/python.exe -m unittest discover -s tests -v
```

## Environment

- Python 3.14.8
- Package versions are recorded in requirements.txt.

## Data source

This project uses MovieLens Latest Small, published by GroupLens
at the University of Minnesota.

- [Dataset and download](https://grouplens.org/datasets/movielens/latest/)
- [Documentation and usage terms](https://files.grouplens.org/datasets/movielens/ml-latest-small-README.html)
- Dataset snapshot: September 26, 2018.

Download `ml-latest-small.zip` and extract its contents into `data/raw/`.
The CSV files should be inside `data/raw/ml-latest-small/`.
Raw data files are excluded from Git.

Reference: F. Maxwell Harper and Joseph A. Konstan. 2015.
The MovieLens Datasets: History and Context.
https://doi.org/10.1145/2827872
