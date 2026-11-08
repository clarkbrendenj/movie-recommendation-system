"""Export notebook 10's frozen hybrid as compact, portable sparse features.

Run from the project root: .venv/Scripts/python.exe scripts/export_web_model.py
No network calls or API credentials are used. Only training feedback is used to
fit features. Validation labels are read solely to verify the saved experiment.

The web app has a deliberately frozen training-candidate catalog. New users are
folded into that model by averaging normalized item features for ratings >= 4;
every rated movie is excluded. This preserves notebook 10's scoring rule without
retraining the collaborative basis when a user signs up.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize
from threadpoolctl import threadpool_limits

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.imdb_ratings_model import rating_prior


SPLIT_ID = "per_user_chronological_60_20_20_v1"
POSITIVE_THRESHOLD = 4.0
ROOT = Path(__file__).resolve().parents[1]
DTYPES = {"uint16": "<u2", "uint32": "<u4", "float32": "<f4"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require_hash(path, expected):
    if file_hash(path) != expected:
        raise ValueError(f"Source fingerprint changed: {Path(path).name}")


def write_json(path, payload):
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"),
                                     allow_nan=False) + "\n", encoding="utf-8")


def notebook_functions(root=ROOT):
    """Use the recorded notebook's pure feature/scoring definitions as an oracle."""
    notebook = read_json(Path(root) / "notebooks/10_imdb_ratings_recommendations.ipynb")
    namespace = {"np": np}
    required = {"credit-feature-functions", "credit-evaluation-functions"}
    for cell in notebook["cells"]:
        if cell.get("id") in required:
            exec(compile("".join(cell["source"]), cell["id"], "exec"), namespace)
            required.remove(cell["id"])
    if required:
        raise ValueError(f"Notebook definition cells missing: {required}")
    return namespace


