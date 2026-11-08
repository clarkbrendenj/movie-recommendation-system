"""Notebook 15: frozen movie hybrid extended to whole TV series.

New TV titles have content/IMDb features, not invented collaborative feedback.
Run after scripts/prepare_tv_series.py; this runner itself is offline.
"""

from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix, vstack, hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize
from threadpoolctl import threadpool_limits

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.export_web_model import ROOT, file_hash, read_json, require_hash, notebook_functions
from scripts.negative_ratings_experiment import prepare_experiment, weighted_affinity, hybrid_affinity, _check_control
from scripts.like_threshold_experiment import evaluate_threshold


WHOLE_SERIES = {"tvSeries", "tvMiniSeries"}
K = 10


def transform_cast(records, vocabulary, idf):
    """Project exact IMDb nconst IDs through the original person vocabulary/IDF."""
    vocabulary, idf = list(vocabulary), np.asarray(idf, dtype=float)
    if (len(set(vocabulary)) != len(vocabulary) or idf.shape != (len(vocabulary),)
            or not np.isfinite(idf).all() or (idf <= 0).any()):
        raise ValueError("Require a unique cast vocabulary and aligned positive IDF.")
    index = {person: i for i, person in enumerate(vocabulary)}
    rows, columns = [], []
    for row, record in enumerate(records):
        for person in sorted(set(record.get("cast", []))):
            if person in index:
                rows.append(row)
                columns.append(index[person])
    matrix = csr_matrix((np.ones(len(rows)), (rows, columns)), shape=(len(records), len(vocabulary)))
    return normalize(matrix.multiply(idf).tocsr(), norm="l2").tocsr()


def scale_reference(scores, seen, reference_mask):
    """Anchor scales to original unseen candidates; never refit on added TV rows."""
    scores, seen = np.asarray(scores, dtype=float), np.asarray(seen, dtype=bool)
    reference = np.asarray(reference_mask, dtype=bool)
    if (scores.ndim != 2 or scores.shape != seen.shape or reference.shape != (scores.shape[1],)
            or not reference.any() or not np.isfinite(scores).all() or (scores < 0).any()):
        raise ValueError("Require aligned nonnegative scores, seen mask, and a nonempty reference catalog.")
    maximum = np.where(reference[None, :] & ~seen, scores, 0).max(axis=1, keepdims=True)
    return np.divide(scores, maximum, out=np.zeros_like(scores), where=maximum > 0)


def _blend_reference(base, content, weight, seen, reference):
    base, content = scale_reference(base, seen, reference), scale_reference(content, seen, reference)
    usable = np.where(reference[None, :] & ~seen, content, 0).max(axis=1) > 0
    result = base.copy()
    result[usable] = (1 - weight) * base[usable] + weight * content[usable]
    return result


def score_profiles(feedback, features, weights, adjustment, seen, reference_mask):
    """Use the original frozen blend, with zero CF rows for newly added series."""
    adjustment = np.asarray(adjustment, dtype=float)
    if (adjustment.shape != (features["cf"].shape[0],) or not np.isfinite(adjustment).all()
            or (np.abs(adjustment) > 1).any()
            or any(not np.isfinite(weights[name]) or not 0 <= weights[name] <= 1
                   for name in ("plot", "credits", "imdb"))):
        raise ValueError("Require aligned bounded quality adjustments and blend weights.")
    cf = weighted_affinity(feedback, features["cf"])
    plots = weighted_affinity(feedback, features["plots"])
    base = _blend_reference(cf, plots, weights["plot"], seen, reference_mask)
    del cf, plots
    cast = scale_reference(weighted_affinity(feedback, features["cast"]), seen, reference_mask)
    base = _blend_reference(base, cast, weights["credits"], seen, reference_mask)
    return scale_reference(base, seen, reference_mask) + weights["imdb"] * adjustment[None, :]


