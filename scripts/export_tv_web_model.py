"""Export the selected frozen FilmAffinity whole-series ranker for Afterglow.

The original MovieLens web model is never changed. FilmAffinity IDs have their
own explicit numeric namespace; no title-string or cross-source user mapping is
performed. This exports a fitted model and verifies validation parity, not a new
training run. Reserved test feedback and API credentials are never opened.
"""

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys
import unicodedata

import joblib
import numpy as np
import pandas as pd
from scipy import sparse
from threadpoolctl import threadpool_limits

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.export_web_model import read_features, write_features
from scripts.filmaffinity_experiment import component_scores, blend_scores, ranked_indices, ranking_metrics
from scripts.filmaffinity_ranking_policy import blended_tv_scores

ROOT = Path(__file__).resolve().parents[1]
ID_NAMESPACE = 1_000_000_000
GROUPS = ("cf", "synopsis", "genres", "cast")


def file_hash(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def require_hash(path, expected):
    if file_hash(path) != expected:
        raise ValueError(f"Fitted-model source changed: {Path(path).name}")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, payload):
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")


def app_id(source_id):
    if not isinstance(source_id, str) or not source_id.startswith("film") or not source_id[4:].isdigit():
        raise ValueError("Expected a FilmAffinity filmNNN source ID.")
    number = int(source_id[4:])
    if not 0 < number < 1_000_000_000:
        raise ValueError("FilmAffinity ID exceeds its application namespace.")
    return ID_NAMESPACE + number


def _genres(value):
    try:
        labels = ast.literal_eval(value) if isinstance(value, str) else value
    except (ValueError, SyntaxError):
        labels = []
    if not isinstance(labels, (list, tuple)):
        return []
    # Display labels only. The fitted Spanish genre features remain untouched.
    translations = {"accion": "Action", "aventuras": "Adventure", "animacion": "Animation", "comedia": "Comedy",
                    "crimen": "Crime", "documental": "Documentary", "drama": "Drama", "fantastico": "Fantasy",
                    "terror": "Horror", "musical": "Musical", "intriga": "Mystery", "romance": "Romance",
                    "ciencia ficcion": "Sci-Fi", "thriller": "Thriller", "belico": "War", "western": "Western"}
    result = []
    for raw in labels:
        normalized = unicodedata.normalize("NFKD", str(raw)).casefold()
        normalized = "".join(c for c in normalized if not unicodedata.combining(c)).strip()
        if normalized in translations and translations[normalized] not in result:
            result.append(translations[normalized])
    return result


def load_selected_model(root=ROOT):
    root = Path(root)
    previous = root / "data/processed/notebook19_filmaffinity"
    report_path = previous / "experiment_report.json"
    report = read_json(report_path)
    bundle_path = previous / "trained_rankers.joblib"
    require_hash(bundle_path, report["files"][bundle_path.name])
    for relative, digest in report["study_plan"]["input_sha256"].items():
        require_hash(root / relative, digest)
    bundle = joblib.load(bundle_path)
    chosen = bundle["selections"]["whole_series"]
    if chosen["family"] != "frozen" or chosen["alpha"] != .25:
        raise ValueError("This export requires the recorded frozen 25% personal TV winner.")
    model = bundle["models"]["frozen"]
    if model["like_threshold"] != 8 or model["top_k"] != 10:
        raise ValueError("The fitted TV rating/ranking contract changed.")
    return model, report, {"notebook19ReportSha256": file_hash(report_path), "fittedBundleSha256": file_hash(bundle_path)}