def build_model(root=ROOT):
    """Fit the exact selected features after checking recorded input hashes."""
    root = Path(root).resolve()
    processed = root / "data/processed" / SPLIT_ID
    raw = root / "data/raw/ml-latest-small"
    split_path = processed / "split_manifest.json"
    control_path = processed / "notebook09_credits/experiment_manifest.json"
    chosen_path = processed / "notebook10_imdb_ratings/experiment_manifest.json"
    split, control, chosen = map(read_json, [split_path, control_path, chosen_path])
    if (split["split_id"] != SPLIT_ID or chosen["split_fingerprint"] != split["split_fingerprint"]
            or control["split_fingerprint"] != split["split_fingerprint"]
            or chosen["test_feedback_read"] or chosen["evaluation_split"] != "validation"
            or split["positive_threshold"] != POSITIVE_THRESHOLD):
        raise ValueError("Incompatible notebook 10 training/split contract.")
    require_hash(control_path, chosen["control_manifest_sha256"])
    for name, expected in split["raw_sha256"].items():
        require_hash(raw / name, expected)
    train_path = processed / "train_ratings.csv"
    require_hash(train_path, split["files"][train_path.name]["sha256"])
    plot_path = processed / "training_plot_catalog.csv"
    credits_path = root / "data/raw/imdb/movielens_credits.json"
    ratings_path = root / "data/raw/imdb/movielens_ratings.json"
    for path, expected in [(plot_path, chosen["plot_catalog_sha256"]),
                           (credits_path, chosen["credits_catalog_sha256"]),
                           (ratings_path, chosen["ratings_sources"]["catalog_sha256"])]:
        require_hash(path, expected)
    train = pd.read_csv(train_path)
    item_ids = np.sort(train["movieId"].unique())
    users = np.sort(train["userId"].unique())
    item_index, user_index = pd.Index(item_ids), pd.Index(users)
    positives = train.loc[train["rating"].ge(POSITIVE_THRESHOLD)]
    feedback = csr_matrix((np.ones(len(positives)),
                           (user_index.get_indexer(positives["userId"]),
                            item_index.get_indexer(positives["movieId"]))),
                          shape=(len(users), len(item_ids)))
    if feedback.nnz != len(positives):
        raise ValueError("Duplicate training ratings.")
    counts = np.bincount(item_index.get_indexer(train["movieId"]), minlength=len(item_ids))
    functions = notebook_functions(root)
    features = {"cf": normalize(feedback.T.tocsr(), norm="l2").tocsr()}
    plots = pd.read_csv(plot_path).set_index("movieId").loc[item_ids, "plot"].fillna("")
    features["plots"] = TfidfVectorizer(stop_words="english", min_df=2, sublinear_tf=True,
                                       norm="l2").fit_transform(plots).tocsr()
    credits = read_json(credits_path)
    roles = control["role_sets"][control["provisional_credit_variant"]]
    for role in roles:
        features[role], _ = functions["build_role_features"](credits["movies"], item_ids, role)
    records = read_json(ratings_path)["movies"]
    prior = rating_prior(records, item_ids, chosen["prior_votes"])
    ratings_lookup = {int(row["movieId"]): row for row in records}
    movie_frame = pd.read_csv(raw / "movies.csv").set_index("movieId")
    movie_rows = []
    for index, item in enumerate(item_ids):
        movie = movie_frame.loc[item]
        rating = ratings_lookup.get(int(item), {})
        title = str(movie["title"])
        year = re.search(r"\((\d{4})\)\s*$", title)
        movie_rows.append({
            "movieId": int(item), "title": title,
            "genres": [] if movie["genres"] == "(no genres listed)" else movie["genres"].split("|"),
            "year": int(year.group(1)) if year else None,
            "popularity": int(counts[index]), "imdbRating": rating.get("averageRating"),
            "imdbVotes": rating.get("numVotes"), "imdbAdjustment": float(prior["adjustment"][index]),
        })
    metadata = {
        "version": 1, "model": "CF + plots + cast + IMDb ratings", "itemCount": len(item_ids),
        "weights": {"plot": float(chosen["control_plot_weight"]),
                    "credits": float(chosen["control_credit_weight"]),
                    "imdb": float(chosen["selected_weights"]["CF + plots + credits"])},
        "creditRoles": roles, "groups": [], "movies": movie_rows,
        "positiveThreshold": POSITIVE_THRESHOLD, "imdbPriorVotes": float(chosen["prior_votes"]),
        "imdbPriorCenter": prior["center"],
        "policy": {
            "catalog": "Frozen unique movies in canonical training feedback; no new titles are inferred.",
            "profile": "Mean of L2-normalized feature rows for rated movies >= 4, per group; divide by covered likes only.",
            "exclusion": "Exclude every rated catalog movie, including dislikes.",
            "scaling": "Each group divided by its unseen maximum; missing content falls back to its base.",
            "blend": "Blend CF/plots, then selected credit groups, re-scale unseen, add IMDb weight times centered adjustment.",
            "missingIMDb": "Exactly zero centered adjustment.",
            "coldStart": "With no likes: training rating count descending, IMDb adjustment descending, movieId ascending.",
            "tieBreak": "Personalized score descending, training rating count descending, movieId ascending.",
            "newUsers": "New profiles fold into the frozen collaborative item basis without adding a training-user dimension.",
            "precision": "Little-endian float32 sparse values, float64 profile/scoring accumulations.",
        },
        "sources": {"splitId": SPLIT_ID, "splitFingerprint": split["split_fingerprint"],
                    "notebook10ManifestSha256": file_hash(chosen_path),
                    "notebook09ManifestSha256": file_hash(control_path),
                    "trainRatingsSha256": file_hash(train_path),
                    "plotCatalogSha256": file_hash(plot_path), "creditsCatalogSha256": file_hash(credits_path),
                    "imdbRatingsSha256": file_hash(ratings_path), "exportScriptSha256": file_hash(Path(__file__))},
        "limitations": [chosen["temporal_limitation"],
                        "Validation-selected model; live-user quality has not yet been measured.",
                        "IMDb data is subject to https://data.imdb.com/non-commercial-datasets/"],
    }
    return metadata, features, train, processed


def validate_ratings(ratings, metadata):
    """Return candidate-index ratings; reject duplicates, bad IDs and non-half-stars."""
    lookup = {movie["movieId"]: i for i, movie in enumerate(metadata["movies"])}
    result = {}
    for row in ratings:
        item, value = row.get("movieId"), row.get("rating")
        if (type(item) is not int or item not in lookup or isinstance(value, bool)
                or not isinstance(value, (int, float)) or not np.isfinite(value)
                or not 0.5 <= value <= 5 or value * 2 != int(value * 2)
                or lookup[item] in result):
            raise ValueError("Require unique catalog movie IDs and ratings from 0.5 to 5 in half-star steps.")
        result[lookup[item]] = float(value)
    return result


def scale_unseen(values, seen):
    maximum = np.where(seen, 0.0, values).max(initial=0)
    return values / maximum if maximum > 0 else np.zeros_like(values)


def blend(base, content, weight, seen):
    base, content = scale_unseen(base, seen), scale_unseen(content, seen)
    return ((1 - weight) * base + weight * content
            if np.where(seen, 0, content).max(initial=0) > 0 else base)


