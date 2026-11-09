"""Notebook 17: offline, validation-only movie/whole-series hybrid study.

No MovieLens benchmark or test feedback is loaded. FilmAffinity's review dates
are publication-date proxies, and title-unit labels are provisional audit data.
"""

import ast
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import itertools
import json
import os
from pathlib import Path
import unicodedata

import joblib
import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import MultiLabelBinarizer, normalize
from threadpoolctl import threadpool_limits


OUTPUT = Path("data/processed/notebook17_filmaffinity")
SPLIT_ID = "filmaffinity_review_date_groups_60_20_20_v1"
LIKE_THRESHOLD = 8.0
TOP_K = 10
SEED = 42


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def split_by_review_date(ratings, min_ratings=10, min_dates=3):
    """Counts-only retrospective cohort; whole equal-date groups stay together.

    Choose the first cumulative boundary nearest 60%, constrained to leave two
    dates; choose the next nearest 80%, leaving one date. Ties choose earlier.
    Ratings never influence eligibility or boundaries. This is not a claim that
    review dates are the actual times a preference was recorded.
    """
    if min_ratings < 3 or min_dates < 3:
        raise ValueError("Three nonempty date groups are required.")
    frame = ratings.copy()
    required = {"user_id", "item_id", "rating", "rated_at"}
    if not required.issubset(frame.columns):
        raise ValueError("Ratings require user_id, item_id, rating, rated_at.")
    if frame[["user_id", "item_id"]].isna().any().any() or frame.duplicated(["user_id", "item_id"]).any():
        raise ValueError("Missing identities or duplicate user/item pairs.")
    frame["rated_at"] = pd.to_datetime(frame["rated_at"], utc=True, errors="raise").dt.normalize()
    if frame["rated_at"].isna().any() or not frame["rating"].between(1, 10).all():
        raise ValueError("Invalid date or rating outside 1-10.")
    frame = frame.sort_values(["user_id", "rated_at", "item_id"], kind="stable").reset_index(drop=True)
    assigned = np.full(len(frame), -1, dtype=np.int8)
    eligible_users = 0
    for _, group in frame.groupby("user_id", sort=True):
        date_sizes = group.groupby("rated_at", sort=True).size().to_numpy()
        if len(group) < min_ratings or len(date_sizes) < min_dates:
            continue
        eligible_users += 1
        cumulative = np.cumsum(date_sizes)
        first_options = cumulative[:len(date_sizes) - 2]
        first_group = int(np.argmin(np.abs(first_options - 0.6 * len(group))))
        second_options = cumulative[first_group + 1:-1]
        second_group = first_group + 1 + int(np.argmin(np.abs(second_options - 0.8 * len(group))))
        first, second = int(cumulative[first_group]), int(cumulative[second_group])
        indices = group.index.to_numpy()
        assigned[indices[:first]] = 0
        assigned[indices[first:second]] = 1
        assigned[indices[second:]] = 2
    parts = [frame.loc[assigned == part].reset_index(drop=True) for part in range(3)]
    if not eligible_users:
        raise ValueError("No users satisfy the prespecified history/date requirements.")
    for earlier, later in zip(parts, parts[1:]):
        if not (earlier.groupby("user_id").rated_at.max() < later.groupby("user_id").rated_at.min()).all():
            raise AssertionError("Equal-date groups crossed a split boundary.")
    summary = {
        "split_id": SPLIT_ID, "eligible_users": eligible_users,
        "min_ratings": min_ratings, "min_distinct_review_dates": min_dates,
        "input_ratings": len(frame), "excluded_history_ratings": int((assigned < 0).sum()),
        "rows": dict(zip(("train", "validation", "reserved_test"), map(len, parts))),
        "actual_fractions": dict(zip(("train", "validation", "reserved_test"), [len(p) / (assigned >= 0).sum() for p in parts])),
        "policy": "Nearest cumulative 60%, then 80%; whole UTC review-day groups; ties earlier; no score-based cuts.",
        "eligibility": "Retrospective minimum-history cohort, determined by counts and dates only; not a new-user study.",
        "time_limitation": "Review publication dates are proxies, not verified rating timestamps; current snapshot metadata.",
    }
    return *parts, summary