def validate_profile(ratings, item_ids):
    """Accept integer 1--10 ratings for canonical IDs; likes are 8--10."""
    index = {item: i for i, item in enumerate(item_ids)}
    if len(index) != len(item_ids):
        raise ValueError("Duplicate catalog IDs.")
    seen = np.zeros((1, len(item_ids)), dtype=bool)
    liked = []
    for row in ratings:
        item, rating = row.get("itemId"), row.get("rating10")
        if (not isinstance(item, str) or item not in index or isinstance(rating, (bool, np.bool_))
                or not isinstance(rating, (int, np.integer)) or not 1 <= rating <= 10
                or seen[0, index[item]]):
            raise ValueError("Require unique catalog itemId strings and integer rating10 from 1 to 10.")
        seen[0, index[item]] = True
        if rating >= 8:
            liked.append(index[item])
    return csr_matrix((np.ones(len(liked)), (np.zeros(len(liked), dtype=int), liked)),
                      shape=seen.shape), seen


def _require_same_sparse(actual, expected):
    if actual.shape != expected.shape:
        raise AssertionError("Frozen feature shape changed.")
    difference = actual - expected
    if difference.nnz and np.max(np.abs(difference.data)) > 1e-12:
        raise AssertionError("Frozen original feature values changed.")


def build_extended_model(root=ROOT, context=None):
    context = prepare_experiment(root) if context is None else context
    root, processed = context["root"], context["processed"]
    directory = root / "data/raw/notebook15_tv_series"
    catalog_path, manifest_path = directory / "catalog.json", directory / "manifest.json"
    if not catalog_path.is_file() or not manifest_path.is_file():
        raise FileNotFoundError("TV metadata is missing. Run .venv/Scripts/python.exe scripts/prepare_tv_series.py first.")
    catalog, source = read_json(catalog_path), read_json(manifest_path)
    require_hash(catalog_path, source["catalog_sha256"])
    require_hash(root / "data/raw/ml-latest-small/links.csv", source["links_sha256"])
    for filename, info in source["sources"].items():
        cache_name = "tvmaze_page_0.json" if filename == "tvmaze" else f"{filename}.tsv"
        require_hash(directory / cache_name, info["subset_sha256"])
    metadata = context["metadata"]
    if metadata["creditRoles"] != ["cast"]:
        raise ValueError("This extension expects the selected cast-only credit blend.")
    kinds = {int(row["movieId"]): row for row in catalog["movielens_types"]}
    items = []
    for row in metadata["movies"]:
        info = kinds.get(row["movieId"], {})
        title_type = info.get("titleType")
        items.append({**row, "itemId": f"ml:{row['movieId']}", "imdbId": info.get("imdbId"),
                      "titleType": title_type, "isSeries": title_type in WHOLE_SERIES, "added": False})
    known_imdb = {row["imdbId"] for row in items if row["imdbId"]}
    existing_links = {}
    for row in catalog["movielens_types"]:
        if row.get("imdbId"):
            existing_links.setdefault(row["imdbId"], []).append(int(row["movieId"]))
    new_series = []
    for series in sorted(catalog["series"], key=lambda row: row["imdbId"]):
        imdb_id = series["imdbId"]
        if imdb_id in known_imdb:
            continue
        if series["titleType"] not in WHOLE_SERIES:
            raise ValueError("Only verified whole-series/mini-series items may be added.")
        known_imdb.add(imdb_id)
        links = existing_links.get(imdb_id, [])
        if len(links) > 1:
            raise ValueError(f"Ambiguous MovieLens identities for IMDb series {imdb_id}.")
        ml_id = links[0] if links else None
        item_id = f"ml:{ml_id}" if ml_id is not None else f"imdb:{imdb_id}"
        average, votes = series.get("averageRating"), series.get("numVotes")
        adjustment = 0.0
        if average is not None and votes is not None and np.isfinite(average) and 1 <= average <= 10 and votes > 0:
            center, prior = metadata["imdbPriorCenter"], metadata["imdbPriorVotes"]
            adjustment = (votes / (votes + prior)) * (average - center) / 9
        items.append({"itemId": item_id, "movieId": ml_id, "imdbId": imdb_id,
                      "title": series["title"], "year": series.get("year"), "genres": series["genres"],
                      "titleType": series["titleType"], "isSeries": True, "added": True, "popularity": 0,
                      "imdbRating": average, "imdbVotes": votes, "imdbAdjustment": float(adjustment),
                      "tvmazeUrl": series["tvmazeUrl"]})
        new_series.append(series)
    if not new_series:
        raise ValueError("The bounded source catalog contains no additional whole series.")
    item_ids = [row["itemId"] for row in items]
    if len(set(item_ids)) != len(items):
        raise ValueError("Expanded item identity collision.")
    n = len(context["ids"])
    vectorizer = TfidfVectorizer(stop_words="english", min_df=2, sublinear_tf=True, norm="l2")
    plots = pd.read_csv(processed / "training_plot_catalog.csv").set_index("movieId").loc[context["ids"], "plot"].fillna("")
    original_plots = vectorizer.fit_transform(plots).tocsr()
    _require_same_sparse(original_plots, context["features"]["plots"])
    credits = read_json(root / "data/raw/imdb/movielens_credits.json")["movies"]
    original_cast, vocabulary = notebook_functions(root)["build_role_features"](credits, context["ids"], "cast")
    _require_same_sparse(original_cast, context["features"]["cast"])
    lookup = {int(row["movieId"]): row for row in credits}
    counts = Counter(person for item in context["ids"] for person in set(lookup.get(int(item), {}).get("cast", [])))
    idf = np.array([np.log((1 + n) / (1 + counts[person])) + 1 for person in vocabulary])
    new_plots = vectorizer.transform([row["summary"] for row in new_series]).tocsr()
    new_cast = transform_cast(new_series, vocabulary, idf)
    features = {"cf": vstack([context["features"]["cf"], csr_matrix((len(new_series), len(context["users"])))], format="csr"),
                "plots": vstack([original_plots, new_plots], format="csr"),
                "cast": vstack([original_cast, new_cast], format="csr")}
    reference = np.arange(len(items)) < n
    coverage = pd.DataFrame(items)[["itemId", "title", "titleType", "isSeries", "added"]]
    for name, matrix in features.items():
        coverage[f"has_{name}"] = matrix.getnnz(axis=1) > 0
    return {"context": context, "items": items, "item_ids": item_ids, "features": features,
            "reference": reference, "adjustment": np.array([row["imdbAdjustment"] for row in items]),
            "counts": np.array([row["popularity"] for row in items]), "coverage": coverage,
            "kinds": kinds, "source_manifest": source, "source_manifest_path": manifest_path,
            "tv_catalog_path": catalog_path}