def build_metadata(model, report, sources, root=ROOT):
    catalog = model["catalog"]
    eligible = model["eligible_mask"]
    candidates = catalog.unit.eq("whole_series").to_numpy() & eligible
    items = []
    for index, record in enumerate(catalog.to_dict("records")):
        original = record.get("original_title")
        title = str(original).strip() if isinstance(original, str) and original.strip() else str(record["title"])
        year = record.get("year")
        items.append({"movieId": app_id(record["item_id"]), "sourceId": record["item_id"], "title": title,
                      "alternateTitle": str(record["title"]), "genres": _genres(record.get("film_genre")),
                      "year": int(year) if pd.notna(year) else None,
                      "popularity": int(model["popularity"][index]), "quality": float(model["quality"][index]),
                      "eligible": bool(eligible[index]), "candidate": bool(candidates[index]),
                      "mediaType": "series" if record["unit"] == "whole_series" else "movie", "source": "filmaffinity"})
    ids = [item["movieId"] for item in items]
    if len(set(ids)) != len(ids):
        raise ValueError("FilmAffinity application IDs must be unique.")
    movie_metadata = Path(root) / "web/public/model/metadata.json"
    if movie_metadata.exists():
        movie_ids = {item["movieId"] for item in read_json(movie_metadata)["movies"]}
        if movie_ids & set(ids):
            raise ValueError("MovieLens and FilmAffinity application namespaces overlap.")
    winner = report["selections"]["whole_series"]
    return {"version": 1, "modelkind": "whole_series", "model": "FilmAffinity whole-series hybrid (25% personal / 75% popularity)",
            "itemCount": len(items), "candidateCount": int(candidates.sum()), "items": items,
            "idNamespace": {"source": "filmaffinity", "offset": ID_NAMESPACE, "sourceIdFormat": "filmNNN"},
            "positiveThreshold": 4, "displayedLikeThreshold": 8,
            "weights": {"plot": .25, "metadata": .25, "quality": .1, "personal": .25}, "groups": [],
            "benchmark": {"dataset": "FilmAffinity", "recallAt10": float(winner["recall_at_10"]), "users": int(winner["users"]), "split": "validation"},
            "sources": {**sources, "exportScriptSha256": file_hash(__file__)},
            "limitations": ["Source units beyond the 12 confirmed season exclusions remain provisional.",
                            "Validation-selected model; live-user and TV-only-input quality are not separately established.",
                            "MovieLens movie IDs are not linked to FilmAffinity IDs; only recognized FilmAffinity ratings form this profile.",
                            "The published benchmark used shared movie/series histories in the FilmAffinity namespace.",
                            "Review-associated feedback and publication-date proxies limit historical evaluation."],
            "profilePolicy": "Binary likes >=8/10; every recognized eligible rated title excluded; no cross-source title or user matching",
            "candidatePolicy": "Eligible whole-series source entries only; movie context rows never recommended or browsed",
            "scorePolicy": "Frozen full-eligible-catalog CF/content scaling, additive hybrid, then TV-only personal/popularity scaling and convex 25/75 blend"}


def portable_profile(metadata, ratings):
    lookup = {row["movieId"]: index for index, row in enumerate(metadata["items"])}
    known = {}
    for row in ratings:
        item, value = row.get("movieId"), row.get("rating")
        if (type(item) is int and item in lookup and metadata["items"][lookup[item]]["eligible"]
                and not isinstance(value, bool) and isinstance(value, (int, float))
                and np.isfinite(value) and .5 <= value <= 5 and float(value) * 2 == int(float(value) * 2)):
            known[lookup[item]] = float(value)
    seen = np.array([not row["eligible"] for row in metadata["items"]], dtype=bool)
    seen[list(known)] = True
    liked = [index for index, value in known.items() if value >= 4]
    return known, seen, liked


