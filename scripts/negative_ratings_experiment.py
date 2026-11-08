"""Notebook 13: offline, validation-only rating-profile ablations.

Fit the notebook-10 feature basis from training data, then vary how a user's
observed ratings form a profile. No API, downloads, app export, or test reads.
Run: .venv/Scripts/python.exe scripts/negative_ratings_experiment.py
"""

from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from threadpoolctl import threadpool_limits

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.export_web_model import ROOT, build_model, file_hash, read_json, require_hash


PROFILES = ("binary_likes", "graded_likes", "all_centered")
PENALTIES = (0.0, 0.1, 0.25, 0.5, 1.0)
BASELINE = "binary_likes__penalty_0"
K = 10
BOOTSTRAP_SEED = 130
BOOTSTRAP_SAMPLES = 4000


def rating_weights(ratings, profile):
    """Map 0.5--5 MovieLens ratings to separate nonnegative profile weights.

    Displayed 1--10 ratings are exactly twice these values. The all-rating
    variant is centered at 3 (6/10); an exactly neutral rating contributes zero.
    """
    ratings = np.asarray(ratings, dtype=float)
    if (not np.isfinite(ratings).all() or (ratings < 0.5).any()
            or (ratings > 5).any() or (ratings * 2 != np.floor(ratings * 2)).any()):
        raise ValueError("Ratings must be finite 0.5--5 values in half-star steps.")
    if profile == "binary_likes":
        positive = (ratings >= 4).astype(float)
        negative = np.where(ratings <= 2, 2.5 - ratings, 0.0)
    elif profile == "graded_likes":
        positive = np.where(ratings >= 4, ratings - 3.5, 0.0)
        negative = np.where(ratings <= 2, 2.5 - ratings, 0.0)
    elif profile == "all_centered":
        positive = np.maximum(ratings - 3, 0)
        negative = np.maximum(3 - ratings, 0)
    else:
        raise ValueError(f"Unknown profile: {profile}")
    return positive, negative


def normalize_unseen(scores, seen):
    scores = np.asarray(scores, dtype=float)
    seen = np.asarray(seen, dtype=bool)
    if (scores.ndim != 2 or scores.shape != seen.shape or not scores.shape[1]
            or not np.isfinite(scores).all() or (scores < 0).any()):
        raise ValueError("Require aligned, finite, nonnegative score and seen matrices.")
    maximum = np.where(seen, 0.0, scores).max(axis=1, keepdims=True)
    return np.divide(scores, maximum, out=np.zeros_like(scores), where=maximum > 0)


def weighted_affinity(feedback, features):
    """Weighted mean cosine affinity, dividing by covered weight only."""
    feedback = csr_matrix(feedback, dtype=float)
    features = csr_matrix(features, dtype=float, copy=True)
    if (feedback.shape[1] != features.shape[0]
            or not np.isfinite(feedback.data).all() or (feedback.data < 0).any()
            or not np.isfinite(features.data).all() or (features.data < 0).any()):
        raise ValueError("Require aligned, finite, nonnegative feedback and features.")
    features.eliminate_zeros()
    covered = features.getnnz(axis=1) > 0
    usable = np.asarray(feedback[:, covered].sum(axis=1)).ravel()
    scores = ((feedback @ features) @ features.T).toarray()
    np.divide(scores, usable[:, None], out=scores, where=usable[:, None] > 0)
    if not np.isfinite(scores).all():
        raise ValueError("Non-finite affinity.")
    return scores


def _blend(base, content, weight, seen):
    base, content = normalize_unseen(base, seen), normalize_unseen(content, seen)
    usable = np.where(seen, 0, content).max(axis=1) > 0
    result = base.copy()
    result[usable] = (1 - weight) * base[usable] + weight * content[usable]
    return result


def hybrid_affinity(feedback, features, metadata, seen):
    """Same frozen CF -> plots -> credits blend for each profile polarity."""
    weights = metadata["weights"]
    cf = weighted_affinity(feedback, features["cf"])
    plots = weighted_affinity(feedback, features["plots"])
    base = _blend(cf, plots, weights["plot"], seen)
    del cf, plots
    credits = np.zeros_like(base)
    for role in metadata["creditRoles"]:
        credits += normalize_unseen(weighted_affinity(feedback, features[role]), seen)
    credits /= len(metadata["creditRoles"])
    return normalize_unseen(_blend(base, credits, weights["credits"], seen), seen)