def _rank_rows(model, scores, seen, allowed=None):
    allowed = np.ones(len(model["items"]), dtype=bool) if allowed is None else np.asarray(allowed, dtype=bool)
    rankings = {}
    ids = np.asarray(model["item_ids"])
    for row, user in enumerate(model["context"]["users"]):
        available = np.flatnonzero(allowed & ~seen[row])
        # Old ties must use numeric MovieLens IDs, not lexicographic ml: strings.
        # This sort key preserves the exact original ID order and puts new TV after it.
        tie_ids = np.array([model["items"][i]["movieId"] if model["items"][i]["movieId"] is not None
                            else 1_000_000_000 + i for i in available])
        order = np.lexsort((tie_ids, -model["counts"][available], -scores[row, available]))
        rankings[int(user)] = ids[available[order[:K]]].tolist()
    return rankings


def recommend_profile(model, ratings, kind="mixed", k=10):
    """Rate any catalog movie or whole series; return real model inference."""
    if kind not in {"mixed", "series", "movies"} or type(k) is not int or k < 1:
        raise ValueError("Use mixed, series, or movies and a positive k.")
    feedback, seen = validate_profile(ratings, model["item_ids"])
    scores = score_profiles(feedback, model["features"], model["context"]["metadata"]["weights"],
                            model["adjustment"], seen, model["reference"])[0]
    allowed = np.array([True if kind == "mixed" else row["isSeries"] if kind == "series"
                        else row["titleType"] == "movie" for row in model["items"]])
    available = np.flatnonzero(allowed & ~seen[0])
    tie_ids = np.array([model["items"][i]["movieId"] if model["items"][i]["movieId"] is not None
                        else 1_000_000_000 + i for i in available])
    order = np.lexsort((tie_ids, -model["counts"][available], -scores[available]))
    return pd.DataFrame([{**model["items"][i], "rank": rank, "score": float(scores[i])}
                         for rank, i in enumerate(available[order[:k]], 1)])