def portable_scores_batch(metadata, features, profiles, seen):
    profiles = profiles.astype(np.float64)
    components = {}
    for name in GROUPS:
        matrix = features[name].astype(np.float64)
        scores = ((profiles @ matrix) @ matrix.T).toarray()
        scores[seen] = 0
        maximum = scores.max(axis=1, keepdims=True, initial=0)
        components[name] = np.divide(scores, maximum, out=np.zeros_like(scores), where=maximum > 0)
    personal = components["cf"] + metadata["weights"]["plot"] * components["synopsis"]
    personal += metadata["weights"]["metadata"] * (components["genres"] + components["cast"]) / 2
    personal += metadata["weights"]["quality"] * np.array([row["quality"] for row in metadata["items"]])
    counts = np.array([row["popularity"] for row in metadata["items"]], dtype=float)
    empty = np.asarray(profiles.sum(axis=1)).ravel() == 0
    personal[empty] = counts
    candidates = np.array([row["candidate"] for row in metadata["items"]])
    blocked = seen[:, candidates]
    signals = []
    for raw in (personal[:, candidates], np.broadcast_to(counts[candidates], (profiles.shape[0], int(candidates.sum())))):
        scores = raw.copy()
        scores[blocked] = 0
        maximum = scores.max(axis=1, keepdims=True, initial=0)
        signals.append(np.divide(scores, maximum, out=np.zeros_like(scores), where=maximum > 0))
    result = metadata["weights"]["personal"] * signals[0] + (1 - metadata["weights"]["personal"]) * signals[1]
    result[blocked] = -np.inf
    return result, np.flatnonzero(candidates)


def recommend(metadata, features, ratings, limit=10):
    _, seen, liked = portable_profile(metadata, ratings)
    profile = sparse.csr_matrix((np.ones(len(liked)), ([0] * len(liked), liked)), shape=(1, metadata["itemCount"]))
    values, columns = portable_scores_batch(metadata, features, profile, seen[None, :])
    ids = np.array([metadata["items"][col]["movieId"] for col in columns])
    counts = np.array([metadata["items"][col]["popularity"] for col in columns])
    order = ranked_indices(values[0], np.ones(len(columns), dtype=bool), counts, ids, k=limit)
    return [{"movieId": int(ids[index]), "score": float(values[0, index])} for index in order]


def verify_parity(metadata, features, model, report, root=ROOT):
    """Check all recorded TV-positive users against the fitted Python scorer."""
    previous = Path(root) / "data/processed/notebook18_filmaffinity"
    report18 = read_json(previous / "experiment_report.json")
    source = previous / "shelf_per_user.csv"
    require_hash(source, report18["files"][source.name])
    saved = pd.read_csv(source)
    saved = saved.loc[pd.to_numeric(saved.alpha, errors="coerce").eq(.25) & saved.tv_recall_at_10.notna()].set_index("user_id")
    index = {user: row for row, user in enumerate(model["user_ids"])}
    rows = [index[user] for user in saved.index]
    ids = np.array([row["movieId"] for row in metadata["items"]])
    candidates = np.array([row["candidate"] for row in metadata["items"]])
    target_columns = np.flatnonzero(candidates)
    counts = model["popularity"][target_columns]
    maximum_error, differing = 0., []
    for start in range(0, len(rows), 128):
        batch = rows[start:start + 128]
        profiles, seen = model["likes"][batch], model["seen"][batch].toarray().astype(bool)
        portable, actual_columns = portable_scores_batch(metadata, features, profiles, seen)
        np.testing.assert_array_equal(actual_columns, target_columns)
        original_components = component_scores(model, profiles, seen)
        empty = np.asarray(profiles.sum(axis=1)).ravel() == 0
        original_personal = blend_scores(model, original_components, model["best_personalized_variant"], seen, empty)
        for local, row in enumerate(batch):
            original = blended_tv_scores(original_personal[local, target_columns], counts, seen[local, target_columns], .25)
            available = np.isfinite(original)
            maximum_error = max(maximum_error, float(np.max(np.abs(original[available] - portable[local, available]), initial=0)))
            expected = ranked_indices(original, available, counts, ids[target_columns])
            actual = ranked_indices(portable[local], available, counts, ids[target_columns])
            if not np.array_equal(expected, actual):
                differing.append(model["user_ids"][row])
    if maximum_error > 2e-6 or differing:
        raise AssertionError(f"Portable TV parity failed: max score error={maximum_error}, differing top tens={differing[:8]}")
    return {"validationUsersCompared": len(rows), "allTop10Identical": True, "maxAbsoluteScoreDifference": maximum_error,
            "scope": "Portable arithmetic compared with fitted frozen scorer; no validation fitting or test feedback"}


