"""Post-selection validation diagnostics for notebook 17's two frozen champions.

Never reads reserved test or MovieLens feedback, retrains, or changes selection.
Only load the trusted joblib artifact produced and hash-recorded by this project.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

import joblib
import numpy as np
import pandas as pd
from threadpoolctl import threadpool_limits

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.filmaffinity_experiment import (
    LIKE_THRESHOLD, OUTPUT, TOP_K, blend_scores, component_scores,
    ranked_indices, ranking_metrics, sha256_file, write_json,
)

ROOT = Path(__file__).resolve().parents[1]


def _require_hash(path, expected):
    observed = sha256_file(path)
    if not expected or observed != expected:
        raise ValueError(f"Diagnostic input differs from the completed experiment: {path.name}")
    return observed


def _mean(frame, column):
    values = frame[column].dropna()
    return float(values.mean()) if len(values) else None


def _exposure(frame):
    slots = int(frame.mixed_list_length.sum())
    return {"users": int(len(frame)),
            "mean_user_tv_share_at_10": _mean(frame, "mixed_top10_tv_share"),
            "pooled_tv_share_at_10": float(frame.mixed_top10_tv_count.sum() / slots) if slots else None,
            "fraction_users_with_at_least_one_tv": _mean(frame, "mixed_top10_has_tv"),
            "mean_tv_count_at_10": _mean(frame, "mixed_top10_tv_count"),
            "mixed_recall_at_10": _mean(frame, "mixed_recall_at_10"),
            "mixed_ndcg_at_10": _mean(frame, "mixed_ndcg_at_10")}


def _user_row(model, user, profile, seen, scores, ids, tv_mask, targets):
    positives = targets["mixed"][user]
    tv_positives = targets["whole_series"].get(user, set())
    movie_positives = targets["movie"].get(user, set())
    mixed_columns = ranked_indices(scores, np.ones(len(ids), dtype=bool), model["popularity"], ids)
    actual_mixed = ids[mixed_columns].tolist()
    mixed_metrics = ranking_metrics(actual_mixed, positives)
    tv_count = int(tv_mask[mixed_columns].sum())
    train_tv_likes = int(profile[:, tv_mask].sum())
    train_likes = int(profile.sum())
    row = {"user_id": str(user), "train_likes": train_likes,
           "train_tv_likes": train_tv_likes, "train_movie_likes": train_likes - train_tv_likes,
           "validation_likes": len(positives), "validation_tv_likes": len(tv_positives),
           "validation_movie_likes": len(movie_positives),
           "available_validation_tv_likes": len(tv_positives & set(ids[tv_mask & ~seen])),
           "mixed_list_length": len(actual_mixed), "mixed_top10_tv_count": tv_count,
           "mixed_top10_tv_share": tv_count / len(actual_mixed) if actual_mixed else 0.,
           "mixed_top10_has_tv": bool(tv_count), "mixed_recall_at_10": mixed_metrics["recall"],
           "mixed_ndcg_at_10": mixed_metrics["ndcg"], "mixed_hits": mixed_metrics["hits"]}
    # Rank one actual mixed list, then evaluate each domain against that same list.
    for task, relevant in (("tv", tv_positives), ("movie", movie_positives)):
        metrics = ranking_metrics(actual_mixed, relevant) if relevant else None
        for metric in ("recall", "ndcg", "hits"):
            row[f"{task}_from_mixed_{metric}_at_10"] = metrics[metric] if metrics else np.nan
    if tv_positives:
        columns = ranked_indices(scores, tv_mask, model["popularity"], ids)
        metrics = ranking_metrics(ids[columns].tolist(), tv_positives)
        row.update({"tv_only_recall_at_10": metrics["recall"], "tv_only_ndcg_at_10": metrics["ndcg"]})
    else:
        row.update({"tv_only_recall_at_10": np.nan, "tv_only_ndcg_at_10": np.nan})
    return row


def _summarize(frame, variant, roles):
    tv_users = frame.loc[frame.validation_tv_likes > 0]
    movie_users = frame.loc[frame.validation_movie_likes > 0]
    transfer = []
    for label, mask in (("zero_training_tv_likes", tv_users.train_tv_likes == 0),
                        ("at_least_one_training_tv_like", tv_users.train_tv_likes > 0),
                        ("zero_training_tv_likes_with_movie_likes",
                         (tv_users.train_tv_likes == 0) & (tv_users.train_movie_likes > 0))):
        group = tv_users.loc[mask]
        transfer.append({"cohort": label, "users": int(len(group)),
                         "users_with_training_movie_likes": int((group.train_movie_likes > 0).sum()),
                         "users_without_any_training_likes": int((group.train_likes == 0).sum()),
                         "tv_only_recall_at_10": _mean(group, "tv_only_recall_at_10"),
                         "tv_only_ndcg_at_10": _mean(group, "tv_only_ndcg_at_10"),
                         "tv_recall_from_actual_mixed_top10": _mean(group, "tv_from_mixed_recall_at_10"),
                         "mean_user_tv_share_in_mixed_top10": _mean(group, "mixed_top10_tv_share")})
    return {"model": variant["model"], "variant": variant, "roles": roles,
            "mixed_exposure": {"all_validation_positive_users": _exposure(frame),
                               "tv_positive_users": _exposure(tv_users)},
            "domain_recall_from_actual_mixed_top10": {
                "movie": {"users": int(len(movie_users)),
                          "recall_at_10": _mean(movie_users, "movie_from_mixed_recall_at_10"),
                          "ndcg_at_10": _mean(movie_users, "movie_from_mixed_ndcg_at_10")},
                "whole_series": {"users": int(len(tv_users)),
                                 "recall_at_10": _mean(tv_users, "tv_from_mixed_recall_at_10"),
                                 "ndcg_at_10": _mean(tv_users, "tv_from_mixed_ndcg_at_10"),
                                 "tv_only_recall_at_10_same_users": _mean(tv_users, "tv_only_recall_at_10")}},
            "tv_only_by_training_tv_profile": transfer}


def analyze_selected_model(root: Path = ROOT) -> dict:
    """Diagnose the fixed selected model and already-ranked best personalized hybrid."""
    root, started = Path(root).resolve(), time.perf_counter()
    output = root / OUTPUT
    report_path = output / "experiment_report.json"
    if not report_path.is_file():
        raise FileNotFoundError("Finish notebook 17 before running post-selection diagnostics.")
    print("Diagnostics: verifying frozen model, validation, source catalog, leaderboard, and runner hashes...", flush=True)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    model_path, validation_path = output / "trained_model.joblib", output / "validation.csv"
    units_path = root / "data/processed/notebook16_dataset_audit/filmaffinity_catalog_units.csv"
    hashes = {"experiment_report.json": sha256_file(report_path),
              "trained_model.joblib": _require_hash(model_path, report["files"]["trained_model.joblib"]),
              "validation.csv": _require_hash(validation_path, report["split"]["files"]["validation.csv"]),
              "filmaffinity_catalog_units.csv": _require_hash(units_path, report["provenance"]["input_sha256"]["filmaffinity_catalog_units.csv"]),
              "leaderboard.csv": _require_hash(output / "leaderboard.csv", report["files"]["leaderboard.csv"]),
              "filmaffinity_experiment.py": _require_hash(root / "scripts/filmaffinity_experiment.py", report["runner_sha256"])}
    print(f"Diagnostics: loading trusted trained_model.joblib ({time.perf_counter() - started:.1f}s)...", flush=True)
    model = joblib.load(model_path)
    if model["selected_variant"] != report["selected_variant"]:
        raise ValueError("Persisted selected variant differs from the experiment report.")
    if model["like_threshold"] != LIKE_THRESHOLD or model["top_k"] != TOP_K:
        raise ValueError("Persisted rating or ranking contract changed.")
    leaderboard = pd.read_csv(output / "leaderboard.csv")
    # The existing sorted leaderboard determines this descriptive comparison.
    # No new scoring objective, hyperparameter search, or promotion takes place.
    best_hybrid = leaderboard.loc[leaderboard.kind == "hybrid"].iloc[0]
    personalized = {key: best_hybrid[key] for key in ("model", "kind", "plot", "metadata", "quality")}
    if "best_personalized_variant" in model and model["best_personalized_variant"] != personalized:
        raise ValueError("Persisted best personalized variant differs from the frozen leaderboard.")
    variants = [dict(model["selected_variant"])]
    roles = {variants[0]["model"]: ["selected_by_original_balanced_objective"]}
    if personalized["model"] not in roles:
        variants.append(personalized)
        roles[personalized["model"]] = []
    roles[personalized["model"]].append("best_personalized_hybrid_on_existing_leaderboard")
    units = pd.read_csv(units_path, usecols=["item_id", "unit"])
    validation = pd.read_csv(validation_path).merge(units, on="item_id", how="left", validate="many_to_one")
    if not validation.unit.isin(["movie", "whole_series"]).all():
        raise ValueError("Validation items have missing or unsupported unit labels.")
    positive = validation.loc[validation.rating >= LIKE_THRESHOLD]
    targets = {task: (positive if task == "mixed" else positive.loc[positive.unit == task])
               .groupby("user_id").item_id.agg(set).to_dict()
               for task in ("mixed", "movie", "whole_series")}
    users, ids = model["user_ids"], np.asarray(model["item_ids"])
    item_units = model["catalog"].unit.to_numpy()
    if len(ids) != len(item_units) or model["catalog"].item_id.tolist() != list(ids):
        raise ValueError("Persisted catalog rows do not match feature columns.")
    if not set(targets["mixed"]).issubset(set(users)):
        raise ValueError("Validation-positive users are missing from the persisted model.")
    tv_mask = item_units == "whole_series"
    chosen_rows = np.array([row for row, user in enumerate(users) if user in targets["mixed"]], dtype=int)
    if not len(chosen_rows):
        raise ValueError("No validation-positive users to diagnose.")
    print(f"Diagnostics: scoring {len(chosen_rows):,} users for {len(variants)} fixed models in batches of 128...", flush=True)
    rows = []
    with threadpool_limits(limits=2):
        for start in range(0, len(chosen_rows), 128):
            batch_rows = chosen_rows[start:start + 128]
            seen, profile = model["seen"][batch_rows].toarray().astype(bool), model["likes"][batch_rows]
            no_likes = np.asarray(profile.sum(axis=1)).ravel() == 0
            components = component_scores(model, profile, seen)
            for variant in variants:
                scores = blend_scores(model, components, variant, seen, no_likes)
                for local, model_row in enumerate(batch_rows):
                    row = _user_row(model, users[model_row], profile[local], seen[local], scores[local], ids, tv_mask, targets)
                    row["model"] = variant["model"]
                    rows.append(row)
            end = start + len(batch_rows)
            if start == 0 or end == len(chosen_rows) or end % 1024 == 0:
                print(f"Diagnostics: {end:,}/{len(chosen_rows):,} users x {len(variants)} models ({time.perf_counter() - started:.1f}s).", flush=True)
    frame, summaries, checks = pd.DataFrame(rows), [], []
    for variant in variants:
        group = frame.loc[frame.model == variant["model"]]
        summary = _summarize(group, variant, roles[variant["model"]])
        expected = leaderboard.loc[leaderboard.model == variant["model"]].iloc[0]
        tv_group = group.loc[group.validation_tv_likes > 0]
        if len(group) != int(expected.mixed_users) or len(tv_group) != int(expected.whole_series_users):
            raise AssertionError("Diagnostic cohorts differ from the frozen leaderboard.")
        for metric, observed, reference in (
            ("mixed_recall_at_10", _mean(group, "mixed_recall_at_10"), expected.mixed_recall_at_10),
            ("tv_only_recall_at_10", _mean(tv_group, "tv_only_recall_at_10"), expected.whole_series_recall_at_10)):
            if observed is None or not np.isclose(observed, reference, rtol=0, atol=1e-10):
                raise AssertionError(f"Diagnostic {metric} differs from the frozen leaderboard for {variant['model']}.")
            checks.append({"model": variant["model"], "metric": metric,
                           "diagnostic_value": observed, "leaderboard_value": float(reference), "atol": 1e-10, "passed": True})
        summaries.append(summary)
    csv_path = output / "selected_mixed_per_user.csv"
    frame.to_csv(csv_path, index=False)
    diagnostics = {"created_at": datetime.now(timezone.utc).isoformat(),
                   "elapsed_seconds": time.perf_counter() - started,
                   "selected_model_name": model["selected_variant"]["model"],
                   "best_personalized_model_name": personalized["model"], "models": summaries,
                   "scope": {"evaluation_split": "validation", "frozen_champions_only": True,
                             "model_selection_repeated": False, "reserved_test_read": False,
                             "movielens_feedback_read": False, "paid_api_calls": False,
                             "target_definition": "Validation rating >=8; unavailable positives remain in denominators.",
                             "cohorts": "All validation-positive users and the fixed subsets with TV/movie positives.",
                             "selection_context": "Original objective averages separate movie-only and TV-only Recall@10.",
                             "interpretation": "Post-selection descriptions; no new winner or causal transfer claim.",
                             "tv_units": "Inherited inferred whole-series candidates, not manually verified labels."},
                   "leaderboard_parity_checks": checks,
                   "provenance": {"input_sha256": hashes,
                                  "source_revision": report["provenance"]["source_revision"],
                                  "source_manifest_sha256": report["provenance"]["source_manifest_sha256"],
                                  "diagnostics_runner_sha256": sha256_file(Path(__file__))},
                   "files": {csv_path.name: sha256_file(csv_path)}}
    write_json(output / "selected_model_diagnostics.json", diagnostics)
    print(f"Diagnostics saved; {len(checks)} leaderboard parity checks passed ({time.perf_counter() - started:.1f}s).", flush=True)
    return diagnostics


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    args = parser.parse_args()
    result = analyze_selected_model(args.project_root)
    print(json.dumps(result["models"], indent=2))