def combine_scores(positive, negative, adjustment, imdb_weight, penalty_weight):
    """Subtract a dislike signal, then add the IMDb prior exactly once.

    Signed final scores must never go through nonnegative max normalization.
    Missing positive/negative profiles stay zero and use this same formula.
    """
    positive, negative = np.asarray(positive, dtype=float), np.asarray(negative, dtype=float)
    adjustment = np.asarray(adjustment, dtype=float)
    if (positive.ndim != 2 or positive.shape != negative.shape
            or adjustment.shape != (positive.shape[1],)
            or not np.isfinite(positive).all() or (positive < 0).any()
            or not np.isfinite(negative).all() or (negative < 0).any()
            or not np.isfinite(adjustment).all() or (np.abs(adjustment) > 1).any()
            or not np.isfinite(imdb_weight) or not 0 <= imdb_weight <= 1
            or not np.isfinite(penalty_weight) or not 0 <= penalty_weight <= 1):
        raise ValueError("Require aligned affinities, bounded prior, and weights in [0, 1].")
    return positive - penalty_weight * negative + imdb_weight * adjustment[None, :]


def rank_unseen(scores, seen, counts, ids, k=K):
    scores, seen = np.asarray(scores, dtype=float), np.asarray(seen, dtype=bool)
    counts, ids = np.asarray(counts), np.asarray(ids)
    if (scores.ndim != 1 or scores.shape != seen.shape or scores.shape != counts.shape
            or scores.shape != ids.shape or not np.isfinite(scores).all()
            or not np.isfinite(counts).all() or len(set(ids)) != len(ids)
            or type(k) is not int or k < 1):
        raise ValueError("Require aligned finite ranking vectors and positive k.")
    available = np.flatnonzero(~seen)
    order = np.lexsort((ids[available], -counts[available], -scores[available]))
    return ids[available[order[:k]]]


def evaluate_rankings(rankings, validation, k=K):
    """Macro metrics on every user with validation likes; unknown is not dislike."""
    if type(k) is not int or k < 1:
        raise ValueError("k must be a positive integer.")
    positives = validation.loc[validation["rating"] >= 4].groupby("userId")["movieId"].agg(set)
    dislikes = validation.loc[validation["rating"] <= 2].groupby("userId")["movieId"].agg(set)
    rows = []
    for user, liked in positives.sort_index().items():
        if user not in rankings:
            raise ValueError(f"Missing recommendations for validation user {user}.")
        ranked = list(rankings[user])[:k]
        if len(set(ranked)) != len(ranked):
            raise ValueError("Duplicate recommendations.")
        relevant = np.array([item in liked for item in ranked], dtype=float)
        discounts = 1 / np.log2(np.arange(2, len(ranked) + 2))
        ideal = (1 / np.log2(np.arange(2, min(k, len(liked)) + 2))).sum()
        hits = int(relevant.sum())
        rows.append({"userId": int(user), "n_positives": len(liked), "hits_at_10": hits,
                     "recall_at_10": hits / len(liked),
                     "ndcg_at_10": float((relevant * discounts).sum() / ideal),
                     "disliked_hits_at_10": sum(item in dislikes.get(user, set()) for item in ranked)})
    return pd.DataFrame(rows)


def prepare_experiment(root=ROOT):
    """Reuse verified notebook-10 training features; load only validation labels."""
    root = Path(root).resolve()
    metadata, features, train, processed = build_model(root)
    split = read_json(processed / "split_manifest.json")
    validation_path = processed / "validation_ratings.csv"
    require_hash(validation_path, split["files"][validation_path.name]["sha256"])
    validation = pd.read_csv(validation_path)
    if train.duplicated(["userId", "movieId"]).any() or validation.duplicated(["userId", "movieId"]).any():
        raise ValueError("Duplicate rating events.")
    if not train.merge(validation, on=["userId", "movieId"]).empty:
        raise ValueError("Training/validation rating overlap.")
    users = np.sort(train["userId"].unique())
    ids = np.array([row["movieId"] for row in metadata["movies"]])
    uindex, iindex = pd.Index(users), pd.Index(ids)
    rows, cols = uindex.get_indexer(train["userId"]), iindex.get_indexer(train["movieId"])
    if (rows < 0).any() or (cols < 0).any() or not set(validation["userId"]).issubset(set(users)):
        raise ValueError("Feedback outside frozen users/catalog.")
    seen = np.zeros((len(users), len(ids)), dtype=bool)
    seen[rows, cols] = True
    return {"root": root, "processed": processed, "metadata": metadata, "features": features,
            "train": train, "validation": validation, "users": users, "ids": ids,
            "rows": rows, "cols": cols, "seen": seen,
            "counts": np.array([movie["popularity"] for movie in metadata["movies"]]),
            "adjustment": np.array([movie["imdbAdjustment"] for movie in metadata["movies"]]),
            "split": split, "validation_sha256": file_hash(validation_path)}