def score_ratings(metadata, features, ratings):
    """Portable reference for the Worker algorithm; never builds an item-item matrix."""
    known = validate_ratings(ratings, metadata)
    n = len(metadata["movies"])
    seen = np.zeros(n, dtype=bool)
    seen[list(known)] = True
    liked = [index for index, value in known.items() if value >= metadata["positiveThreshold"]]
    if not liked:
        return np.zeros(n), seen, True
    scores = {}
    for name, matrix in features.items():
        covered = [index for index in liked if matrix.indptr[index + 1] > matrix.indptr[index]]
        if covered:
            # Convert before summation, just as JS Float64Array accumulators do.
            profile = np.asarray(matrix[covered].astype(np.float64).sum(axis=0)).ravel() / len(covered)
            scores[name] = np.asarray(matrix.astype(np.float64) @ profile).ravel()
        else:
            scores[name] = np.zeros(n)
    weights = metadata["weights"]
    result = blend(scores["cf"], scores["plots"], weights["plot"], seen)
    credit = np.mean([scale_unseen(scores[role], seen) for role in metadata["creditRoles"]], axis=0)
    result = blend(result, credit, weights["credits"], seen)
    adjustment = np.array([movie["imdbAdjustment"] for movie in metadata["movies"]])
    return scale_unseen(result, seen) + weights["imdb"] * adjustment, seen, False


def recommend(metadata, features, ratings, k=10):
    if type(k) is not int or k < 1:
        raise ValueError("k must be positive.")
    scores, seen, cold = score_ratings(metadata, features, ratings)
    candidates = np.flatnonzero(~seen)
    movies = metadata["movies"]
    ids = np.array([movie["movieId"] for movie in movies])
    counts = np.array([movie["popularity"] for movie in movies])
    quality = np.array([movie["imdbAdjustment"] for movie in movies])
    keys = ((ids[candidates], -quality[candidates], -counts[candidates]) if cold
            else (ids[candidates], -counts[candidates], -scores[candidates]))
    order = candidates[np.lexsort(keys)[:k]]
    return [{"movieId": int(ids[index]), "score": float(scores[index])} for index in order]


def write_features(directory, features):
    groups = []
    directory = Path(directory)
    for name, original in features.items():
        matrix = original.tocsr(copy=True)
        matrix.sort_indices()
        matrix.eliminate_zeros()
        index_type = "uint16" if matrix.shape[1] <= 65536 else "uint32"
        group = {"name": name, "rows": matrix.shape[0], "columns": matrix.shape[1], "nnz": matrix.nnz}
        for part, array, dtype in [("indptr", matrix.indptr, "uint32"),
                                   ("indices", matrix.indices, index_type),
                                   ("data", matrix.data, "float32")]:
            filename = f"{name}.{part}.bin"
            np.asarray(array, dtype=DTYPES[dtype]).tofile(directory / filename)
            group[part] = {"file": filename, "dtype": dtype,
                           "sha256": file_hash(directory / filename),
                           "bytes": (directory / filename).stat().st_size}
        groups.append(group)
    return groups


def read_features(directory, metadata):
    directory = Path(directory)
    features = {}
    for group in metadata["groups"]:
        arrays = {}
        for part in ["indptr", "indices", "data"]:
            descriptor = group[part]
            path = directory / descriptor["file"]
            require_hash(path, descriptor["sha256"])
            arrays[part] = np.fromfile(path, dtype=DTYPES[descriptor["dtype"]])
        features[group["name"]] = csr_matrix((arrays["data"], arrays["indices"], arrays["indptr"]),
                                             shape=(group["rows"], group["columns"]))
    return features


