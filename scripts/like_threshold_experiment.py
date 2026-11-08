"""Notebook 14: compare binary 7+/10 and 8+/10 likes on the selected hybrid.

No API calls, downloads, app exports or test-feedback parsing. Only the new
experiment directory is written. Run with the existing project environment:
    .venv/Scripts/python.exe scripts/like_threshold_experiment.py
"""

from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from sklearn.preprocessing import normalize
from threadpoolctl import threadpool_limits

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.export_web_model import ROOT, file_hash
from scripts.negative_ratings_experiment import (
    prepare_experiment, hybrid_affinity, rank_unseen, _check_control,
)


THRESHOLDS = (4.0, 3.5)
BASELINE = "cf_4__profile_4"
REQUESTED = "cf_3.5__profile_3.5"
COHORT_ALL = "all eligible users"
COHORT_COMMON = "original 8+ eligible users"
K = 10
BOOTSTRAP_SEED = 140
BOOTSTRAP_SAMPLES = 4000
METRIC_COLUMNS = ["userId", "n_positives", "hits_at_10", "recall_at_10", "ndcg_at_10"]


def _check_threshold(threshold):
    if (isinstance(threshold, (bool, str)) or not np.isscalar(threshold)
            or not np.isfinite(threshold) or not 0.5 <= threshold <= 5
            or threshold * 2 != np.floor(threshold * 2)):
        raise ValueError("Use a MovieLens threshold from 0.5 to 5 in half-star steps.")


def make_feedback(train, users, ids, threshold):
    """Inclusive threshold, with a fixed user/item index and binary event weights."""
    _check_threshold(threshold)
    users, ids = pd.Index(users), pd.Index(ids)
    ratings = train["rating"].to_numpy(dtype=float)
    if (not users.is_unique or not ids.is_unique or train.duplicated(["userId", "movieId"]).any()
            or not np.isfinite(ratings).all() or (ratings < 0.5).any() or (ratings > 5).any()
            or (ratings * 2 != np.floor(ratings * 2)).any()):
        raise ValueError("Require unique index/feedback IDs and valid half-star ratings.")
    rows, columns = users.get_indexer(train["userId"]), ids.get_indexer(train["movieId"])
    if (rows < 0).any() or (columns < 0).any():
        raise ValueError("Training feedback is outside the fixed user/item catalog.")
    liked = ratings >= threshold
    return csr_matrix((np.ones(int(liked.sum())), (rows[liked], columns[liked])),
                      shape=(len(users), len(ids)))


def fit_cf_basis(feedback):
    """Fit the original normalized item-user representation from binary likes."""
    feedback = csr_matrix(feedback, dtype=float, copy=True)
    feedback.eliminate_zeros()
    if not np.isfinite(feedback.data).all() or not np.all(feedback.data == 1):
        raise ValueError("Require finite binary feedback.")
    return normalize(feedback.T.tocsr(), norm="l2").tocsr()


def evaluate_threshold(rankings, validation, threshold=4.0, k=K, users=None):
    """Keep all held-out positives in denominators; do not drop requested users."""
    _check_threshold(threshold)
    if type(k) is not int or k < 1 or validation.duplicated(["userId", "movieId"]).any():
        raise ValueError("Require positive integer k and unique validation ratings.")
    positives = validation.loc[validation["rating"] >= threshold].groupby("userId")["movieId"].agg(set)
    requested = positives.sort_index().index if users is None else pd.Index(users)
    if not requested.is_unique or not requested.isin(positives.index).all():
        raise ValueError("Every requested user must have qualifying validation positives.")
    rows = []
    for user in sorted(requested):
        if user not in rankings:
            raise ValueError(f"Missing recommendations for validation user {user}.")
        ranked = list(rankings[user])[:k]
        if len(set(ranked)) != len(ranked):
            raise ValueError("Duplicate recommendations.")
        liked = positives.loc[user]
        relevant = np.array([item in liked for item in ranked], dtype=float)
        discounts = 1 / np.log2(np.arange(2, len(ranked) + 2))
        ideal = (1 / np.log2(np.arange(2, min(k, len(liked)) + 2))).sum()
        hits = int(relevant.sum())
        rows.append({"userId": int(user), "n_positives": len(liked), "hits_at_10": hits,
                     "recall_at_10": hits / len(liked),
                     "ndcg_at_10": float((relevant * discounts).sum() / ideal)})
    return pd.DataFrame(rows, columns=METRIC_COLUMNS)