def profile_coverage(context):
    train, users = context["train"], context["users"]
    coverage = pd.DataFrame({"userId": users}).set_index("userId")
    for profile in PROFILES:
        positive, negative = rating_weights(train["rating"].to_numpy(), profile)
        for polarity, values in [("positive", positive), ("negative", negative)]:
            totals = train.assign(active=(values > 0).astype(int)).groupby("userId")["active"].sum()
            coverage[f"{profile}_{polarity}_count"] = totals.reindex(users, fill_value=0)
            for group, matrix in context["features"].items():
                covered = np.asarray(matrix.getnnz(axis=1) > 0)[context["cols"]]
                usable = (values > 0) & covered
                coverage[f"{profile}_{polarity}_{group}_usable_count"] = np.bincount(
                    context["rows"][usable], minlength=len(users))
    return coverage.reset_index()


def _check_control(context, actual):
    directory = context["processed"] / "notebook10_imdb_ratings"
    manifest = read_json(directory / "experiment_manifest.json")
    path = directory / "credits_imdb_per_user.csv"
    expected_hash = manifest["files"][path.name]
    require_hash(path, expected_hash["sha256"] if isinstance(expected_hash, dict) else expected_hash)
    expected = pd.read_csv(path).sort_values("userId").reset_index(drop=True)
    actual = actual.sort_values("userId").reset_index(drop=True)
    columns = ["userId", "n_positives", "hits_at_10", "recall_at_10", "ndcg_at_10"]
    if len(actual) != len(expected):
        raise ValueError("Control changed evaluation users.")
    np.testing.assert_allclose(actual[columns].to_numpy(), expected[columns].to_numpy(), rtol=0, atol=1e-12)
    return {"verified": True, "users": len(actual), "absolute_tolerance": 1e-12,
            "reference_sha256": file_hash(path), "columns": columns}


def paired_comparisons(per_user, winners, best_nonzero, coverage):
    """Descriptive paired-user bootstrap, explicitly not selection-adjusted."""
    frames = {variant: frame.set_index("userId").sort_index()
              for variant, frame in per_user.groupby("variant")}
    pairs = [(row.variant, BASELINE, "versus binary control") for row in winners.itertuples()]
    pairs += [(row.variant, f"{row.profile}__penalty_0", "penalty ablation")
              for row in best_nonzero.itertuples()]
    rows = []
    for chosen, control, comparison in pairs:
        selected, reference = frames[chosen], frames[control]
        for cohort in ["all validation-positive users", "users with training dislikes"]:
            user_ids = selected.index
            if cohort == "users with training dislikes":
                mode = selected["profile"].iloc[0]
                available = coverage.loc[coverage[f"{mode}_negative_count"] > 0, "userId"]
                user_ids = user_ids.intersection(available)
            for metric in ["recall_at_10", "ndcg_at_10"]:
                changes = (selected.loc[user_ids, metric] - reference.loc[user_ids, metric]).to_numpy()
                if not len(changes):
                    continue
                rng = np.random.default_rng(BOOTSTRAP_SEED)
                boot = changes[rng.integers(0, len(changes), (BOOTSTRAP_SAMPLES, len(changes)))].mean(axis=1)
                low, high = np.quantile(boot, [0.025, 0.975])
                rows.append({"variant": chosen, "control": control, "comparison": comparison,
                             "cohort": cohort, "metric": metric, "users": len(changes),
                             "mean_change": changes.mean(), "bootstrap_95_low": low,
                             "bootstrap_95_high": high, "improved_users": int((changes > 1e-12).sum()),
                             "worsened_users": int((changes < -1e-12).sum()),
                             "tied_users": int((np.abs(changes) <= 1e-12).sum())})
    return pd.DataFrame(rows)