def ranking_metrics(recommended, positives, k=TOP_K):
    """Unavailable relevant titles remain in Recall and ideal-DCG denominators."""
    if len(recommended) != len(set(recommended)):
        raise ValueError("Duplicate recommendations are not valid ranked items.")
    if k < 1:
        raise ValueError("k must be positive.")
    if not positives:
        raise ValueError("A ranking evaluation needs at least one relevant item.")
    hits = np.array([item in positives for item in recommended[:k]], dtype=float)
    discounts = 1 / np.log2(np.arange(len(hits)) + 2)
    ideal = float(np.sum(1 / np.log2(np.arange(min(k, len(positives))) + 2)))
    return {"recall": float(hits.sum() / len(positives)),
            "ndcg": float(hits @ discounts / ideal), "hits": int(hits.sum())}


def quality_prior(train, candidate_ids, strength=20):
    """Bayesian mean of training feedback only, mapped from 1-10 into 0-1."""
    if train.empty or strength <= 0 or not train.rating.between(1, 10).all():
        raise ValueError("A positive shrinkage strength and valid training ratings are required.")
    stats = train.groupby("item_id").rating.agg(["sum", "count"]).reindex(candidate_ids).fillna(0)
    means = (stats["sum"] + strength * train.rating.mean()) / (stats["count"] + strength)
    return (means.to_numpy(dtype=float) - 1) / 9


def _names(value):
    if isinstance(value, str):
        try:
            parsed = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            parsed = [value] if value.strip() else []
        value = parsed if isinstance(parsed, list) else [str(parsed)]
    if not isinstance(value, (list, tuple, np.ndarray)):
        return []
    names = []
    for name in value:
        normalized = " ".join(unicodedata.normalize("NFKC", str(name)).casefold().split())
        if normalized:
            names.append(normalized)
    return list(dict.fromkeys(names))


def _structured_features(values):
    encoder = MultiLabelBinarizer(sparse_output=True)
    binary = encoder.fit_transform(values).astype(np.float32)
    if binary.shape[1] == 0:
        return sparse.csr_matrix((len(values), 1), dtype=np.float32), encoder, np.zeros(1)
    idf = np.log((len(values) + 1) / (np.asarray(binary.sum(axis=0)).ravel() + 1)) + 1
    return normalize(binary.multiply(idf).tocsr()).astype(np.float32), encoder, idf


def build_content_features(catalog):
    """Fit on the supplied training catalog, never on held-out-only titles.

    Spanish text uses Unicode normalization and no English stop-word filter.
    Structured cast names are not external person identifiers.
    """
    synopses = catalog.synopsis.fillna("").astype(str)
    vectorizer = TfidfVectorizer(strip_accents="unicode", stop_words=None,
                                 sublinear_tf=True, ngram_range=(1, 2),
                                 min_df=2 if len(catalog) >= 3 else 1,
                                 max_features=30000, dtype=np.float32)
    try:
        plot = vectorizer.fit_transform(synopses)
    except ValueError as exc:
        if "empty vocabulary" not in str(exc) and "no terms remain" not in str(exc).lower():
            raise
        plot = sparse.csr_matrix((len(catalog), 1), dtype=np.float32)
        vectorizer = None
    genres, genre_encoder, genre_idf = _structured_features([_names(v) for v in catalog.film_genre])
    cast, cast_encoder, cast_idf = _structured_features([_names(v)[:5] for v in catalog.film_cast])
    return {"synopsis": plot, "genres": genres, "cast": cast,
            "encoders": {"synopsis": vectorizer, "genres": genre_encoder, "cast": cast_encoder},
            "idf": {"genres": genre_idf, "cast": cast_idf}}


