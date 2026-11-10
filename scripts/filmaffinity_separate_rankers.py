"""Notebook19: controlled separate-domain ranking and shared-history study.

Feature fitting uses only the frozen cleaned training partition. Per-type@10
comparisons use identical cohorts and candidates. Both contains two shelves;
the union is compared against a mixed20 list, never called a top10 model gain.
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
    LIKE_THRESHOLD, TOP_K, SEED, component_scores, blend_scores,
    ranked_indices, ranking_metrics, sha256_file, write_json,
)
from scripts.filmaffinity_ranking_policy import (
    _load_inputs, _require_hash, _targets, apply_unit_exclusions, tv_history_bin,
)
from scripts.filmaffinity_domain_models import fit_training_basis, domain_components

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path("data/processed/notebook19_filmaffinity")
KINDS = ("movie", "whole_series")


def profile_for_kind(likes, item_units, target_kind, mode):
    if target_kind not in KINDS or mode not in ("all", "same_type"):
        raise ValueError("Use a valid target kind and all/same_type profile mode.")
    if not sparse.issparse(likes) or likes.shape[1] != len(item_units):
        raise ValueError("Profile columns must align with source item units.")
    result = likes.copy().tocsr()
    if mode == "same_type":
        result = result.multiply(np.asarray(item_units) == target_kind).tocsr()
        result.eliminate_zeros()
    return result


def blend_personal_popularity(personal, popularity, seen, alpha, no_profile):
    """Per-target max scaling; an empty personal profile falls back to counts."""
    personal, popularity = np.asarray(personal, dtype=float), np.asarray(popularity, dtype=float)
    seen, no_profile = np.asarray(seen, dtype=bool), np.asarray(no_profile, dtype=bool)
    if personal.ndim != 2 or seen.shape != personal.shape or popularity.shape != (personal.shape[1],) or no_profile.shape != (personal.shape[0],):
        raise ValueError("Scores, candidates, seen mask and empty-profile rows must align.")
    if not np.isfinite(alpha) or not 0 <= alpha <= 1:
        raise ValueError("Personalization weight must be in [0,1].")
    pop = np.broadcast_to(popularity, personal.shape).copy()
    values = personal.copy()
    values[no_profile] = pop[no_profile]
    normalized = []
    for signal in (values, pop):
        if not np.isfinite(signal[~seen]).all() or (signal[~seen] < 0).any():
            raise ValueError("Unseen scores must be finite and nonnegative.")
        signal[seen] = 0
        maximum = signal.max(axis=1, keepdims=True, initial=0)
        normalized.append(np.divide(signal, maximum, out=np.zeros_like(signal), where=maximum > 0))
    result = alpha * normalized[0] + (1 - alpha) * normalized[1]
    result[seen] = -np.inf
    return result


def ranker_grid(kind):
    if kind not in KINDS:
        raise ValueError("Expected movie or whole_series.")
    control_alpha = 1. if kind == "movie" else .25
    rows = [{"ranker": "Notebook18 shelf control", "family": "frozen", "alpha": control_alpha, "complexity": 0}]
    if kind == "whole_series":
        rows.append({"ranker": "Frozen shared personal", "family": "frozen", "alpha": 1., "complexity": 0})
    for complexity, family in enumerate(("shared_all", "shared_same", "independent"), 1):
        for alpha in (0., .25, .5, 1.):
            rows.append({"ranker": f"{family}; alpha={alpha:g}", "family": family, "alpha": alpha, "complexity": complexity})
    return rows


def _model_key(kind, family):
    return "frozen" if family == "frozen" else kind if family == "independent" else "shared"


def _personal_signal(model, kind, family, profile, seen_full):
    units = model["catalog"].unit.to_numpy()
    eligible = model.get("eligible_mask", np.ones(len(units), dtype=bool))
    columns = np.flatnonzero((units == kind) & eligible)
    mode = "same_type" if family in ("shared_same", "independent") else "all"
    history = profile_for_kind(profile, units, kind, mode)
    empty = np.asarray(history.sum(axis=1)).ravel() == 0
    seen = seen_full[:, columns]
    if family == "frozen":
        components = component_scores(model, history, seen_full)
        raw = blend_scores(model, components, model["best_personalized_variant"], seen_full, empty)[:, columns]
    else:
        parts = domain_components(model, history, columns, seen)
        raw = parts["cf"] + .25 * parts["synopsis"] + .25 * parts["metadata"] + .1 * model["quality"][columns]
    return raw, columns, seen, empty


def _load_data(root):
    original, validation, report17, protected, _ = _load_inputs(root)
    old = root / "data/processed/notebook18_filmaffinity"
    report18_path = old / "experiment_report.json"
    report18 = json.loads(report18_path.read_text(encoding="utf-8"))
    protected[str(report18_path)] = sha256_file(report18_path)
    for name in ("selected_policy.json", "shelf_leaderboard.csv", "shelf_per_user.csv", "policy_per_user.csv", "study_plan.json"):
        protected[str(old / name)] = _require_hash(old / name, report18["files"][name])
    for name, digest in report18["unit_spotcheck"]["output_files_sha256"].items():
        protected[str(old / name)] = _require_hash(old / name, digest)
    audit_runner = root / "scripts/filmaffinity_series_spotcheck.py"
    protected[str(audit_runner)] = _require_hash(audit_runner, report18["unit_spotcheck"]["runner_sha256"])
    policy_runner = root / "scripts/filmaffinity_ranking_policy.py"
    protected[str(policy_runner)] = _require_hash(policy_runner, report18["runner_sha256"])
    excluded = report18["unit_corrections"]["excluded_item_ids"]
    frozen, validation, corrections = apply_unit_exclusions(original, validation, excluded)
    train_path = root / "data/processed/notebook17_filmaffinity/train.csv"
    training = pd.read_csv(train_path)
    training = training.loc[~training.item_id.isin(excluded)].copy()
    catalog = original["catalog"].loc[frozen["eligible_mask"]].reset_index(drop=True).copy()
    old_shelves = pd.read_csv(old / "shelf_per_user.csv")
    old_control = pd.read_csv(old / "policy_per_user.csv")
    old_control = old_control.loc[old_control.policy == "Corrected hybrid control"].set_index("user_id")
    return frozen, training, catalog, validation, report17, report18, protected, old_shelves, old_control, corrections


def fit_models(frozen, training, catalog):
    users = frozen["user_ids"]
    shared = fit_training_basis(training, catalog, users)
    bank = {"frozen": frozen, "shared": shared}
    invariants = []
    for kind in KINDS:
        subset = catalog.loc[catalog.unit == kind].reset_index(drop=True)
        frame = training.loc[training.item_id.isin(subset.item_id)]
        bank[kind] = fit_training_basis(frame, subset, users)
        columns = pd.Index(shared["item_ids"]).get_indexer(subset.item_id)
        difference = shared["features"]["cf"][columns] - bank[kind]["features"]["cf"]
        error = float(np.max(np.abs(difference.data), initial=0))
        if error > 1e-7:
            raise AssertionError("Same training items/users should yield identical item-user cosine rows.")
        np.testing.assert_array_equal(shared["popularity"][columns], bank[kind]["popularity"])
        invariants.append({"kind": kind, "same_cf_rows": True, "max_absolute_cf_error": error, "same_train_popularity": True})
    return bank, invariants


def evaluate_kind(bank, validation, kind, grid):
    targets = _targets(validation)[kind]
    users = bank["shared"]["user_ids"]
    rows = [i for i, user in enumerate(users) if user in targets]
    if not rows:
        raise ValueError("A fixed positive-user cohort is required for each kind.")
    shared = bank["shared"]
    target_mask = shared["catalog"].unit.eq(kind).to_numpy()
    histories = np.asarray(shared["likes"][:, target_mask].sum(axis=1)).ravel().astype(int)
    records, examples, predicted = [], [], {entry["ranker"]: {} for entry in grid}
    for start in range(0, len(rows), 128):
        batch = rows[start:start + 128]
        signals = {}
        for family in dict.fromkeys(entry["family"] for entry in grid):
            model = bank[_model_key(kind, family)]
            profile, seen = model["likes"][batch], model["seen"][batch].toarray().astype(bool)
            signals[family] = _personal_signal(model, kind, family, profile, seen)
        for entry in grid:
            family = entry["family"]
            model = bank[_model_key(kind, family)]
            raw, columns, seen, empty = signals[family]
            ids = np.asarray(model["item_ids"])[columns]
            counts = model["popularity"][columns]
            scores = blend_personal_popularity(raw, counts, seen, entry["alpha"], empty)
            for local, ui in enumerate(batch):
                user = users[ui]
                chosen = ranked_indices(scores[local], np.ones(len(ids), dtype=bool), counts, ids)
                recs = ids[chosen].tolist()
                metrics = ranking_metrics(recs, targets[user])
                if len(recs) != TOP_K or len(set(recs)) != TOP_K or any(seen[local, col] for col in chosen):
                    raise AssertionError("Invalid top-ten candidate/seen handling.")
                predicted[entry["ranker"]][user] = recs
                records.append({"kind": kind, **entry, "user_id": user, "recall_at_10": metrics["recall"], "ndcg_at_10": metrics["ndcg"],
                                "hits": metrics["hits"], "positives": len(targets[user]), "empty_profile": bool(empty[local]),
                                "target_training_likes": int(histories[ui]), "history_bin": tv_history_bin(histories[ui])})
                if user in (users[rows[0]],):
                    for rank, col in enumerate(chosen, 1):
                        item = model["catalog"].iloc[columns[col]]
                        examples.append({"kind": kind, "ranker": entry["ranker"], "user_id": user, "rank": rank, "item_id": ids[col], "title": item.title})
        end = start + len(batch)
        if start == 0 or end == len(rows) or end % 1024 == 0:
            print(f"{kind}: validated {end:,}/{len(rows):,} users, {len(grid)} rankers.", flush=True)
    per_user = pd.DataFrame(records)
    board = per_user.groupby(["kind", "ranker", "family", "alpha", "complexity"], sort=False).agg(
        users=("user_id", "size"), recall_at_10=("recall_at_10", "mean"), ndcg_at_10=("ndcg_at_10", "mean"),
        empty_profile_users=("empty_profile", "sum")).reset_index()
    board = board.sort_values(["recall_at_10", "ndcg_at_10", "complexity", "alpha", "ranker"], ascending=[False, False, True, True, True], kind="stable").reset_index(drop=True)
    # Popularity's per-user list must be invariant across the three new bases.
    zeros = [entry["ranker"] for entry in grid if entry["alpha"] == 0]
    if any(predicted[name] != predicted[zeros[0]] for name in zeros[1:]):
        raise AssertionError("Training popularity/candidates changed between the new model families.")
    return board, per_user, predicted, pd.DataFrame(examples)


def _shelf_parity(per_user, old_shelves, kind):
    checks = []
    for name, alpha in (("Notebook18 shelf control", .25 if kind == "whole_series" else 1.), ("Frozen shared personal", 1.)):
        frame = per_user.loc[per_user.ranker == name]
        if frame.empty:
            continue
        previous = old_shelves.loc[pd.to_numeric(old_shelves.alpha, errors="coerce").eq(alpha)].set_index("user_id")
        reference = previous.reindex(frame.user_id)
        prefix = "tv" if kind == "whole_series" else "movie"
        errors = [np.abs(frame[f"{metric}_at_10"].to_numpy() - reference[f"{prefix}_{metric}_at_10"].to_numpy()).max() for metric in ("recall", "ndcg")]
        if max(errors) > 1e-10 or not np.isfinite(errors).all():
            raise AssertionError(f"Frozen18 shelf changed for {kind}.")
        checks.append({"kind": kind, "control": name, "users": len(frame), "max_absolute_error": float(max(errors)), "passed": True})
    return checks


def _recall_summary(frame, label, budget):
    return {"view": label, "total_budget": budget, "mixed_users": len(frame),
            "mixed_recall_at_budget": float(frame.mixed_recall.mean()),
            "movie_users": int(frame.movie_recall.notna().sum()), "movie_recall_at_budget": float(frame.movie_recall.mean()),
            "tv_users": int(frame.tv_recall.notna().sum()), "tv_recall_at_budget": float(frame.tv_recall.mean())}


def equal_budget_comparison(bank, validation, per_users, selections, old_control):
    targets = _targets(validation)
    union_rows = []
    configurations = [("Frozen personal shelves 10+10", {"movie": "Notebook18 shelf control", "whole_series": "Frozen shared personal"}),
                      ("Notebook18 best shelves 10+10", {kind: "Notebook18 shelf control" for kind in KINDS}),
                      ("Selected19 shelves 10+10", {kind: selections[kind]["ranker"] for kind in KINDS})]
    for label, selected in configurations:
        lookup = {kind: per_users[kind].loc[per_users[kind].ranker == selected[kind]].set_index("user_id") for kind in KINDS}
        for user, positives in targets["mixed"].items():
            hit_counts = {kind: int(lookup[kind].loc[user, "hits"]) if user in lookup[kind].index else 0 for kind in KINDS}
            union_rows.append({"view": label, "user_id": user, "mixed_recall": sum(hit_counts.values()) / len(positives),
                               "movie_recall": hit_counts["movie"] / len(targets["movie"][user]) if user in targets["movie"] else np.nan,
                               "tv_recall": hit_counts["whole_series"] / len(targets["whole_series"][user]) if user in targets["whole_series"] else np.nan})
    model = bank["frozen"]
    users, ids = model["user_ids"], np.asarray(model["item_ids"])
    rows = [i for i, user in enumerate(users) if user in targets["mixed"]]
    records, parity_errors = [], []
    for start in range(0, len(rows), 128):
        batch = rows[start:start + 128]
        profile, seen = model["likes"][batch], model["seen"][batch].toarray().astype(bool)
        empty = np.asarray(profile.sum(axis=1)).ravel() == 0
        components = component_scores(model, profile, seen)
        scores = blend_scores(model, components, model["best_personalized_variant"], seen, empty)
        for local, ui in enumerate(batch):
            user = users[ui]
            cols = ranked_indices(scores[local], model["eligible_mask"], model["popularity"], ids, k=20)
            recs = ids[cols].tolist()
            if len(recs) != 20:
                raise AssertionError("Mixed20 must actually contain twenty eligible titles.")
            check = ranking_metrics(recs[:10], targets["mixed"][user])
            parity_errors.append(max(abs(check[metric] - old_control.loc[user, f"mixed_{metric}_at_10"]) for metric in ("recall", "ndcg")))
            row = {"view": "Frozen shared mixed20", "user_id": user}
            for task, column in (("mixed", "mixed_recall"), ("movie", "movie_recall"), ("whole_series", "tv_recall")):
                relevant = targets[task].get(user)
                row[column] = ranking_metrics(recs, relevant, k=20)["recall"] if relevant else np.nan
            records.append(row)
    if max(parity_errors) > 1e-10:
        raise AssertionError("Frozen18 mixed10 changed while computing the mixed20 reference.")
    combined = pd.concat([pd.DataFrame(records), pd.DataFrame(union_rows)], ignore_index=True)
    board = pd.DataFrame([_recall_summary(frame, label, 20) for label, frame in combined.groupby("view", sort=False)])
    return board, combined, {"control": "Frozen18 mixed10", "users": len(rows), "max_absolute_error": float(max(parity_errors)), "passed": True}


def paired_intervals(per_user, selected):
    reference = per_user.loc[per_user.ranker == "Notebook18 shelf control"].set_index("user_id")
    current = per_user.loc[per_user.ranker == selected].set_index("user_id")
    rng, result = np.random.default_rng(SEED), []
    for metric in ("recall_at_10", "ndcg_at_10"):
        delta = (current[metric] - reference[metric]).to_numpy()
        draws = [rng.choice(delta, len(delta), replace=True).mean() for _ in range(2000)]
        low, high = np.quantile(draws, [.025, .975])
        result.append({"metric": metric, "users": len(delta), "mean_difference": float(delta.mean()), "lower_95": float(low), "upper_95": float(high)})
    return result


def run_experiment(root=ROOT):
    root, started = Path(root).resolve(), time.perf_counter()
    output = root / OUTPUT
    output.mkdir(parents=True, exist_ok=True)
    print("Verifying frozen sources, split and notebook18 eligibility corrections...", flush=True)
    frozen, training, catalog, validation, report17, report18, protected, old_shelves, old_control, corrections = _load_data(root)
    grids = {kind: ranker_grid(kind) for kind in KINDS}
    plan = {"experiment": "notebook19_separate_rankers", "like_threshold": LIKE_THRESHOLD, "rankers": grids,
            "fixed_hybrid_weights": {"cf": 1., "synopsis": .25, "metadata": .25, "quality": .1},
            "new_family_scaling": "Each CF/content component max-scaled over unseen TARGET-kind candidates; then personal/pop blend max-scaled over same candidates",
            "control_scaling": "Frozen18 controls preserve original full-catalog component scaling before type filtering",
            "families": {"shared_all": "Clean joint training basis, all-type liked history", "shared_same": "Same clean joint basis, target-type liked history only", "independent": "Target-only training basis/IDF/prior, target-type liked history"},
            "selection": "Each type separately: Recall@10, NDCG@10, simpler family, lower alpha, ranker name",
            "no_profile": "Training-popularity fallback for every alpha, including alpha1; no users dropped",
            "candidate_rule": "Exactly18 eligible training IDs of requested type, before top10; exclude all ratings; unavailable valid positives retained",
            "both_view": "Two independent shelves, ten titles each; no global ordering or quota",
            "budget_control": "Frozen shared mixed20 vs same frozen personal10+10 (allocation), best18 shelves10+10 and selected19 shelves10+10; union Recall only, no inter-section NDCG",
            "unit_exclusions": corrections["excluded_item_ids"], "test_feedback_read": False,
            "input_sha256": {str(Path(path).relative_to(root)): digest for path, digest in protected.items()}}
    plan_path = output / "study_plan.json"
    if plan_path.exists() and json.loads(plan_path.read_text(encoding="utf-8")) != plan:
        raise ValueError("Notebook19's frozen study plan changed; use a new experiment directory.")
    write_json(plan_path, plan)
    print(f"Refitting from {len(training):,} clean training ratings, no validation fitting...", flush=True)
    with threadpool_limits(limits=2):
        bank, invariants = fit_models(frozen, training, catalog)
        boards, per_users, all_predictions, examples, selections, parity = {}, {}, {}, [], {}, []
        for kind in KINDS:
            boards[kind], per_users[kind], all_predictions[kind], sample = evaluate_kind(bank, validation, kind, grids[kind])
            examples.append(sample)
            best_name = boards[kind].iloc[0]["ranker"]
            selections[kind] = next(entry for entry in grids[kind] if entry["ranker"] == best_name)
            parity.extend(_shelf_parity(per_users[kind], old_shelves, kind))
        budget, budget_users, mixed_parity = equal_budget_comparison(bank, validation, per_users, selections, old_control)
        parity.append(mixed_parity)
    frames = pd.concat(per_users.values(), ignore_index=True)
    family_best = pd.concat([board.groupby("family", sort=False).head(1) for board in boards.values()], ignore_index=True)
    history = frames.groupby(["kind", "ranker", "family", "alpha", "history_bin"], sort=False).agg(users=("user_id", "size"), recall_at_10=("recall_at_10", "mean"), ndcg_at_10=("ndcg_at_10", "mean"), empty_profile_users=("empty_profile", "sum")).reset_index()
    intervals = {kind: paired_intervals(per_users[kind], selections[kind]["ranker"]) for kind in KINDS}
    tables = {"movie_leaderboard.csv": boards["movie"], "tv_leaderboard.csv": boards["whole_series"], "family_ablation.csv": family_best,
              "per_user.csv": frames, "history_bin_metrics.csv": history, "equal_budget_comparison.csv": budget,
              "equal_budget_per_user.csv": budget_users, "recommendation_examples.csv": pd.concat(examples, ignore_index=True)}
    for name, frame in tables.items():
        frame.to_csv(output / name, index=False)
    # Persist only the fitted models required by the two selected rankers.
    required_keys = {_model_key(kind, selections[kind]["family"]) for kind in KINDS}
    bundle = {"models": {key: bank[key] for key in required_keys}, "selections": selections,
              "global_eligible_ids": catalog.item_id.tolist(), "excluded_item_ids": corrections["excluded_item_ids"],
              "source_split": report17["split"]["split_id"], "validation_only": True}
    joblib.dump(bundle, output / "trained_rankers.joblib", compress=3)
    write_json(output / "selection.json", {"selections": selections, "scores": {kind: board.iloc[0].to_dict() for kind, board in boards.items()}, "validation_only": True})
    # Deterministic first positive user of each type, never selected by gains.
    restored = joblib.load(output / "trained_rankers.joblib")
    inference_checks = []
    for kind in KINDS:
        user = sorted(_targets(validation)[kind])[0]
        past = training.loc[training.user_id == user].set_index("item_id").rating.to_dict()
        recs = recommend(restored, past, kind)
        expected = all_predictions[kind][selections[kind]["ranker"]][user]
        if recs.item_id.tolist() != expected:
            raise AssertionError("Persisted separate-ranker inference differs from evaluation.")
        inference_checks.append({"kind": kind, "user_id": user, "saved_predictions_match": True})
    write_json(output / "inference_checks.json", inference_checks)
    os.environ.setdefault("MPLCONFIGDIR", str(output / "matplotlib_cache"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    for ax, kind, title in zip(axes, KINDS, ("Movies: ten movie recommendations", "Series: ten series recommendations")):
        shown = family_best.loc[family_best.kind == kind]
        ax.bar(np.arange(len(shown)), shown.recall_at_10)
        ax.set(xticks=np.arange(len(shown)), xticklabels=shown.family, ylabel="Validation macro Recall@10", title=title)
        ax.tick_params(axis="x", labelrotation=20)
        for x, value in enumerate(shown.recall_at_10):
            ax.text(x, value, f"{value:.4f}", ha="center", va="bottom", fontsize=9)
    fig.tight_layout()
    fig.savefig(output / "separate_rankers_comparison.png", dpi=150)
    plt.close(fig)
    for path, digest in protected.items():
        _require_hash(Path(path), digest)
    names = list(tables) + ["study_plan.json", "selection.json", "trained_rankers.joblib", "inference_checks.json", "separate_rankers_comparison.png"]
    dataset = {"clean_training_ratings": len(training), "training_users": len(frozen["user_ids"]), "training_candidates": len(catalog),
               "movie_candidates": int(catalog.unit.eq("movie").sum()), "series_candidates": int(catalog.unit.eq("whole_series").sum()),
               "movie_validation_users": int(boards["movie"].iloc[0].users), "series_validation_users": int(boards["whole_series"].iloc[0].users),
               "new_rankers_per_type": 12, "total_rankers": sum(map(len, grids.values()))}
    scope = {"evaluation_split": "validation", "test_feedback_read": False, "raw_rating_archive_read": False, "paid_api_calls": False, "app_changed": False,
             "training": "Refit clean joint and independent-domain bases using frozen training only; frozen18 controls are not refit",
             "cf_interpretation": "Binary item-user cosine is unchanged for the same items/users; per-type fit differences concern content IDF/vocabulary and training prior, not a new CF algorithm",
             "history_interpretation": "Shared_all vs shared_same isolates profile history at fixed alpha; independent vs shared_same changes the type-specific content/prior fitting package",
             "fallback_interpretation": "Empty personal profiles fall back to training counts even at alpha1; fallback counts accompany every row",
             "budget": "Per-type model gains require the same ten slots per type. Both has twenty total titles; equal-budget union Recall is a separate allocation comparison",
             "limits": "Repeated validation, review-selected feedback, publication-date proxies, provisional unit labels beyond12 exclusions, inherited retrospective cohort",
             "inherited_cohort": "Original minimum history/date counts included now-excluded season entries; cleaned cohort not reselected by future scores",
             "comparison": "No claim of test performance, real-user improvement, LLM superiority or direct MovieLens comparison"}
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "elapsed_seconds": time.perf_counter() - started,
              "scope": scope, "study_plan": plan, "dataset": dataset, "unit_corrections": corrections,
              "selections": {kind: {**selections[kind], **boards[kind].iloc[0].to_dict()} for kind in KINDS},
              "family_best": family_best.to_dict("records"), "paired_intervals": intervals,
              "coverage": report18["coverage"],
              "history_bins": history.loc[np.logical_or.reduce([
                  history.kind.eq(kind) & history.ranker.eq(entry["ranker"]) for kind, entry in selections.items()
              ])].to_dict("records"),
              "budget_comparison": budget.to_dict("records"), "parity_checks": parity, "training_invariants": invariants,
              "inference_checks": inference_checks, "old_inputs_unchanged_after_run": True,
              "files": {name: sha256_file(output / name) for name in names}, "runner_sha256": sha256_file(__file__),
              "domain_helper_sha256": sha256_file(root / "scripts/filmaffinity_domain_models.py"),
              "versions": {name: importlib.metadata.version(name) for name in ("numpy", "pandas", "scipy", "scikit-learn", "joblib")}}
    write_json(output / "experiment_report.json", report)
    print(f"Selected independently: {selections}; completed in {time.perf_counter() - started:.1f}s.", flush=True)
    return report


def recommend(bundle, user_ratings, kind="movie"):
    """Request type before top-k; Both returns two independent ten-item frames."""
    if kind == "both":
        return {"movies": recommend(bundle, user_ratings, "movie"), "series": recommend(bundle, user_ratings, "whole_series")}
    if kind not in KINDS:
        raise ValueError("kind must be movie, whole_series, or both.")
    eligible_ids = set(bundle["global_eligible_ids"])
    for item, rating in user_ratings.items():
        if item not in eligible_ids or not np.isfinite(rating) or not 1 <= rating <= 10:
            raise ValueError(f"Unknown/excluded title or invalid rating: {item}")
    entry = bundle["selections"][kind]
    model = bundle["models"][_model_key(kind, entry["family"])]
    ids = model["item_ids"]
    index = {item: col for col, item in enumerate(ids)}
    cols = [index[item] for item, rating in user_ratings.items() if item in index and rating >= LIKE_THRESHOLD]
    profile = sparse.csr_matrix((np.ones(len(cols), dtype=np.float32), ([0] * len(cols), cols)), shape=(1, len(ids)))
    seen = np.zeros((1, len(ids)), dtype=bool)
    seen[0] = ~model.get("eligible_mask", np.ones(len(ids), dtype=bool))
    for item in user_ratings:
        if item in index:
            seen[0, index[item]] = True
    raw, columns, seen_target, empty = _personal_signal(model, kind, entry["family"], profile, seen)
    counts = model["popularity"][columns]
    scores = blend_personal_popularity(raw, counts, seen_target, entry["alpha"], empty)[0]
    candidate_ids = np.asarray(ids)[columns]
    chosen = ranked_indices(scores, np.ones(len(columns), dtype=bool), counts, candidate_ids)
    result = model["catalog"].iloc[columns[chosen]][["item_id", "title", "original_title", "year", "unit", "confidence"]].copy().reset_index(drop=True)
    return result.assign(rank=np.arange(len(result)) + 1)


if __name__ == "__main__":
    print(json.dumps(run_experiment(ROOT)["selections"], indent=2))
