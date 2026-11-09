"""Notebook 18: whole-series eligibility corrections and a fixed-budget policy study.

Reuse the trusted notebook-17 training basis without refitting it. Apply the
metadata-only unit veto uniformly, then compare ranking policies on validation.
No reserved test feedback, raw rating archive, API keys or app files are loaded.
"""

from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time

import joblib
import numpy as np
import pandas as pd
from scipy import sparse
from threadpoolctl import threadpool_limits

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.filmaffinity_experiment import (
    LIKE_THRESHOLD, TOP_K, SEED, blend_scores, component_scores,
    ranked_indices, ranking_metrics, sha256_file, write_json,
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path("data/processed/notebook18_filmaffinity")
PREVIOUS = Path("data/processed/notebook17_filmaffinity")


def tv_history_bin(count):
    if isinstance(count, (bool, np.bool_)) or not isinstance(count, (int, np.integer)) or count < 0:
        raise ValueError("Training TV-like count must be a nonnegative integer.")
    return "0" if count == 0 else "1-4" if count < 5 else "5+"


def blended_tv_scores(personal, popularity, seen, alpha):
    """Convex blend of per-user unseen-TV max-scaled scores; never mutate input."""
    personal, popularity = np.asarray(personal, dtype=float), np.asarray(popularity, dtype=float)
    seen = np.asarray(seen, dtype=bool)
    if personal.ndim != 1 or personal.shape != popularity.shape or personal.shape != seen.shape:
        raise ValueError("TV signals and seen mask must be equal-length vectors.")
    if not np.isfinite(alpha) or not 0 <= alpha <= 1:
        raise ValueError("Personalization weight must lie in [0,1].")
    values = []
    for signal in (personal, popularity):
        if not np.isfinite(signal[~seen]).all() or (signal[~seen] < 0).any():
            raise ValueError("Unseen TV scores must be finite and nonnegative.")
        current = np.where(seen, 0., signal)
        maximum = current.max(initial=0)
        values.append(current / maximum if maximum > 0 else np.zeros_like(current))
    result = alpha * values[0] + (1 - alpha) * values[1]
    result[seen] = -np.inf
    return result


def interleave_rankings(movies, series, tv_slots, k=TOP_K):
    """Distribute TV slots evenly, preserve branch order, backfill shortages."""
    if not isinstance(k, (int, np.integer)) or k < 1 or not isinstance(tv_slots, (int, np.integer)) or not 0 <= tv_slots <= k:
        raise ValueError("TV allocation must be an integer within the total slot budget.")
    movies, series = list(movies), list(series)
    if len(set(movies)) != len(movies) or len(set(series)) != len(series) or set(movies) & set(series):
        raise ValueError("Branch rankings must contain distinct, disjoint title IDs.")
    positions = [0, 0]
    branches = (movies, series)
    result = []
    for position in range(k):
        branch = int(((position + 1) * tv_slots) // k > (position * tv_slots) // k)
        if positions[branch] >= len(branches[branch]):
            branch = 1 - branch
        if positions[branch] < len(branches[branch]):
            result.append(branches[branch][positions[branch]])
            positions[branch] += 1
    return result


def apply_unit_exclusions(model, validation, item_ids):
    """Disable audited season units in every profile, candidate list and target.

    Preserve row/feature alignment and original matrices. The fitted basis still
    reflects the original training corpus; this function does not refit it.
    """
    excluded = set(item_ids)
    ids = np.asarray(model["item_ids"])
    if not excluded.issubset(set(ids)):
        raise ValueError("Every unit override must refer to a frozen training-catalog ID.")
    columns = np.flatnonzero(np.isin(ids, list(excluded)))
    if not model["catalog"].iloc[columns].unit.eq("whole_series").all():
        raise ValueError("This study's unit veto is restricted to provisional series entries.")
    eligible = ~np.isin(ids, list(excluded))
    cleaned = dict(model)
    cleaned["eligible_mask"] = eligible
    cleaned["excluded_item_ids"] = sorted(excluded)
    cleaned["likes"] = model["likes"].multiply(eligible).tocsr()
    cleaned["likes"].eliminate_zeros()
    cleaned["seen"] = model["seen"].copy()
    if len(columns):
        rows = np.repeat(np.arange(model["seen"].shape[0]), len(columns))
        cols = np.tile(columns, model["seen"].shape[0])
        forbidden = sparse.csr_matrix((np.ones(len(rows), dtype=np.float32), (rows, cols)), shape=model["seen"].shape)
        cleaned["seen"] = cleaned["seen"].maximum(forbidden).tocsr()
    kept = validation.loc[~validation.item_id.isin(excluded)].copy()
    summary = {"excluded_item_ids": sorted(excluded), "excluded_candidate_count": len(excluded),
               "removed_training_likes": int(model["likes"].sum() - cleaned["likes"].sum()),
               "removed_validation_rows": len(validation) - len(kept),
               "removed_validation_likes": int(((validation.rating >= LIKE_THRESHOLD) & validation.item_id.isin(excluded)).sum()),
               "policy": "Metadata-only exclusions frozen before scoring; applied to all18 profiles, candidates and eligible labels.",
               "fitted_basis": "Original17 CF/content/quality basis retained; no assertion that all training labels or metadata are now clean."}
    return cleaned, kept, summary


def policy_grid():
    policies = [{"policy": "Corrected hybrid control", "kind": "hybrid_control", "alpha": None, "tv_slots": None},
                {"policy": "Corrected popularity control", "kind": "popularity_control", "alpha": None, "tv_slots": None}]
    for alpha in (0., .25, .5, 1., "history_gate"):
        for slots in (2, 4, 6):
            label = "history" if isinstance(alpha, str) else f"{alpha:g}"
            policies.append({"policy": f"TV alpha={label}; {slots} TV + {10 - slots} movies", "kind": "allocated", "alpha": alpha, "tv_slots": slots})
    return policies


def _require_hash(path, digest):
    if sha256_file(path) != digest:
        raise ValueError(f"Frozen notebook-17 input changed: {path}")
    return digest


def _targets(validation):
    positive = validation.loc[validation.rating >= LIKE_THRESHOLD]
    return {task: (positive if task == "mixed" else positive.loc[positive.unit == task]).groupby("user_id").item_id.agg(set).to_dict()
            for task in ("mixed", "movie", "whole_series")}


def _metric_row(recs, user, targets, tv_ids):
    row = {"user_id": user, "list_length": len(recs), "tv_slots_observed": len(set(recs) & tv_ids)}
    for task, short in (("mixed", "mixed"), ("movie", "movie"), ("whole_series", "tv")):
        positives = targets[task].get(user)
        metrics = ranking_metrics(recs, positives) if positives else None
        row[f"{short}_positives"] = len(positives) if positives else 0
        for metric in ("recall", "ndcg"):
            row[f"{short}_{metric}_at_10"] = metrics[metric] if metrics else np.nan
    return row


def _mean(frame, column):
    values = frame[column].dropna()
    return float(values.mean()) if len(values) else None


def _summarize(frame):
    row = {"mixed_users": len(frame), "movie_users": int(frame.movie_recall_at_10.notna().sum()), "tv_users": int(frame.tv_recall_at_10.notna().sum()),
           "tv_slot_share": float(frame.tv_slots_observed.sum() / frame.list_length.sum()),
           "fraction_users_with_tv": float(frame.tv_slots_observed.gt(0).mean())}
    for task in ("mixed", "movie", "tv"):
        for metric in ("recall", "ndcg"):
            name = f"{task}_{metric}_at_10"
            row[name] = _mean(frame, name)
    row["balanced_mixed_recall_at_10"] = (row["movie_recall_at_10"] + row["tv_recall_at_10"]) / 2 if row["movie_users"] and row["tv_users"] else None
    return row


def _load_inputs(root):
    previous = root / PREVIOUS
    report_path = previous / "experiment_report.json"
    if not report_path.is_file():
        raise FileNotFoundError("Execute notebook 17 before this study; its experiment report is missing.")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    hashes = {str(report_path): sha256_file(report_path)}
    for name in ("trained_model.joblib", "training_catalog.csv", "leaderboard.csv"):
        hashes[str(previous / name)] = _require_hash(previous / name, report["files"][name])
    hashes[str(previous / "validation.csv")] = _require_hash(previous / "validation.csv", report["split"]["files"]["validation.csv"])
    hashes[str(previous / "train.csv")] = _require_hash(previous / "train.csv", report["split"]["files"]["train.csv"])
    basis_runner = root / "scripts/filmaffinity_experiment.py"
    hashes[str(basis_runner)] = _require_hash(basis_runner, report["runner_sha256"])
    units_path = root / "data/processed/notebook16_dataset_audit/filmaffinity_catalog_units.csv"
    hashes[str(units_path)] = _require_hash(units_path, report["provenance"]["input_sha256"]["filmaffinity_catalog_units.csv"])
    diagnostic_path = previous / "selected_model_diagnostics.json"
    diagnostics = json.loads(diagnostic_path.read_text(encoding="utf-8"))
    if diagnostics["provenance"]["input_sha256"]["experiment_report.json"] != hashes[str(report_path)]:
        raise ValueError("Notebook17 mixed diagnostics do not match its current experiment report.")
    hashes[str(diagnostic_path)] = sha256_file(diagnostic_path)
    per_user_path = previous / "selected_mixed_per_user.csv"
    hashes[str(per_user_path)] = _require_hash(per_user_path, diagnostics["files"][per_user_path.name])
    model = joblib.load(previous / "trained_model.joblib")
    if model["like_threshold"] != LIKE_THRESHOLD or model["top_k"] != TOP_K:
        raise ValueError("Notebook17 rating/ranking contract changed.")
    if model["best_personalized_variant"] != report["best_personalized_variant"]:
        raise ValueError("Notebook17 personalized model differs from its report.")
    units = pd.read_csv(units_path, usecols=["item_id", "unit"])
    validation = pd.read_csv(previous / "validation.csv").merge(units, on="item_id", how="left", validate="many_to_one")
    if not validation.unit.isin(["movie", "whole_series"]).all():
        raise ValueError("Invalid frozen validation unit map.")
    expected = pd.read_csv(per_user_path).set_index(["model", "user_id"])
    return model, validation, report, hashes, expected


def _parity_check(raw_model, original_validation, expected):
    """Before the unit veto, reproduce saved17 per-user mixed controls exactly."""
    ids = np.asarray(raw_model["item_ids"])
    targets = _targets(original_validation)
    users = raw_model["user_ids"]
    indices = [i for i, user in enumerate(users) if user in targets["mixed"]]
    variants = [raw_model["best_personalized_variant"], {"model": "Training popularity", "kind": "popularity", "plot": 0., "metadata": 0., "quality": 0.}]
    differences = {variant["model"]: [] for variant in variants}
    all_mask = np.ones(len(ids), dtype=bool)
    for start in range(0, len(indices), 128):
        rows = indices[start:start + 128]
        seen, profile = raw_model["seen"][rows].toarray().astype(bool), raw_model["likes"][rows]
        components = component_scores(raw_model, profile, seen)
        no_likes = np.asarray(profile.sum(axis=1)).ravel() == 0
        for variant in variants:
            scores = blend_scores(raw_model, components, variant, seen, no_likes)
            for local, row in enumerate(rows):
                user = users[row]
                cols = ranked_indices(scores[local], all_mask, raw_model["popularity"], ids)
                metrics = ranking_metrics(ids[cols].tolist(), targets["mixed"][user])
                reference = expected.loc[(variant["model"], user)]
                differences[variant["model"]].append(max(abs(metrics[metric] - reference[f"mixed_{metric}_at_10"]) for metric in ("recall", "ndcg")))
    checks = [{"model": name, "users": len(delta), "max_absolute_error": float(max(delta)), "passed": bool(max(delta) < 1e-10)} for name, delta in differences.items()]
    if not all(check["passed"] for check in checks):
        raise AssertionError("Original17 control reconstruction changed before the unit override.")
    return checks


def evaluate_policies(model, validation, policies):
    ids, users = np.asarray(model["item_ids"]), model["user_ids"]
    item_index = {item: i for i, item in enumerate(ids)}
    eligible = model["eligible_mask"]
    tv_mask = model["catalog"].unit.eq("whole_series").to_numpy() & eligible
    movie_mask = model["catalog"].unit.eq("movie").to_numpy() & eligible
    tv_ids = set(ids[tv_mask])
    targets = _targets(validation)
    if any(not cohort for cohort in targets.values()):
        raise ValueError("Corrected validation needs positive cohorts for each domain.")
    rows = [i for i, user in enumerate(users) if user in targets["mixed"]]
    personal_variant = model["best_personalized_variant"]
    pop_variant = {"kind": "popularity", "plot": 0., "metadata": 0., "quality": 0.}
    metrics_rows, shelf_rows, coverage, examples = [], [], [], []
    alphas = (0., .25, .5, 1., "history_gate")
    for start in range(0, len(rows), 128):
        batch = rows[start:start + 128]
        profile = model["likes"][batch]
        seen = model["seen"][batch].toarray().astype(bool)
        no_likes = np.asarray(profile.sum(axis=1)).ravel() == 0
        components = component_scores(model, profile, seen)
        personal = blend_scores(model, components, personal_variant, seen, no_likes)
        popular = blend_scores(model, components, pop_variant, seen, no_likes)
        for local, ui in enumerate(batch):
            user = users[ui]
            tv_likes = int(profile[local, tv_mask].sum())
            history_bin = tv_history_bin(tv_likes)
            movies = ids[ranked_indices(personal[local], movie_mask, model["popularity"], ids)].tolist()
            tv_rankings = {}
            for alpha in alphas:
                value = tv_likes / (tv_likes + 5) if isinstance(alpha, str) else alpha
                tv_scores = blended_tv_scores(personal[local, tv_mask], model["popularity"][tv_mask], seen[local, tv_mask], value)
                tv_columns = ranked_indices(tv_scores, np.ones(tv_mask.sum(), dtype=bool), model["popularity"][tv_mask], ids[tv_mask])
                series = ids[tv_mask][tv_columns].tolist()
                tv_rankings[alpha] = series
                metric = ranking_metrics(series, targets["whole_series"][user]) if user in targets["whole_series"] else None
                movie_metric = ranking_metrics(movies, targets["movie"][user]) if user in targets["movie"] else None
                shelf_rows.append({"tv_model": f"TV alpha={alpha}", "alpha": str(alpha), "user_id": user, "history_bin": history_bin, "train_tv_likes": tv_likes,
                                   "tv_recall_at_10": metric["recall"] if metric else np.nan,
                                   "tv_ndcg_at_10": metric["ndcg"] if metric else np.nan,
                                   "movie_recall_at_10": movie_metric["recall"] if movie_metric else np.nan,
                                   "movie_ndcg_at_10": movie_metric["ndcg"] if movie_metric else np.nan})
            for policy in policies:
                if policy["kind"] == "allocated":
                    recs = interleave_rankings(movies, tv_rankings[policy["alpha"]], policy["tv_slots"])
                else:
                    signal = personal[local] if policy["kind"] == "hybrid_control" else popular[local]
                    recs = ids[ranked_indices(signal, eligible, model["popularity"], ids)].tolist()
                if set(recs) & set(model["excluded_item_ids"]) or any(seen[local, item_index[item]] for item in recs):
                    raise AssertionError("A rated or vetoed title entered recommendations.")
                row = _metric_row(recs, user, targets, tv_ids)
                row.update({"policy": policy["policy"], "train_tv_likes": tv_likes, "history_bin": history_bin})
                metrics_rows.append(row)
                if ui in rows[:3]:
                    for rank, item in enumerate(recs, 1):
                        record = model["catalog"].iloc[item_index[item]]
                        examples.append({"policy": policy["policy"], "user_id": user, "rank": rank, "item_id": item, "title": record.title, "unit": record.unit})
            for task, mask in (("mixed", eligible), ("movie", movie_mask), ("whole_series", tv_mask)):
                positives = targets[task].get(user)
                if positives:
                    available = len(positives & set(ids[mask & ~seen[local]]))
                    coverage.append({"user_id": user, "task": task, "positives": len(positives), "available": available,
                                     "available_fraction": available / len(positives), "recall_ceiling_at_10": min(TOP_K, available) / len(positives)})
        end = start + len(batch)
        if start == 0 or end == len(rows) or end % 1024 == 0:
            print(f"Validated {end:,}/{len(rows):,} corrected-cohort users, {len(policies)} policies.", flush=True)
    per_user, shelves = pd.DataFrame(metrics_rows), pd.DataFrame(shelf_rows)
    leaderboard = pd.DataFrame([{**policy, **_summarize(per_user.loc[per_user.policy == policy["policy"]])} for policy in policies])
    leaderboard["tie_slots"] = leaderboard.tv_slots.fillna(0)
    leaderboard = leaderboard.sort_values(["balanced_mixed_recall_at_10", "mixed_recall_at_10", "mixed_ndcg_at_10", "tie_slots", "policy"], ascending=[False, False, False, True, True], kind="stable").reset_index(drop=True)
    shelf_board = shelves.groupby(["tv_model", "alpha"], sort=True).agg(tv_users=("tv_recall_at_10", "count"), movie_users=("movie_recall_at_10", "count"),
        tv_recall_at_10=("tv_recall_at_10", "mean"), tv_ndcg_at_10=("tv_ndcg_at_10", "mean"),
        movie_recall_at_10=("movie_recall_at_10", "mean"), movie_ndcg_at_10=("movie_ndcg_at_10", "mean")).reset_index().sort_values(["tv_recall_at_10", "tv_ndcg_at_10", "tv_model"], ascending=[False, False, True]).reset_index(drop=True)
    history = []
    for (policy, history_bin), frame in per_user.groupby(["policy", "history_bin"], sort=True):
        history.append({"view": "actual mixed list", "policy": policy, "history_bin": history_bin, **_summarize(frame)})
    for (tv_model, history_bin), frame in shelves.groupby(["tv_model", "history_bin"], sort=True):
        history.append({"view": "TV-only shelf", "policy": tv_model, "history_bin": history_bin,
                        "tv_users": int(frame.tv_recall_at_10.notna().sum()),
                        "tv_recall_at_10": _mean(frame, "tv_recall_at_10"), "tv_ndcg_at_10": _mean(frame, "tv_ndcg_at_10")})
    return leaderboard.drop(columns="tie_slots"), shelf_board, per_user, shelves, pd.DataFrame(history), pd.DataFrame(coverage), pd.DataFrame(examples)


def _paired_intervals(per_user, selected):
    rng, results = np.random.default_rng(SEED), []
    for baseline in ("Corrected hybrid control", "Corrected popularity control"):
        left = per_user.loc[per_user.policy == selected].set_index("user_id")
        right = per_user.loc[per_user.policy == baseline].set_index("user_id")
        for task in ("mixed", "movie", "tv"):
            delta = (left[f"{task}_recall_at_10"] - right[f"{task}_recall_at_10"]).dropna().to_numpy()
            samples = [rng.choice(delta, len(delta), replace=True).mean() for _ in range(2000)]
            low, high = np.quantile(samples, [.025, .975])
            results.append({"baseline": baseline, "task": task, "users": len(delta), "mean_difference": float(delta.mean()), "lower_95": float(low), "upper_95": float(high)})
    return results


def run_experiment(root=ROOT):
    from scripts.filmaffinity_series_spotcheck import run_spotcheck
    root, started = Path(root).resolve(), time.perf_counter()
    output = root / OUTPUT
    output.mkdir(parents=True, exist_ok=True)
    print("Verifying frozen notebook17 inputs and reviewing source-unit eligibility...", flush=True)
    original, validation, previous_report, protected, expected = _load_inputs(root)
    spotcheck = run_spotcheck(root)
    if "excluded_item_ids" not in spotcheck:
        raise ValueError("The source-unit audit must return the frozen confirmed exclusion list.")
    model, eligible_validation, corrections = apply_unit_exclusions(original, validation, spotcheck["excluded_item_ids"])
    policies = policy_grid()
    plan = {"experiment": "notebook18_tv_ranking_policy", "like_threshold": LIKE_THRESHOLD, "policies": policies,
            "unit_exclusions": corrections["excluded_item_ids"],
            "movie_branch": "Notebook17 best personalized hybrid, after uniform unit/profile eligibility veto",
            "tv_branch": "alpha*max-scaled personal TV signal + (1-alpha)*max-scaled train-like count; unseen TV only",
            "history_gate": "alpha = training TV likes / (training TV likes + 5); unproven prespecified hypothesis",
            "allocation": "Even proportional interleaving; preserve branch ordering; backfill if branch exhausted",
            "selection_primary": "Mean(movie Recall@10, TV Recall@10) from the SAME actual mixed top ten, domain cohorts fixed across all policies",
            "tie_breaks": "Mixed Recall, mixed NDCG, fewer allocated TV slots, policy name",
            "target_policy": "All eligible validation likes retained, including titles absent from training candidates; confirmed non-series units removed for all policies",
            "cohort_diagnostics": "0, 1-4, 5+ eligible training TV likes; not a causal history experiment",
            "test_feedback_read": False, "paid_api_calls": False,
            "input_sha256": {str(Path(name).relative_to(root)): digest for name, digest in protected.items()}}
    plan_path = output / "study_plan.json"
    if plan_path.exists() and json.loads(plan_path.read_text(encoding="utf-8")) != plan:
        raise ValueError("Notebook18 study plan changed; use a new experiment directory rather than overwrite its protocol.")
    write_json(plan_path, plan)
    print("Reproducing original17 mixed controls before the metadata-only veto...", flush=True)
    with threadpool_limits(limits=2):
        parity = _parity_check(original, validation, expected)
        print("Both original17 controls reproduced; scoring the corrected eligibility study...", flush=True)
        leaderboard, shelf_board, per_user, shelves, history, coverage, examples = evaluate_policies(model, eligible_validation, policies)
    selected = leaderboard.iloc[0].to_dict()
    intervals = _paired_intervals(per_user, selected["policy"])
    tables = {"policy_leaderboard.csv": leaderboard, "shelf_leaderboard.csv": shelf_board, "policy_per_user.csv": per_user,
              "shelf_per_user.csv": shelves, "history_bin_metrics.csv": history, "coverage.csv": coverage, "recommendation_examples.csv": examples,
              "paired_validation_intervals.csv": pd.DataFrame(intervals)}
    for name, frame in tables.items():
        frame.to_csv(output / name, index=False)
    selected_policy = next(policy for policy in policies if policy["policy"] == selected["policy"])
    selection = {"selected_policy": selected_policy, "result": selected, "excluded_item_ids": corrections["excluded_item_ids"],
                 "base_model_relative_path": str(PREVIOUS / "trained_model.joblib"), "base_model_sha256": previous_report["files"]["trained_model.joblib"],
                 "validation_only": True, "primary_objective_changed_from17": True}
    write_json(output / "selected_policy.json", selection)
    os.environ.setdefault("MPLCONFIGDIR", str(output / "matplotlib_cache"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    allocated = leaderboard.loc[leaderboard.kind == "allocated"]
    for alpha, group in allocated.groupby("alpha", sort=False):
        ordered = group.sort_values("tv_slots")
        axes[0].plot(ordered.movie_recall_at_10, ordered.tv_recall_at_10, marker="o", label=f"TV alpha={alpha}")
        for row in ordered.itertuples():
            axes[0].annotate(str(int(row.tv_slots)), (row.movie_recall_at_10, row.tv_recall_at_10), xytext=(4, 4), textcoords="offset points", fontsize=8)
    for control in leaderboard.loc[leaderboard.kind != "allocated"].itertuples():
        axes[0].scatter(control.movie_recall_at_10, control.tv_recall_at_10, marker="X", s=90, label=control.policy)
    axes[0].scatter(selected["movie_recall_at_10"], selected["tv_recall_at_10"], s=190, facecolors="none", edgecolors="black", linewidths=2)
    axes[0].set(xlabel="Movie Recall@10 from actual mixed list", ylabel="TV Recall@10 from actual mixed list", title="Same ten slots: labels show allocated TV slots")
    axes[0].legend(fontsize=7)
    for label, group in shelves.groupby("tv_model", sort=False):
        means = group.groupby("history_bin").tv_recall_at_10.mean().reindex(["0", "1-4", "5+"])
        axes[1].plot(["0", "1-4", "5+"], means, marker="o", label=label)
    axes[1].set(xlabel="Number of training TV likes", ylabel="TV-only Recall@10", title="History groups: observational, ten TV slots")
    axes[1].legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(output / "mixed_policy_tradeoff.png", dpi=150)
    plt.close(fig)
    coverage_summary = coverage.groupby("task").agg(users=("user_id", "size"), positives=("positives", "sum"), available=("available", "sum"), mean_available_fraction=("available_fraction", "mean"), mean_recall_ceiling_at_10=("recall_ceiling_at_10", "mean")).reset_index().to_dict("records")
    scope = {"evaluation_split": "validation", "test_feedback_read": False, "raw_ratings_read": False,
             "model_refitted": False, "app_changed": False, "paid_api_calls": False,
             "correction": "Metadata-only unit veto applies equally to all18 profiles, candidates and labels; exact17 controls reproduced separately before correction",
             "comparison": "Primary objective is actual mixed-list domain recall, unlike17 separate-shelf objective; corrected cohorts differ from17",
             "basis_limitation": "CF/content/prior were fit on original17 training data, including now-vetoed entries; encoders and features are not retrained",
             "source_limitations": "Provisional unit inference, source-scoped manual audit, review-associated scores, current metadata and review-date proxies remain",
             "cohort_eligibility": "Inherited17 retrospective users; original minimum history/date counts included now-vetoed events, so no new minimum-history claim after cleanup",
             "selection_limitations": "Repeated use of the same validation; bootstrap intervals are descriptive after selection, not independent confirmation",
             "allocation": "TV quotas are experimental controls, not calibrated user-intent probabilities or an app decision"}
    dataset = {"training_users": len(model["user_ids"]), "eligible_candidate_count": int(model["eligible_mask"].sum()),
               "eligible_movie_candidates": int((model["eligible_mask"] & model["catalog"].unit.eq("movie").to_numpy()).sum()),
               "eligible_series_candidates": int((model["eligible_mask"] & model["catalog"].unit.eq("whole_series").to_numpy()).sum()),
               "original_validation_rows": len(validation), "eligible_validation_rows": len(eligible_validation),
               "eligible_validation_positive_users": int(per_user.user_id.nunique()), "n_policies": len(policies)}
    for name, digest in protected.items():
        _require_hash(Path(name), digest)
    file_names = list(tables) + ["study_plan.json", "selected_policy.json", "mixed_policy_tradeoff.png"]
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "elapsed_seconds": time.perf_counter() - started,
              "scope": scope, "study_plan": plan, "dataset": dataset, "unit_spotcheck": spotcheck, "unit_corrections": corrections,
              "original17_control_parity": parity, "best_policy": selected, "best_shelf_model": shelf_board.iloc[0].to_dict(),
              "controls": leaderboard.loc[leaderboard.kind != "allocated"].to_dict("records"), "coverage": coverage_summary,
              "history_bins": history.loc[history.policy.isin([selected["policy"], "Corrected hybrid control", "Corrected popularity control"])].to_dict("records"),
              "paired_intervals": intervals, "original_inputs_unchanged_after_run": True,
              "files": {name: sha256_file(output / name) for name in file_names}, "runner_sha256": sha256_file(__file__),
              "versions": {name: importlib.metadata.version(name) for name in ("numpy", "pandas", "scipy", "scikit-learn", "joblib")}}
    # Convert NaNs caused by table rows with a missing domain into JSON null.
    report = json.loads(json.dumps(report, default=lambda value: value.item() if isinstance(value, np.generic) else str(value)))
    def finite_json(value):
        if isinstance(value, float) and not np.isfinite(value):
            return None
        if isinstance(value, dict):
            return {key: finite_json(part) for key, part in value.items()}
        if isinstance(value, list):
            return [finite_json(part) for part in value]
        return value
    report = finite_json(report)
    write_json(output / "experiment_report.json", report)
    print(f"Selected {selected['policy']} on corrected validation; finished in {time.perf_counter() - started:.1f}s.", flush=True)
    return report


def load_selected_policy(root=ROOT):
    root = Path(root).resolve()
    output = root / OUTPUT
    report = json.loads((output / "experiment_report.json").read_text(encoding="utf-8"))
    _require_hash(output / "selected_policy.json", report["files"]["selected_policy.json"])
    selection = json.loads((output / "selected_policy.json").read_text(encoding="utf-8"))
    source = root / selection["base_model_relative_path"]
    _require_hash(source, selection["base_model_sha256"])
    model = joblib.load(source)
    empty = pd.DataFrame(columns=["item_id", "rating"])
    corrected, _, _ = apply_unit_exclusions(model, empty, selection["excluded_item_ids"])
    return {"model": corrected, "policy": selection["selected_policy"]}


def recommend_policy(bundle, user_ratings):
    """Run the actual selected ten-slot policy for a new FilmAffinity-ID profile."""
    model, policy = bundle["model"], bundle["policy"]
    ids = np.asarray(model["item_ids"])
    index = {item: i for i, item in enumerate(ids)}
    for item, rating in user_ratings.items():
        if item not in index or not model["eligible_mask"][index[item]] or not np.isfinite(rating) or not 1 <= rating <= 10:
            raise ValueError(f"Unknown or excluded title, or rating outside1-10: {item}")
    cols = [index[item] for item, rating in user_ratings.items() if rating >= LIKE_THRESHOLD]
    profile = sparse.csr_matrix((np.ones(len(cols), dtype=np.float32), ([0] * len(cols), cols)), shape=(1, len(ids)))
    seen = (~model["eligible_mask"])[None, :].copy()
    for item in user_ratings:
        seen[0, index[item]] = True
    components = component_scores(model, profile, seen)
    variant = model["best_personalized_variant"] if policy["kind"] != "popularity_control" else {"kind": "popularity", "plot": 0., "metadata": 0., "quality": 0.}
    scores = blend_scores(model, components, variant, seen, np.array([not cols]))[0]
    tv_mask = model["catalog"].unit.eq("whole_series").to_numpy() & model["eligible_mask"]
    movie_mask = model["catalog"].unit.eq("movie").to_numpy() & model["eligible_mask"]
    if policy["kind"] != "allocated":
        recs = ids[ranked_indices(scores, model["eligible_mask"], model["popularity"], ids)].tolist()
    else:
        movies = ids[ranked_indices(scores, movie_mask, model["popularity"], ids)].tolist()
        count = int(profile[:, tv_mask].sum())
        alpha = count / (count + 5) if isinstance(policy["alpha"], str) else policy["alpha"]
        tv_scores = blended_tv_scores(scores[tv_mask], model["popularity"][tv_mask], seen[0, tv_mask], alpha)
        series = ids[tv_mask][ranked_indices(tv_scores, np.ones(tv_mask.sum(), dtype=bool), model["popularity"][tv_mask], ids[tv_mask])].tolist()
        recs = interleave_rankings(movies, series, policy["tv_slots"])
    result = model["catalog"].set_index("item_id").loc[recs].reset_index()[["item_id", "title", "original_title", "year", "unit", "confidence"]]
    return result.assign(rank=np.arange(len(result)) + 1)


if __name__ == "__main__":
    print(json.dumps(run_experiment(ROOT)["best_policy"], indent=2))