def reference_cases(metadata, features, model):
    candidates = [item["movieId"] for item in metadata["items"] if item["candidate"]]
    source_lookup = {item["sourceId"]: item["movieId"] for item in metadata["items"]}
    cases = [{"name": "cold_start", "ratings": []},
             {"name": "unlinked_movielens_ratings", "ratings": [{"movieId": 296, "rating": 5}, {"movieId": 1, "rating": 4}]},
             {"name": "series_likes_and_low_rating", "ratings": [
                 {"movieId": source_lookup["film489970"], "rating": 4.5},
                 {"movieId": source_lookup["film399474"], "rating": 5},
                 {"movieId": candidates[0], "rating": 1}]},
             {"name": "lower_series_rating_only", "ratings": [{"movieId": candidates[0], "rating": 3.5}]},
             {"name": "excluded_season_input", "ratings": [{"movieId": source_lookup["film745751"], "rating": 5}]},
             {"name": "all_series_seen", "ratings": [{"movieId": item, "rating": 1} for item in candidates]}]
    # A fixed existing-user profile exercises learned movie/TV context features.
    ui = model["user_ids"].index("fa:1019144")
    liked = set(model["likes"][ui].indices)
    existing = [{"movieId": metadata["items"][col]["movieId"], "rating": 4 if col in liked else 1}
                for col in model["seen"][ui].indices if metadata["items"][col]["eligible"]]
    cases.append({"name": "recorded_filmaffinity_profile", "ratings": existing})
    for case in cases:
        case["scores"] = recommend(metadata, features, case["ratings"])
        case["top10"] = [item["movieId"] for item in case["scores"]]
    return {"version": 1, "cases": cases, "candidateIds": candidates}


def export_model(root=ROOT, directory=None, public_directory=None):
    root = Path(root).resolve()
    model, report, sources = load_selected_model(root)
    metadata = build_metadata(model, report, sources, root)
    destination = Path(directory) if directory else root / "data/tv_web_model"
    destination.mkdir(parents=True, exist_ok=True)
    features = {name: model["features"][name] for name in GROUPS}
    metadata["groups"] = write_features(destination, features)
    portable = read_features(destination, metadata)
    metadata["sparseBytes"] = sum(group[part]["bytes"] for group in metadata["groups"] for part in ("indptr", "indices", "data"))
    if metadata["sparseBytes"] > 40 * 1024 * 1024:
        raise ValueError("TV sparse features exceed their Worker memory allocation.")
    metadata["verification"] = verify_parity(metadata, portable, model, report, root)
    metadata["builtAtUtc"] = datetime.now(timezone.utc).isoformat()
    references = reference_cases(metadata, portable, model)
    write_json(destination / "reference.json", references)
    write_json(destination / "metadata.json", metadata)
    if public_directory is not False:
        public = Path(public_directory) if public_directory else root / "web/public/tv-model"
        public.mkdir(parents=True, exist_ok=True)
        for path in destination.iterdir():
            if path.is_file():
                shutil.copy2(path, public / path.name)
    return metadata, destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "data/tv_web_model")
    parser.add_argument("--public-output", type=Path, default=ROOT / "web/public/tv-model")
    args = parser.parse_args()
    with threadpool_limits(limits=2):
        result, location = export_model(ROOT, args.output, args.public_output)
    print(json.dumps({"directory": str(location), "items": result["itemCount"], "series": result["candidateCount"],
                      "sparseBytes": result["sparseBytes"], "verification": result["verification"]}, indent=2))