def run_experiment(root=ROOT, context=None):
    context = prepare_experiment(root) if context is None else context
    metadata, train, users = context["metadata"], context["train"], context["users"]
    eligible = np.sort(context["validation"].loc[context["validation"]["rating"] >= 4, "userId"].unique())
    index = pd.Index(users).get_indexer(eligible)
    output = context["processed"] / "notebook13_negative_ratings"
    output.mkdir(parents=True, exist_ok=True)
    coverage = profile_coverage(context)
    summaries, per_users, recommendations = [], [], []
    control_parity = None
    with threadpool_limits(limits=2):
        for profile in PROFILES:
            print(f"Scoring {profile}: {len(PENALTIES)} penalty weights", flush=True)
            weights_pos, weights_neg = rating_weights(train["rating"].to_numpy(), profile)
            def feedback(weights):
                matrix = csr_matrix((weights, (context["rows"], context["cols"])), shape=context["seen"].shape)
                matrix.eliminate_zeros()
                return matrix
            positive = hybrid_affinity(feedback(weights_pos), context["features"], metadata, context["seen"])
            negative = hybrid_affinity(feedback(weights_neg), context["features"], metadata, context["seen"])
            for penalty in PENALTIES:
                variant = f"{profile}__penalty_{penalty:g}"
                scores = combine_scores(positive, negative, context["adjustment"], metadata["weights"]["imdb"], penalty)
                ranked = {int(users[i]): rank_unseen(scores[i], context["seen"][i], context["counts"], context["ids"])
                          for i in index}
                # Assert every output is in the candidate catalog and none was rated in training.
                for i in index:
                    selected = pd.Index(context["ids"]).get_indexer(ranked[int(users[i])])
                    if (selected < 0).any() or context["seen"][i, selected].any():
                        raise AssertionError("Invalid or previously rated recommendation.")
                frame = evaluate_rankings(ranked, context["validation"])
                if variant == BASELINE:
                    control_parity = _check_control(context, frame)
                frame["variant"], frame["profile"], frame["penalty_weight"] = variant, profile, penalty
                per_users.append(frame)
                summaries.append({"variant": variant, "profile": profile, "penalty_weight": penalty,
                                  "users": len(frame), "mean_recall_at_10": frame["recall_at_10"].mean(),
                                  "mean_ndcg_at_10": frame["ndcg_at_10"].mean(),
                                  "mean_disliked_hits_at_10": frame["disliked_hits_at_10"].mean()})
                for user, items in ranked.items():
                    recommendations.extend({"variant": variant, "userId": user, "rank": rank, "movieId": int(item)}
                                           for rank, item in enumerate(items, 1))
                print(f"  penalty={penalty:g}: Recall@10={summaries[-1]['mean_recall_at_10']:.6f}", flush=True)
                del scores
            del positive, negative
    if control_parity is None:
        raise AssertionError("Missing verified control.")
    grid, per_user = pd.DataFrame(summaries), pd.concat(per_users, ignore_index=True)
    order = ["mean_recall_at_10", "mean_ndcg_at_10", "penalty_weight", "profile"]
    sorted_grid = grid.sort_values(order, ascending=[False, False, True, True])
    winners = sorted_grid.drop_duplicates("profile").reset_index(drop=True)
    best_nonzero = sorted_grid.loc[sorted_grid["penalty_weight"] > 0].drop_duplicates("profile").reset_index(drop=True)
    paired = paired_comparisons(per_user, winners, best_nonzero, coverage)
    recommendation_frame = pd.DataFrame(recommendations)
    selected_variants = set(winners["variant"]) | set(best_nonzero["variant"]) | {BASELINE}
    selected_recommendations = recommendation_frame.loc[recommendation_frame["variant"].isin(selected_variants)]
    # Readable examples: deterministic users with explicit dislikes; no cherry-picking by validation gains.
    example_ids = coverage.loc[coverage["binary_likes_negative_count"] >= 3, "userId"].sort_values().head(3)
    movie_lookup = pd.DataFrame(metadata["movies"])[["movieId", "title"]]
    example_variants = set(winners["variant"]) | {BASELINE, best_nonzero.iloc[0]["variant"]}
    examples = selected_recommendations.loc[selected_recommendations["userId"].isin(example_ids)
                                           & selected_recommendations["variant"].isin(example_variants)].merge(movie_lookup, on="movieId")
    histories = train.loc[train["userId"].isin(example_ids), ["userId", "movieId", "rating", "timestamp"]].merge(movie_lookup, on="movieId")
    histories["rating_out_of_10"] = histories["rating"] * 2
    exports = {"validation_grid.csv": grid, "selected_by_profile.csv": winners,
               "best_nonzero_by_profile.csv": best_nonzero,
               "per_user.csv": per_user, "paired_comparisons.csv": paired,
               "profile_coverage.csv": coverage, "selected_recommendations.csv": selected_recommendations,
               "example_recommendations.csv": examples, "example_training_histories.csv": histories}
    for name, frame in exports.items():
        frame.to_csv(output / name, index=False)
    protocol = {
        "profiles": {"binary_likes": {"positive": "1 if r >= 4 else 0", "negative": "2.5-r if r <= 2 else 0"},
                     "graded_likes": {"positive": "r-3.5 if r >= 4 else 0", "negative": "2.5-r if r <= 2 else 0"},
                     "all_centered": {"positive": "max(r-3, 0)", "negative": "max(3-r, 0)"}},
        "rating_scale": "MovieLens 0.5--5; displayed 1--10 equals 2*r; all_centered 6/10 is neutral",
        "penalty_grid": list(PENALTIES), "score": "positive_hybrid - penalty * negative_hybrid + frozen_imdb_weight * adjustment",
        "normalization": "Each polarity uses the original nonnegative hybrid and unseen-max scaling independently; final signed scores are never rescaled.",
        "feature_policy": "Frozen training-only binary-like CF item basis, plot TF-IDF and selected credits; vary profile aggregation only, not CF training.",
        "missing_profile": "Zero affinity for that polarity; with neither, only frozen IMDb prior and deterministic tie-breaks (not product cold-start popularity).",
        "selection": "Highest macro validation Recall@10, then NDCG@10, then smaller penalty, then profile name; 15 prespecified variants.",
        "nonzero_diagnostic": "Also report the highest-Recall nonzero penalty per profile versus its own zero-penalty control; same selection caveat applies, and these do not replace the overall winners.",
        "relevance": "validation rating >=4; all positives retained in denominators, including unavailable movies",
        "exclusion": "all training-rated items, including neutral/disliked movies", "tie_break": "score DESC, training rating count DESC, movieId ASC",
        "disliked_hit_diagnostic": "Mean number per top-10 with observed validation rating <=2; unobserved items are unknown, not negative; secondary only.",
        "bootstrap": {"unit": "user", "samples": BOOTSTRAP_SAMPLES, "seed": BOOTSTRAP_SEED,
                      "caution": "Descriptive percentile intervals on the selection data; not selection-adjusted or independent significance tests."},
    }
    manifest = {"created_at": datetime.now(timezone.utc).isoformat(), "experiment": "notebook13_negative_ratings",
                "split_id": context["split"]["split_id"], "split_fingerprint": context["split"]["split_fingerprint"],
                "evaluation_split": "validation", "test_feedback_read": False, "app_model_changed": False,
                "positive_threshold": 4.0, "k": K, "validation_users": len(eligible), "training_users": len(users),
                "candidate_count": len(context["ids"]), "frozen_weights": metadata["weights"],
                "sources": {**metadata["sources"], "validationRatingsSha256": context["validation_sha256"],
                            "experimentScriptSha256": file_hash(Path(__file__))},
                "control_parity": control_parity, "protocol": protocol,
                "selected": winners.to_dict(orient="records"), "best_nonzero": best_nonzero.to_dict(orient="records"),
                "overall_best": sorted_grid.iloc[0].to_dict(),
                "limitations": metadata["limitations"] + [
                    "Same validation set used repeatedly across notebook experiments; improvements are exploratory, not an untouched-test claim.",
                    "Rating thresholds/neutral point are fixed experiment choices, not universal user preferences.",
                    "Does not test retraining the collaborative item basis on explicit negatives or relative user-rating centering.",
                    "Independent unseen-max scaling can give a single weakly covered dislike full penalty strength; coverage is exported for inspection.",
                    "Incomplete observed feedback cannot establish real-world dislike avoidance or causal improvement."],
                "files": {name: {"sha256": file_hash(output / name), "rows": len(frame)} for name, frame in exports.items()}}
    (output / "experiment_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return {"grid": grid, "winners": winners, "best_nonzero": best_nonzero,
            "per_user": per_user, "paired": paired, "coverage": coverage,
            "examples": examples, "histories": histories, "manifest": manifest, "output": output}


if __name__ == "__main__":
    result = run_experiment()
    print(result["winners"].to_string(index=False))
    print(f"Saved validation-only experiment to {result['output']}")