def _paired_changes(per_user):
    rows = []
    for (threshold, cohort), group in per_user.groupby(["relevance_threshold", "cohort"]):
        control = group.loc[group["variant"] == BASELINE].set_index("userId").sort_index()
        for variant, selected in group.groupby("variant"):
            if variant == BASELINE:
                continue
            selected = selected.set_index("userId").sort_index()
            if not selected.index.equals(control.index):
                raise AssertionError("Paired comparison users changed.")
            for metric in ["recall_at_10", "ndcg_at_10"]:
                delta = (selected[metric] - control[metric]).to_numpy()
                rng = np.random.default_rng(BOOTSTRAP_SEED)
                bootstrap = delta[rng.integers(0, len(delta), (BOOTSTRAP_SAMPLES, len(delta)))].mean(axis=1)
                low, high = np.quantile(bootstrap, [0.025, 0.975])
                rows.append({"variant": variant, "control": BASELINE, "relevance_threshold": threshold,
                             "cohort": cohort, "metric": metric, "users": len(delta),
                             "mean_change": delta.mean(), "bootstrap_95_low": low, "bootstrap_95_high": high,
                             "improved_users": int((delta > 1e-12).sum()),
                             "worsened_users": int((delta < -1e-12).sum()),
                             "tied_users": int((np.abs(delta) <= 1e-12).sum())})
    return pd.DataFrame(rows)