def run_experiment(root=ROOT, model=None):
    model = build_extended_model(root) if model is None else model
    context, items = model["context"], model["items"]
    train = context["train"]
    likes = train.loc[train["rating"] >= 4]
    rows = pd.Index(context["users"]).get_indexer(likes["userId"])
    cols = pd.Index(context["ids"]).get_indexer(likes["movieId"])
    feedback = csr_matrix((np.ones(len(likes)), (rows, cols)), shape=context["seen"].shape)
    extended_feedback = hstack([feedback, csr_matrix((len(context["users"]), len(items) - len(context["ids"])))], format="csr")
    seen = np.pad(context["seen"], ((0, 0), (0, len(items) - len(context["ids"]))), constant_values=False)
    series_mask = np.array([row["isSeries"] for row in items])
    with threadpool_limits(limits=2):
        original_scores = hybrid_affinity(feedback, context["features"], context["metadata"], context["seen"])
        original_scores += context["metadata"]["weights"]["imdb"] * context["adjustment"][None, :]
        scores = score_profiles(extended_feedback, model["features"], context["metadata"]["weights"],
                                model["adjustment"], seen, model["reference"])
        np.testing.assert_allclose(scores[:, model["reference"]], original_scores, rtol=0, atol=1e-12)
        baseline = _rank_rows(model, scores, seen, model["reference"])
        joint = _rank_rows(model, scores, seen)
        tv_only = _rank_rows(model, scores, seen, series_mask)
        original_tv = _rank_rows(model, scores, seen, series_mask & model["reference"])
        tv_profile_cols = np.flatnonzero(series_mask)
        no_tv_feedback = extended_feedback.copy().tolil()
        no_tv_feedback[:, tv_profile_cols] = 0
        no_tv_feedback = no_tv_feedback.tocsr()
        no_tv_feedback.eliminate_zeros()
        no_tv_scores = score_profiles(no_tv_feedback, model["features"], context["metadata"]["weights"],
                                      model["adjustment"], seen, model["reference"])
        without_tv_profile = _rank_rows(model, no_tv_scores, seen, model["reference"])
    validation = context["validation"].copy()
    validation["movieId"] = validation["movieId"].map(lambda value: f"ml:{int(value)}")
    baseline_metrics = evaluate_threshold(baseline, validation)
    parity = _check_control(context, baseline_metrics)
    metric_frames, summaries = [], []
    def record(label, rankings, labels, requested_users=None, task="original validation labels"):
        frame = evaluate_threshold(rankings, labels, users=requested_users)
        frame["variant"], frame["task"] = label, task
        metric_frames.append(frame)
        summaries.append({"variant": label, "task": task, "users": len(frame),
                          "heldout_positive_events": int(frame["n_positives"].sum()),
                          "hits_at_10": int(frame["hits_at_10"].sum()),
                          "mean_recall_at_10": frame["recall_at_10"].mean() if len(frame) else None,
                          "mean_ndcg_at_10": frame["ndcg_at_10"].mean() if len(frame) else None})
        return frame
    record("original catalog control", baseline, validation)
    record("expanded mixed catalog", joint, validation)
    tv_ids = {f"ml:{item}" for item, info in model["kinds"].items() if info.get("titleType") in WHOLE_SERIES}
    tv_validation = validation.loc[validation["movieId"].isin(tv_ids)]
    record("original series shortlist", original_tv, tv_validation, task="tiny observed whole-series validation")
    record("expanded series shortlist", tv_only, tv_validation, task="tiny observed whole-series validation")
    users_with_tv_likes = set(train.loc[(train["rating"] >= 4) & train["movieId"].isin(
        [item for item, info in model["kinds"].items() if info.get("titleType") in WHOLE_SERIES]), "userId"])
    film_ids = {f"ml:{item}" for item, info in model["kinds"].items() if info.get("titleType") == "movie"}
    movie_validation = validation.loc[validation["movieId"].isin(film_ids)]
    eligible_movie_users = set(movie_validation.loc[movie_validation["rating"] >= 4, "userId"])
    ablation_users = sorted(users_with_tv_likes & eligible_movie_users)
    record("include observed series likes", baseline, movie_validation, ablation_users, "TV profile ablation; movie labels only")
    record("ignore observed series likes", without_tv_profile, movie_validation, ablation_users, "TV profile ablation; movie labels only")
    coverage_rows = []
    for title_type in sorted({info.get("titleType") or "unknown" for info in model["kinds"].values()}):
        matched = {item for item, info in model["kinds"].items() if (info.get("titleType") or "unknown") == title_type}
        a, b = train.loc[train["movieId"].isin(matched)], context["validation"].loc[context["validation"]["movieId"].isin(matched)]
        coverage_rows.append({"titleType": title_type, "catalog_titles": len(matched), "training_events": len(a),
                              "training_likes": int(a["rating"].ge(4).sum()), "validation_events": len(b),
                              "validation_likes": int(b["rating"].ge(4).sum())})
    recommendation_rows = []
    for label, rankings in [("original catalog", baseline), ("expanded mixed", joint), ("series only", tv_only)]:
        for user, ranked in rankings.items():
            recommendation_rows.extend({"variant": label, "userId": user, "rank": rank, "itemId": item}
                                       for rank, item in enumerate(ranked, 1))
    recommendations = pd.DataFrame(recommendation_rows)
    item_frame = pd.DataFrame(items)
    examples_users = sorted(users_with_tv_likes)[:3]
    examples = recommendations.loc[recommendations["userId"].isin(examples_users)].merge(
        item_frame[["itemId", "title", "isSeries", "added"]], on="itemId")
    histories = train.loc[train["userId"].isin(examples_users)].copy()
    histories["itemId"] = histories["movieId"].map(lambda value: f"ml:{int(value)}")
    histories = histories.merge(item_frame[["itemId", "title", "isSeries"]], on="itemId")
    histories["rating_out_of_10"] = histories["rating"] * 2
    summary = pd.DataFrame(summaries)
    per_user = pd.concat(metric_frames, ignore_index=True)
    for frame in [summary, per_user]:
        if not np.isfinite(frame.select_dtypes(include="number").dropna().to_numpy()).all():
            raise AssertionError("Non-finite result.")
    output = context["processed"] / "notebook15_tv_series"
    output.mkdir(parents=True, exist_ok=True)
    exports = {"validation_summary.csv": summary, "per_user.csv": per_user,
               "title_type_coverage.csv": pd.DataFrame(coverage_rows), "feature_coverage.csv": model["coverage"],
               "expanded_catalog.csv": item_frame, "recommendations.csv": recommendations,
               "example_recommendations.csv": examples, "example_training_histories.csv": histories}
    for name, frame in exports.items():
        frame.to_csv(output / name, index=False)
    # Blank template for actual future feedback; no invented TV ratings are evaluated.
    template = output / "new_user_ratings_template.csv"
    if not template.exists():
        pd.DataFrame(columns=["userId", "itemId", "rating10", "timestamp"]).to_csv(template, index=False)
    manifest = {
        "experiment": "notebook15_tv_series", "created_at": datetime.now(timezone.utc).isoformat(),
        "split_id": context["split"]["split_id"], "split_fingerprint": context["split"]["split_fingerprint"],
        "evaluation_split": "validation", "test_feedback_read": False, "app_model_changed": False,
        "positive_threshold": 4.0, "positive_threshold_out_of_10": 8, "k": K,
        "original_candidates": len(context["ids"]), "expanded_candidates": len(items),
        "added_series": int(item_frame["added"].sum()), "control_parity": parity,
        "original_score_parity": {"users": len(context["users"]), "absolute_tolerance": 1e-12, "verified": True},
        "frozen_weights": context["metadata"]["weights"],
        "protocol": {
            "unit": "Whole series or mini-series only; never promote an episode/season/special rating to its parent series.",
            "like": "Binary 8--10/10; every rated item is excluded even below 8.",
            "catalog": "Independent bounded TVmaze page-0 metadata, verified by exact IMDb title type; preserve ml: IDs when already linked, otherwise imdb: IDs.",
            "features": "Original training-only TF-IDF vocabulary, cast IMDb nconst vocabulary/IDF, CF basis, weights and IMDb prior center/vote strength are frozen.",
            "new_series_cf": "Exactly zero; no observed collaborative feedback or inferred neighbors are fabricated.",
            "scaling": "Each normalization step anchored to original unseen candidates. Added TV scores may exceed 1 and are not clipped.",
            "new_tv_ratings": "Explicit whole-series ratings contribute plot/cast preferences to both movies and TV, using existing feature spaces.",
            "metrics": "Baseline reproduces original labels/users. Expanded mixed catalog measures candidate competition under sparse existing labels, not general TV accuracy.",
            "tv_metrics": "Only verified whole-series MovieLens validation labels, all positives retained including unavailable items; report tiny sample counts.",
            "profile_ablation": "Remove/restore observed training whole-series likes in user profiles only, keep CF basis/seen exclusions fixed, evaluate held-out movie labels on the same affected users. Both variants rank the same original catalog, including its TV/episode entries as competing candidates.",
            "prior": "New series use official IMDb aggregates with original movie prior center and 1000-vote strength; TVmaze audience averages are not substituted.",
            "candidate_change": "An expanded metadata catalog changes available items; its metrics are descriptive and not an equal-catalog model comparison.",
        },
        "sources": {**context["metadata"]["sources"], "validationRatingsSha256": context["validation_sha256"],
                    "tvManifestSha256": file_hash(model["source_manifest_path"]),
                    "tvCatalogSha256": file_hash(model["tv_catalog_path"]), "experimentScriptSha256": file_hash(Path(__file__))},
        "attribution": {"TVmaze": "https://www.tvmaze.com/api (CC BY-SA); per-series source URLs in expanded catalog",
                        "IMDb": "https://data.imdb.com/non-commercial-datasets/"},
        "limitations": context["metadata"]["limitations"] + [
            "Most added series have no held-out individual ratings; unobserved suggestions are unknown, not proven dislikes.",
            "TV content transfer is functional but its new-series accuracy is not established by this MovieLens benchmark.",
            "Movie/TV score calibration and summary-length/domain differences have not been tuned.",
            "Current metadata and audience ratings can postdate MovieLens events; repeated-validation results are retrospective and exploratory.",
        ],
        "files": {name: {"sha256": file_hash(output / name), "rows": len(frame)} for name, frame in exports.items()},
    }
    (output / "experiment_manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return {"model": model, "summary": summary, "per_user": per_user, "title_coverage": exports["title_type_coverage.csv"],
            "feature_coverage": model["coverage"], "examples": examples, "histories": histories,
            "manifest": manifest, "output": output}


if __name__ == "__main__":
    result = run_experiment()
    print(result["summary"].to_string(index=False))
    print(f"Saved TV-series experiment to {result['output']}")