def prepare_data(root):
    """Verify notebook-16 exports/raw metadata without rerunning or editing it."""
    root = Path(root)
    audit_dir = root / "data/processed/notebook16_dataset_audit"
    report_path = audit_dir / "audit_report.json"
    if not report_path.exists():
        raise FileNotFoundError("Run notebook 16's dataset audit first; audit_report.json is missing.")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    hashes = {"audit_report.json": sha256_file(report_path)}
    for name in ("filmaffinity_clean_ratings.csv", "filmaffinity_catalog_units.csv"):
        hashes[name] = sha256_file(audit_dir / name)
        if hashes[name] != report["files"][name]["sha256"]:
            raise ValueError(f"Notebook 16 export changed: {name}; audit it before training.")
    manifest_path = root / "data/raw/notebook16_dataset_audit/manifest.json"
    if sha256_file(manifest_path) != report["sources_manifest_sha256"]:
        raise ValueError("Notebook 16 source manifest changed; rerun its audit first.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    info_path = root / "data/raw/notebook16_dataset_audit/filmaffinity/film_info.parquet"
    asset = next(a for a in manifest["assets"] if a["dataset"] == "filmaffinity" and Path(a["local_path"]).name == info_path.name)
    hashes["film_info.parquet"] = sha256_file(info_path)
    if asset["status"] != "ok" or hashes["film_info.parquet"] != asset["sha256"]:
        raise ValueError("FilmAffinity metadata no longer matches its verified snapshot.")
    catalog = pd.read_csv(audit_dir / "filmaffinity_catalog_units.csv")
    ratings = pd.read_csv(audit_dir / "filmaffinity_clean_ratings.csv")
    allowed = catalog.unit.isin(["movie", "whole_series"]) & catalog.confidence.isin(["high", "medium"])
    catalog = catalog.loc[allowed].copy()
    ratings = ratings.loc[ratings.item_id.isin(catalog.item_id)].copy()
    train, validation, reserved, split = split_by_review_date(ratings)
    output = root / OUTPUT
    output.mkdir(parents=True, exist_ok=True)
    # This function alone constructs the partitions from the audited source.
    # No downstream loader opens reserved_test.csv, even when rerun.
    for name, frame in (("train", train), ("validation", validation), ("reserved_test", reserved)):
        path = output / f"{name}.csv"
        serialized = frame.to_csv(index=False).encode("utf-8")
        if path.exists() and sha256_file(path) != hashlib.sha256(serialized).hexdigest():
            raise ValueError(f"Refusing to replace a different frozen {name} split: {path}")
        if not path.exists():
            path.write_bytes(serialized)
    # Hash from bytes created here, not by reading reserved feedback for ranking.
    split["files"] = {name: hashlib.sha256(frame.to_csv(index=False).encode("utf-8")).hexdigest()
                      for name, frame in (("train.csv", train), ("validation.csv", validation), ("reserved_test.csv", reserved))}
    del reserved, ratings
    # Only metadata for titles in training is fit or served as candidates.
    catalog = catalog.set_index("item_id").loc[sorted(train.item_id.unique())].reset_index()
    info = pd.read_parquet(info_path, columns=["film_id", "film_genre", "film_cast"])
    catalog = catalog.merge(info.rename(columns={"film_id": "item_id"}), on="item_id", how="left", validate="one_to_one")
    provenance = {"input_sha256": hashes, "source_revision": asset["revision"],
                  "source_manifest_sha256": report["sources_manifest_sha256"]}
    write_json(output / "split_manifest.json", {**split, **provenance})
    return train, validation, catalog, split, provenance


def fit_model(train, catalog):
    users = sorted(train.user_id.unique())
    ids = catalog.item_id.tolist()
    ui, ii = {v: i for i, v in enumerate(users)}, {v: i for i, v in enumerate(ids)}
    row, col = train.user_id.map(ui).to_numpy(), train.item_id.map(ii).to_numpy()
    seen = sparse.csr_matrix((np.ones(len(train), dtype=np.float32), (row, col)), shape=(len(users), len(ids)))
    liked_rows = train.rating.to_numpy() >= LIKE_THRESHOLD
    likes = sparse.csr_matrix((np.ones(liked_rows.sum(), dtype=np.float32), (row[liked_rows], col[liked_rows])), shape=seen.shape)
    content = build_content_features(catalog)
    # Each item is a unit vector of training users who liked it. No test/val rows.
    cf = normalize(likes.T.tocsr()).astype(np.float32)
    popularity = np.asarray(likes.sum(axis=0)).ravel()
    return {"user_ids": users, "item_ids": ids, "catalog": catalog, "seen": seen, "likes": likes,
            "features": {"cf": cf, **{k: content[k] for k in ("synopsis", "genres", "cast")}},
            "content_encoders": content["encoders"], "content_idf": content["idf"],
            "popularity": popularity, "quality": quality_prior(train, ids),
            "like_threshold": LIKE_THRESHOLD, "top_k": TOP_K}


def _scaled(scores, seen):
    """Max-scale nonnegative components over unseen candidates, per user."""
    scores = np.asarray(scores, dtype=np.float32)
    scores[seen] = 0
    maximum = scores.max(axis=1, keepdims=True)
    return np.divide(scores, maximum, out=np.zeros_like(scores), where=maximum > 0)


def component_scores(model, profile, seen):
    """Content cosine and full item-cosine CF; small batches bound memory."""
    components = {}
    for name, features in model["features"].items():
        preferences = (profile @ features).tocsr()
        if name != "cf":
            preferences = normalize(preferences)
        scores = (preferences @ features.T).toarray()
        components[name] = _scaled(scores, seen)
    components["metadata"] = (components.pop("genres") + components.pop("cast")) / 2
    return components


def model_grid():
    # Frozen before validation is scored: three controls plus twelve combinations.
    variants = [{"model": "Training popularity", "kind": "popularity", "plot": 0., "metadata": 0., "quality": 0.},
                {"model": "Training Bayesian quality", "kind": "quality", "plot": 0., "metadata": 0., "quality": 1.},
                {"model": "Content only", "kind": "content", "plot": 1., "metadata": .25, "quality": 0.}]
    for plot, metadata, quality in itertools.product((0., .25, .5), (0., .25), (0., .1)):
        name = "Item CF" if (plot, metadata, quality) == (0., 0., 0.) else f"Hybrid p={plot:g} m={metadata:g} q={quality:g}"
        variants.append({"model": name, "kind": "hybrid", "plot": plot, "metadata": metadata, "quality": quality})
    return variants


def blend_scores(model, components, variant, seen, no_likes):
    shape = seen.shape
    if variant["kind"] == "popularity":
        scores = np.broadcast_to(model["popularity"], shape).copy()
    elif variant["kind"] == "quality":
        scores = np.broadcast_to(model["quality"], shape).copy()
    else:
        scores = np.zeros(shape, dtype=np.float32)
        if variant["kind"] == "hybrid":
            scores += components["cf"]
        scores += variant["plot"] * components["synopsis"] + variant["metadata"] * components["metadata"]
        scores += variant["quality"] * model["quality"]
        scores[no_likes] = model["popularity"]
    scores[seen] = -np.inf
    return scores


def ranked_indices(scores, mask, popularity, ids, k=TOP_K):
    """Exact deterministic top-k: score, train-like count, then item ID."""
    allowed = np.flatnonzero(mask & np.isfinite(scores))
    if not len(allowed):
        return allowed
    if len(allowed) > k:
        threshold = np.partition(scores[allowed], -k)[-k]
        allowed = allowed[scores[allowed] >= threshold]
    order = np.lexsort((ids[allowed], -popularity[allowed], -scores[allowed]))
    return allowed[order[:k]]


def _targets(validation, catalog):
    # Full audited unit map, not just train catalog, is needed for unavailable
    # held-out titles' task membership; caller adds unit before training cutoff.
    targets = {}
    for task in ("mixed", "movie", "whole_series"):
        relevant = validation.loc[validation.rating >= LIKE_THRESHOLD]
        if task != "mixed":
            relevant = relevant.loc[relevant.unit == task]
        targets[task] = relevant.groupby("user_id").item_id.agg(set).to_dict()
    return targets


def evaluate_grid(model, validation, variants, batch_size=128):
    users, ids = model["user_ids"], np.array(model["item_ids"])
    units = model["catalog"].unit.to_numpy()
    masks = {"mixed": np.ones(len(ids), dtype=bool), "movie": units == "movie", "whole_series": units == "whole_series"}
    targets = _targets(validation, model["catalog"])
    if any(not targets[task] for task in masks):
        raise ValueError("The validation split needs positive users in all three tasks.")
    # 15 variants x 3 tasks x users x (recall, ndcg, hits); NaN marks users who
    # have no held-out positives for that task. Cohorts stay fixed for all models.
    values = np.full((len(variants), 3, len(users), 3), np.nan)
    tasks = list(masks)
    coverage = []
    examples = []
    for start in range(0, len(users), batch_size):
        end = min(start + batch_size, len(users))
        seen = model["seen"][start:end].toarray().astype(bool)
        profile = model["likes"][start:end]
        no_likes = np.asarray(profile.sum(axis=1)).ravel() == 0
        components = component_scores(model, profile, seen)
        for local, user in enumerate(users[start:end]):
            for task, mask in masks.items():
                positives = targets[task].get(user)
                if not positives:
                    continue
                candidates = set(ids[mask & ~seen[local]])
                available = len(candidates & positives)
                coverage.append({"user_id": user, "task": task, "positives": len(positives), "available": available,
                                 "available_fraction": available / len(positives),
                                 "recall_ceiling_at_10": min(TOP_K, available) / len(positives),
                                 "train_likes": int(profile[local].sum()),
                                 "train_tv_likes": int(profile[local, units == "whole_series"].sum())})
        for variant_index, variant in enumerate(variants):
            scores = blend_scores(model, components, variant, seen, no_likes)
            for local, user in enumerate(users[start:end]):
                for task_index, (task, mask) in enumerate(masks.items()):
                    positives = targets[task].get(user)
                    if not positives:
                        continue
                    columns = ranked_indices(scores[local], mask, model["popularity"], ids)
                    recs = ids[columns].tolist()
                    metrics = ranking_metrics(recs, positives)
                    values[variant_index, task_index, start + local] = [metrics["recall"], metrics["ndcg"], metrics["hits"]]
                    # Fixed first three eligible users by ID; no selection for gains.
                    if len(examples) < 2000 and user in users[:3]:
                        for rank, col in enumerate(columns, 1):
                            item = model["catalog"].iloc[col]
                            examples.append({"model": variant["model"], "user_id": user, "task": task, "rank": rank,
                                             "item_id": ids[col], "title": item.title, "original_title": item.original_title,
                                             "unit": item.unit, "confidence": item.confidence, "validation_hit": ids[col] in positives})
        if start == 0 or end == len(users) or end % 1024 == 0:
            print(f"Validated {end:,}/{len(users):,} users against {len(variants)} models.", flush=True)
    rows = []
    for vi, variant in enumerate(variants):
        row = dict(variant)
        for ti, task in enumerate(tasks):
            row[f"{task}_users"] = int(np.isfinite(values[vi, ti, :, 0]).sum())
            row[f"{task}_recall_at_10"] = float(np.nanmean(values[vi, ti, :, 0]))
            row[f"{task}_ndcg_at_10"] = float(np.nanmean(values[vi, ti, :, 1]))
        row["balanced_recall_at_10"] = (row["movie_recall_at_10"] + row["whole_series_recall_at_10"]) / 2
        row["weight_total"] = sum(variant[k] for k in ("plot", "metadata", "quality"))
        rows.append(row)
    leaderboard = pd.DataFrame(rows).sort_values(
        ["balanced_recall_at_10", "mixed_recall_at_10", "mixed_ndcg_at_10", "weight_total", "model"],
        ascending=[False, False, False, True, True], kind="stable").reset_index(drop=True)
    return leaderboard, values, pd.DataFrame(coverage), pd.DataFrame(examples)


def paired_intervals(values, variants, selected_name):
    selected = next(i for i, v in enumerate(variants) if v["model"] == selected_name)
    rng = np.random.default_rng(SEED)
    intervals = []
    for baseline in ("Training popularity", "Content only", "Item CF"):
        bi = next(i for i, v in enumerate(variants) if v["model"] == baseline)
        for ti, task in enumerate(("mixed", "movie", "whole_series")):
            difference = values[selected, ti, :, 0] - values[bi, ti, :, 0]
            difference = difference[np.isfinite(difference)]
            # Validation-only paired user bootstrap; selected on these same users.
            samples = [float(rng.choice(difference, len(difference), replace=True).mean()) for _ in range(2000)]
            low, high = np.quantile(samples, [.025, .975])
            intervals.append({"baseline": baseline, "task": task, "users": len(difference),
                              "mean_recall_difference": float(difference.mean()), "lower_95": float(low), "upper_95": float(high),
                              "model": selected_name,
                              "interpretation": "Descriptive validation interval after model selection, not an independent significance claim."})
    return intervals


def recommend(model, user_ratings, kind="mixed", k=TOP_K):
    """Actual saved-model inference from FilmAffinity-ID -> 1-10 rating mapping.

    Only known training-catalog titles can form a profile. Unknown IDs produce
    an error rather than silently turning a user into an empty profile.
    """
    if kind not in ("mixed", "movie", "whole_series"):
        raise ValueError("kind must be mixed, movie, or whole_series.")
    if k < 1 or k > 100:
        raise ValueError("k must be between 1 and 100.")
    ids = np.array(model["item_ids"])
    index = {item: i for i, item in enumerate(ids)}
    for item, rating in user_ratings.items():
        if item not in index or not np.isfinite(rating) or not 1 <= rating <= 10:
            raise ValueError(f"Unknown FilmAffinity training ID or invalid rating: {item}")
    cols = [index[item] for item, rating in user_ratings.items() if rating >= model["like_threshold"]]
    profile = sparse.csr_matrix((np.ones(len(cols), dtype=np.float32), ([0] * len(cols), cols)), shape=(1, len(ids)))
    seen = np.zeros((1, len(ids)), dtype=bool)
    for item in user_ratings:
        seen[0, index[item]] = True
    components = component_scores(model, profile, seen)
    scores = blend_scores(model, components, model["selected_variant"], seen, np.array([not cols]))[0]
    mask = np.ones(len(ids), dtype=bool) if kind == "mixed" else model["catalog"].unit.eq(kind).to_numpy()
    columns = ranked_indices(scores, mask, model["popularity"], ids, k)
    return model["catalog"].iloc[columns][["item_id", "title", "original_title", "year", "unit", "confidence"]].assign(score=scores[columns]).reset_index(drop=True)


def run_experiment(root):
    """Train from audited local data, select on validation, reserve test untouched."""
    root = Path(root).resolve()
    output = root / OUTPUT
    variants = model_grid()
    print("Verifying audited inputs; preparing frozen FilmAffinity-only split...", flush=True)
    train, validation, catalog, split, provenance = prepare_data(root)
    # Membership only for evaluation tasks; do not fit encoders on this full map.
    units = pd.read_csv(root / "data/processed/notebook16_dataset_audit/filmaffinity_catalog_units.csv", usecols=["item_id", "unit"])
    validation = validation.merge(units, on="item_id", validate="many_to_one")
    write_json(output / "study_plan.json", {
        "like_threshold": LIKE_THRESHOLD, "split_id": SPLIT_ID, "variants": variants,
        "selection_primary": "Equal-weight mean of movie-only and whole-series-only macro Recall@10",
        "tie_break": "Mixed Recall@10, mixed NDCG@10, smaller total added weight, model name",
        "candidates": "All training-catalog items in task; exclude every training rating including low scores",
        "unavailable_positives": "Retained in recall and ideal-DCG denominators",
        "content": "Train-catalog Spanish synopsis TF-IDF; IDF genres and first-five cast names, averaged equally",
        "score_scaling": "Each CF/content component scaled by per-user maximum unseen score before task filtering",
        "quality_prior": "Training-only Bayesian mean, prior strength 20, global training mean; no source-wide audience stats",
        "no_like_fallback": "Training like counts, then item ID; includes users with no training likes",
        "test_evaluated": False, "paid_api_calls": False, **provenance})
    print(f"Training on {len(train):,} ratings from {train.user_id.nunique():,} users, {len(catalog):,} titles...", flush=True)
    with threadpool_limits(limits=2):
        model = fit_model(train, catalog)
        leaderboard, values, coverage, examples = evaluate_grid(model, validation, variants)
    selected_name = leaderboard.iloc[0]["model"]
    selected = next(v for v in variants if v["model"] == selected_name)
    personalized_row = leaderboard.loc[leaderboard.kind == "hybrid"].iloc[0]
    personalized_name = personalized_row["model"]
    personalized = next(v for v in variants if v["model"] == personalized_name)
    model["selected_variant"] = selected
    model["best_personalized_variant"] = personalized
    model["provenance"] = provenance
    model["split_id"] = SPLIT_ID
    print(f"Selected on balanced validation Recall@10: {selected_name}", flush=True)
    intervals = paired_intervals(values, variants, selected_name)
    if personalized_name != selected_name:
        intervals.extend(paired_intervals(values, variants, personalized_name))
    retain = {selected_name, personalized_name, "Training popularity", "Training Bayesian quality", "Content only", "Item CF"}
    per_user = []
    for vi, variant in enumerate(variants):
        if variant["model"] not in retain:
            continue
        for ti, task in enumerate(("mixed", "movie", "whole_series")):
            for ui, user in enumerate(model["user_ids"]):
                recall, ndcg, hits = values[vi, ti, ui]
                if np.isfinite(recall):
                    per_user.append({"model": variant["model"], "task": task, "user_id": user,
                                     "recall_at_10": recall, "ndcg_at_10": ndcg, "hits": int(hits)})
    leaderboard.to_csv(output / "leaderboard.csv", index=False)
    coverage.to_csv(output / "coverage.csv", index=False)
    pd.DataFrame(per_user).to_csv(output / "validation_per_user.csv", index=False)
    examples.loc[examples.model.isin(retain)].to_csv(output / "recommendation_examples.csv", index=False)
    pd.DataFrame(intervals).to_csv(output / "paired_validation_intervals.csv", index=False)
    catalog.to_csv(output / "training_catalog.csv", index=False)
    joblib.dump(model, output / "trained_model.joblib", compress=3)
    # A reload/inference consistency check exercises the actual persisted model.
    first_user = model["user_ids"][0]
    history = train.loc[train.user_id == first_user].set_index("item_id").rating.to_dict()
    reloaded = joblib.load(output / "trained_model.joblib")
    reload_examples = []
    for variant in (selected, personalized) if personalized_name != selected_name else (selected,):
        original_recs = recommend({**model, "selected_variant": variant}, history)
        reloaded_recs = recommend({**reloaded, "selected_variant": variant}, history)
        pd.testing.assert_frame_equal(original_recs, reloaded_recs)
        reload_examples.append(original_recs.assign(model=variant["model"]))
    pd.concat(reload_examples, ignore_index=True).to_csv(output / "reload_inference_example.csv", index=False)
    os.environ.setdefault("MPLCONFIGDIR", str(output / "matplotlib_cache"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    shown = leaderboard.loc[leaderboard.model.isin(retain)].copy()
    x = np.arange(len(shown))
    fig, ax = plt.subplots(figsize=(11, 5.5))
    for offset, task, label in ((-.24, "movie", "Movies"), (0, "whole_series", "Whole-series candidates"), (.24, "mixed", "Mixed catalog")):
        ax.bar(x + offset, shown[f"{task}_recall_at_10"], width=.24, label=label)
    ax.set(xticks=x, xticklabels=shown.model, ylabel="Macro Recall@10", title="FilmAffinity validation: training-catalog recommendations")
    ax.tick_params(axis="x", labelrotation=14)
    ax.legend()
    fig.tight_layout()
    fig.savefig(output / "validation_comparison.png", dpi=150)
    plt.close(fig)
    dataset = {"training_ratings": len(train), "validation_ratings": len(validation), "training_users": len(model["user_ids"]),
               "training_catalog_titles": len(catalog), "training_catalog_units": {str(k): int(v) for k, v in catalog.unit.value_counts().items()},
               "training_ratings_units": {str(k): int(v) for k, v in train.merge(catalog[["item_id", "unit"]], on="item_id").unit.value_counts().items()},
               "users_without_training_likes": int((np.asarray(model["likes"].sum(axis=1)).ravel() == 0).sum()),
               "catalog_without_training_likes": int((model["popularity"] == 0).sum()),
               "missing_feature_items": {name: int((np.asarray(feat.multiply(feat).sum(axis=1)).ravel() == 0).sum()) for name, feat in model["features"].items()}}
    scope = {
        "evaluation_split": "validation", "reserved_test_evaluated": False,
        "reserved_test_policy": "Constructed/exported only; never loaded by fitting, ranking or model selection.",
        "movielens_feedback_read": False, "paid_api_calls": False, "app_changed": False,
        "ratings": "Review-associated FilmAffinity scores only; reviewer and snapshot selection bias.",
        "units": "Inferred movie entries and high/medium heuristic whole-series candidates; episodes, seasons, uncertain units excluded.",
        "identity": "FilmAffinity IDs and normalized cast names; no verified IMDb/TMDB crosswalk, possible cast-name collisions.",
        "chronology": "Per-user review-day proxy, not verified original rating chronology or a global as-of cutoff; current metadata can postdate ratings.",
        "generalization": "Retrospective established-user cohort; new users, unseen-title cold start, groups, and LLM comparisons not evaluated.",
        "selection": "Equal movie/TV weighting targets balanced service; movie and TV cohorts differ and stay fixed across models.",
        "negative_ratings": "All ratings excluded from recommendations and used in train-only quality; personalized CF/content profiles use likes >=8 only.",
        "comparison": "Fresh FilmAffinity study; scores cannot be directly compared with MovieLens notebook/LLM scores.",
        "uncertainty": "Bootstrap intervals describe the same validation data used for selection; new test set remains reserved.",
    }
    summary_coverage = coverage.groupby("task", sort=True).agg(users=("user_id", "size"), positives=("positives", "sum"), available=("available", "sum"),
                                                               mean_available_fraction=("available_fraction", "mean"), mean_recall_ceiling_at_10=("recall_ceiling_at_10", "mean")).reset_index().to_dict("records")
    best_row = leaderboard.iloc[0].to_dict()
    selection = {"selected_variant": selected, "best_model": best_row,
                 "best_personalized_variant": personalized, "best_personalized_model": personalized_row.to_dict(),
                 "primary_metric": "balanced_recall_at_10", "validation_only": True}
    write_json(output / "selection.json", selection)
    files = {name: sha256_file(output / name) for name in ("study_plan.json", "split_manifest.json", "leaderboard.csv", "coverage.csv", "validation_per_user.csv",
                                                         "recommendation_examples.csv", "paired_validation_intervals.csv", "training_catalog.csv", "trained_model.joblib", "validation_comparison.png", "reload_inference_example.csv", "selection.json")}
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "experiment": "notebook17_filmaffinity_hybrid",
              "scope": scope, "split": split, "dataset": dataset, "coverage": summary_coverage,
              "best_model": best_row, "selected_variant": selected, "paired_intervals": intervals,
              "best_personalized_model": personalized_row.to_dict(), "best_personalized_variant": personalized,
              "reloaded_model_inference_verified": True, "provenance": provenance, "files": files,
              "runner_sha256": sha256_file(__file__),
              "versions": {name: importlib.metadata.version(name) for name in ("numpy", "pandas", "scipy", "scikit-learn", "pyarrow", "joblib")}}
    write_json(output / "experiment_report.json", report)
    return report


if __name__ == "__main__":
    report = run_experiment(Path(__file__).resolve().parents[1])
    print(json.dumps(report["best_model"], indent=2))