def run_experiment(root=ROOT, context=None):
    context = prepare_experiment(root) if context is None else context
    metadata, train = context["metadata"], context["train"]
    users, ids = context["users"], context["ids"]
    feedback = {threshold: make_feedback(train, users, ids, threshold) for threshold in THRESHOLDS}
    bases = {threshold: fit_cf_basis(feedback[threshold]) for threshold in THRESHOLDS}
    difference = bases[4.0] - context["features"]["cf"]
    if difference.nnz and np.max(np.abs(difference.data)) > 1e-12:
        raise AssertionError("Original collaborative basis was not reproduced.")
    original_users = np.sort(context["validation"].loc[context["validation"]["rating"] >= 4, "userId"].unique())
    summaries, frames, recommendation_rows = [], [], []
    coverage_rows, control_parity = [], None
    for threshold in THRESHOLDS:
        matrix = feedback[threshold]
        liked_counts = np.asarray(matrix.sum(axis=1)).ravel().astype(int)
        covered = np.asarray(bases[threshold].getnnz(axis=1) > 0)
        for index, user in enumerate(users):
            coverage_rows.append({"userId": int(user), "training_like_threshold": threshold,
                                  "training_like_threshold_out_of_10": threshold * 2,
                                  "training_likes": int(liked_counts[index])})
        print(f"Threshold {threshold:g}: {matrix.nnz:,} training likes; {covered.sum():,} CF-covered movies", flush=True)
    coverage = pd.DataFrame(coverage_rows)
    with threadpool_limits(limits=2):
        for basis_threshold in THRESHOLDS:
            features = {**context["features"], "cf": bases[basis_threshold]}
            for profile_threshold in THRESHOLDS:
                variant = f"cf_{basis_threshold:g}__profile_{profile_threshold:g}"
                print(f"Scoring {variant}", flush=True)
                affinity = hybrid_affinity(feedback[profile_threshold], features, metadata, context["seen"])
                scores = affinity + metadata["weights"]["imdb"] * context["adjustment"][None, :]
                rankings = {int(user): rank_unseen(scores[i], context["seen"][i], context["counts"], ids)
                            for i, user in enumerate(users)}
                del affinity, scores
                for i, user in enumerate(users):
                    selected = pd.Index(ids).get_indexer(rankings[int(user)])
                    if (selected < 0).any() or context["seen"][i, selected].any():
                        raise AssertionError("Recommendation outside catalog or already rated.")
                    recommendation_rows.extend({"variant": variant, "userId": int(user), "rank": rank, "movieId": int(item)}
                                               for rank, item in enumerate(rankings[int(user)], 1))
                for relevance in THRESHOLDS:
                    for cohort, selected_users in [(COHORT_ALL, None), (COHORT_COMMON, original_users)]:
                        frame = evaluate_threshold(rankings, context["validation"], relevance, users=selected_users)
                        if variant == BASELINE and relevance == 4 and cohort == COHORT_ALL:
                            control_parity = _check_control(context, frame)
                        frame["variant"], frame["cf_threshold"], frame["profile_threshold"] = variant, basis_threshold, profile_threshold
                        frame["relevance_threshold"], frame["cohort"] = relevance, cohort
                        frames.append(frame)
                        summaries.append({"variant": variant, "cf_threshold": basis_threshold,
                                          "profile_threshold": profile_threshold, "relevance_threshold": relevance,
                                          "cohort": cohort, "users": len(frame),
                                          "heldout_positive_events": int(frame["n_positives"].sum()),
                                          "hits_at_10": int(frame["hits_at_10"].sum()),
                                          "mean_recall_at_10": frame["recall_at_10"].mean(),
                                          "mean_ndcg_at_10": frame["ndcg_at_10"].mean()})
                        if cohort == COHORT_ALL:
                            print(f"  relevance >= {relevance:g}: {len(frame)} users, Recall@10={summaries[-1]['mean_recall_at_10']:.6f}", flush=True)
    if control_parity is None:
        raise AssertionError("Original control was not verified.")
    summary, per_user = pd.DataFrame(summaries), pd.concat(frames, ignore_index=True)
    paired = _paired_changes(per_user)
    recommendations = pd.DataFrame(recommendation_rows)
    # Examples chosen solely by added 3.5-star training evidence, never validation gains.
    added = train.loc[train["rating"] == 3.5].groupby("userId").size().sort_index()
    examples_users = added.loc[added >= 3].head(3).index
    titles = pd.DataFrame(metadata["movies"])[["movieId", "title"]]
    examples = recommendations.loc[recommendations["userId"].isin(examples_users)].merge(titles, on="movieId")
    extra_likes = train.loc[train["userId"].isin(examples_users) & train["rating"].eq(3.5)].merge(titles, on="movieId")
    extra_likes = extra_likes[["userId", "movieId", "title", "rating", "timestamp"]]
    extra_likes["rating_out_of_10"] = 2 * extra_likes["rating"]
    output = context["processed"] / "notebook14_like_threshold"
    output.mkdir(parents=True, exist_ok=True)
    exports = {"validation_summary.csv": summary, "per_user.csv": per_user,
               "paired_comparisons.csv": paired, "training_profile_coverage.csv": coverage,
               "recommendations.csv": recommendations, "example_recommendations.csv": examples,
               "example_added_likes.csv": extra_likes}
    for name, frame in exports.items():
        frame.to_csv(output / name, index=False)
    manifest = {
        "experiment": "notebook14_like_threshold", "created_at": datetime.now(timezone.utc).isoformat(),
        "split_id": context["split"]["split_id"], "split_fingerprint": context["split"]["split_fingerprint"],
        "evaluation_split": "validation", "test_feedback_read": False, "app_model_changed": False,
        "candidate_count": len(ids), "training_users": len(users), "k": K,
        "thresholds": list(THRESHOLDS), "scale": "MovieLens 0.5--5, displayed score = 2 * MovieLens rating",
        "control_variant": BASELINE, "requested_variant": REQUESTED, "control_parity": control_parity,
        "frozen_weights": metadata["weights"],
        "protocol": {
            "models": "Prespecified 2x2: CF training-like threshold {4,3.5} x user-profile-like threshold {4,3.5}; binary equal weights; no dislike penalty.",
            "changed_features": "Refit only the normalized item-user CF basis from training likes when its threshold changes.",
            "fixed": "Candidate catalog, user/item indices, plot TF-IDF, cast features, IMDb prior and all selected blend weights.",
            "evaluation": "Evaluate every ranking at both relevance>=4 and relevance>=3.5; compare models only within the same relevance definition and cohort.",
            "cohorts": "All users with at least one validation positive under each relevance definition, plus the fixed original >=4-positive cohort under both definitions.",
            "recall_denominator": "All held-out positives, including those unavailable in the training candidate catalog; same rule for ideal NDCG.",
            "exclusion": "Every training-rated movie regardless of rating or like threshold.",
            "no_likes": "Zero personalized affinity plus frozen IMDb adjustment; original benchmark behavior, not product popularity cold start.",
            "tie_break": "score DESC, training rating count DESC, movieId ASC",
            "selection": "Report all four variants; no blend-weight retuning or automatic app promotion. Requested variant is both thresholds3.5, regardless of scores.",
            "bootstrap": {"unit": "paired user", "samples": BOOTSTRAP_SAMPLES, "seed": BOOTSTRAP_SEED,
                          "caution": "Descriptive percentile intervals on repeatedly reused validation data, not confirmatory significance tests."},
        },
        "sources": {**metadata["sources"], "validationRatingsSha256": context["validation_sha256"],
                    "experimentScriptSha256": file_hash(Path(__file__)),
                    "profileScoringScriptSha256": file_hash(Path(__file__).with_name("negative_ratings_experiment.py"))},
        "cf_coverage": [{"threshold": threshold, "training_like_events": feedback[threshold].nnz,
                         "cf_covered_movies": int((bases[threshold].getnnz(axis=1) > 0).sum()),
                         "users_with_likes": int((feedback[threshold].getnnz(axis=1) > 0).sum())} for threshold in THRESHOLDS],
        "limitations": metadata["limitations"] + [
            "Lowering validation relevance changes both the success definition and metric denominators; do not compare its raw score directly with the historical >=4 score.",
            "The optional common-user cohort controls user composition but does not make different relevance definitions equivalent.",
            "Same validation feedback has been used repeatedly; this is exploratory and not a new untouched-test estimate.",
        ],
        "files": {name: {"sha256": file_hash(output / name), "rows": len(frame)} for name, frame in exports.items()},
    }
    (output / "experiment_manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return {"summary": summary, "per_user": per_user, "paired": paired, "coverage": coverage,
            "examples": examples, "extra_likes": extra_likes, "manifest": manifest, "output": output}


if __name__ == "__main__":
    result = run_experiment()
    print(result["summary"].loc[result["summary"]["cohort"] == COHORT_ALL].to_string(index=False))
    print(f"Saved offline experiment to {result['output']}")