def verify_parity(metadata, original, portable, train, processed):
    """Compare all 610 existing-user rankings and all 594 saved validation metrics."""
    functions = notebook_functions()
    manifest_path = processed / "notebook10_imdb_ratings/experiment_manifest.json"
    manifest = read_json(manifest_path)
    per_user_path = manifest_path.parent / "credits_imdb_per_user.csv"
    require_hash(per_user_path, manifest["files"][per_user_path.name])
    saved = pd.read_csv(per_user_path).set_index("userId")
    validation_path = processed / "validation_ratings.csv"
    split = read_json(processed / "split_manifest.json")
    require_hash(validation_path, split["files"][validation_path.name]["sha256"])
    validation = pd.read_csv(validation_path)
    positives = {int(user): set(frame["movieId"].astype(int))
                 for user, frame in validation.loc[validation["rating"].ge(POSITIVE_THRESHOLD)].groupby("userId")}
    item_ids = np.array([row["movieId"] for row in metadata["movies"]])
    counts = np.array([row["popularity"] for row in metadata["movies"]])
    adjustment = np.array([row["imdbAdjustment"] for row in metadata["movies"]])
    lookup = {int(item): index for index, item in enumerate(item_ids)}
    max_error, compared, validated = 0.0, 0, 0
    for user, frame in train.groupby("userId", sort=True):
        ratings = [{"movieId": int(row.movieId), "rating": float(row.rating)} for row in frame.itertuples()]
        feedback = np.zeros((1, len(item_ids)))
        seen = np.zeros_like(feedback, dtype=bool)
        for row in ratings:
            seen[0, lookup[row["movieId"]]] = True
            if row["rating"] >= POSITIVE_THRESHOLD:
                feedback[0, lookup[row["movieId"]]] = 1
        components = {name: functions["score_features"](feedback, matrix)[0] for name, matrix in original.items()}
        plot = functions["blend_with_fallback"](components["cf"], components["plots"],
                                                metadata["weights"]["plot"], seen)
        credit = np.mean([functions["scale_unseen"](components[role], seen)
                          for role in metadata["creditRoles"]], axis=0)
        base = functions["blend_with_fallback"](plot, credit, metadata["weights"]["credits"], seen)
        reference = functions["scale_unseen"](base, seen)[0] + metadata["weights"]["imdb"] * adjustment
        scores, _, cold = score_ratings(metadata, portable, ratings)
        if not cold:
            error = float(np.max(np.abs(reference - scores)))
            max_error = max(max_error, error)
            if error > 2e-6:
                raise AssertionError(f"Portable score drift for user {user}: {error}")
            expected = functions["rank_unseen"](reference, seen[0], counts, item_ids).tolist()
            actual = [row["movieId"] for row in recommend(metadata, portable, ratings)]
            if expected != actual:
                raise AssertionError(f"Portable top-10 differs from notebook 10 for user {user}.")
            compared += 1
        else:
            # Product-specific cold start intentionally uses popularity first.
            expected = functions["rank_unseen"](reference, seen[0], counts, item_ids).tolist()
        if int(user) in positives:
            _, recall, ndcg = functions["ranking_metrics"](expected, positives[int(user)])
            if not np.allclose([recall, ndcg], saved.loc[user, ["recall_at_10", "ndcg_at_10"]], atol=1e-12, rtol=0):
                raise AssertionError(f"Saved validation metrics differ for user {user}.")
            validated += 1
    return {"personalizedUsersCompared": compared, "savedValidationUsersVerified": validated,
            "maxAbsoluteScoreDifference": max_error, "allPersonalizedTop10Identical": True,
            "coldStartParityException": "Product cold start uses popularity then IMDb instead of IMDb alone."}


def export_model(root=ROOT, directory=None):
    metadata, features, train, processed = build_model(root)
    destination = Path(directory) if directory else Path(root) / "data/web_model"
    destination.mkdir(parents=True, exist_ok=True)
    metadata["groups"] = write_features(destination, features)
    portable = read_features(destination, metadata)
    parity = verify_parity(metadata, features, portable, train, processed)
    metadata["builtAtUtc"] = datetime.now(timezone.utc).isoformat()
    metadata["verification"] = parity
    metadata["sparseBytes"] = sum(part["bytes"] for group in metadata["groups"]
                                   for name, part in group.items() if name in {"indptr", "indices", "data"})
    if metadata["sparseBytes"] > 64 * 1024 * 1024:
        raise ValueError("Sparse model exceeds the deployment memory budget.")
    cases = [{"name": "cold_start", "ratings": []}]
    first_user = int(train["userId"].min())
    frame = train.loc[train["userId"].eq(first_user)]
    cases.append({"name": f"existing_user_{first_user}",
                  "ratings": [{"movieId": int(row.movieId), "rating": float(row.rating)} for row in frame.itertuples()]})
    ids = [row["movieId"] for row in metadata["movies"]]
    new_ratings = [{"movieId": item, "rating": rating} for item, rating in zip(ids[:4], [5, 4, 2, 3.5])]
    cases.extend([{"name": "new_user", "ratings": new_ratings},
                  {"name": "no_likes", "ratings": [{"movieId": ids[0], "rating": 2}]}])
    for case in cases:
        case["scores"] = recommend(metadata, portable, case["ratings"])
        case["top10"] = [row["movieId"] for row in case["scores"]]
    write_json(destination / "reference.json", {"version": 1, "cases": cases})
    write_json(destination / "metadata.json", metadata)
    return metadata, destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "data/web_model")
    args = parser.parse_args()
    with threadpool_limits(limits=2):
        metadata, destination = export_model(ROOT, args.output)
    print(json.dumps({"directory": str(destination), "movies": metadata["itemCount"],
                      "sparseBytes": metadata["sparseBytes"], "verification": metadata["verification"]}, indent=2))


if __name__ == "__main__":
    main()
