"""Notebook 16: evidence-based audit of explicit whole-series ratings sources.

This audit does not train models, modify the app, or load benchmark feedback.
Run prepare_ratings_dataset_audit.py once; this analysis then works offline.
"""

import ast
from collections import Counter
from datetime import datetime, timezone
import importlib.metadata
import json
from pathlib import Path
import re
import sys
import tarfile
import unicodedata

import numpy as np
import pandas as pd

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.prepare_ratings_dataset_audit import CACHE_RELATIVE, sha256_file


ROOT = Path(__file__).resolve().parents[1]
UNITS = ("whole_series", "season", "episode", "movie", "uncertain")
SPANISH_MONTHS = {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5,
                  "junio": 6, "julio": 7, "agosto": 8, "septiembre": 9, "setiembre": 9,
                  "octubre": 10, "noviembre": 11, "diciembre": 12}


def _text(value):
    if value is None or (not isinstance(value, (list, dict)) and pd.isna(value)):
        return ""
    result = unicodedata.normalize("NFKD", str(value)).casefold()
    return "".join(char for char in result if not unicodedata.combining(char)).strip()


def _labels(value):
    if isinstance(value, list):
        return [_text(part) for part in value]
    if isinstance(value, str) and value.startswith("["):
        try:
            parsed = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            parsed = None
        if isinstance(parsed, list):
            return [_text(part) for part in parsed]
    return [_text(value)] if _text(value) else []


def classify_title(title, types, description):
    """Conservative unit inference, not a certified external-ID classification.

    Plural episode/season counts describe a series and must not turn it into an
    episode/season item. A generic MAL type 'TV' does not establish whole-series
    granularity. Season-specific titles override a generic series label.
    """
    title, description, labels = _text(title), _text(description), set(_labels(types))
    head = description[:300]
    tv_context = bool(labels & {"serie", "serie de tv", "series", "tvseries", "miniserie", "miniserie de tv", "miniseries", "episodio", "episode"}
                      or re.match(r"^(?:mini)?serie(?:s)?\s+(?:de\s+)?(?:tv|television)\b", head))
    if labels & {"episodio", "episode", "tvepisode"}:
        return {"unit": "episode", "confidence": "high", "evidence": "Explicit episode format label"}
    season_marker = (r"\b(?:temporada|season)\s*(?:\d{1,2}(?!\d)|[ivx]+)\b|"
                     r"\b(?:primera|segunda|tercera|cuarta|quinta|sexta|septima|octava|novena|decima|"
                     r"undecima|duodecima|ultima|first|second|third|fourth|fifth|sixth|seventh|eighth)\s+(?:temporada|season)\b|"
                     r"\b\d+(?:st|nd|rd|th|a|o|ª|º)\s+(?:temporada|season)\b")
    if tv_context and re.search(season_marker, title):
        return {"unit": "season", "confidence": "high", "evidence": "Explicit numbered/ordinal season in the catalog title"}
    if tv_context:
        unit_header = re.sub(r"^(?:mini)?serie(?:s)?(?:\s+(?:de\s+)?(?:tv|television))?(?:\s*\([^)]*\))?[\s.:;-]*", "", head)
        explicit_unit_header = bool(re.match(season_marker, unit_header) or re.match(season_marker, head))
        if explicit_unit_header:
            if (labels & {"miniserie", "miniserie de tv", "miniseries"}
                    or re.match(season_marker, head)
                    or re.search(r"temporada\s+de\s+la\s+serie", unit_header[:120])):
                return {"unit": "season", "confidence": "high", "evidence": "Synopsis asserts a season-specific unit at its opening"}
            return {"unit": "uncertain", "confidence": "low", "evidence": "Generic series entry with season-specific opening; unit needs human review"}
        if re.search(r"\b\d+\s+temporadas\b", head) or re.search(r"\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b", head):
            return {"unit": "whole_series", "confidence": "high", "evidence": "Series label/header plus full run or plural season count; still subject to manual audit"}
        if re.search(r"\bepisodios\s+de\s+la\s+temporada\b", head):
            return {"unit": "uncertain", "confidence": "low", "evidence": "Series entry lists one season's episodes; this does not certify its overall rating unit"}
        return {"unit": "whole_series", "confidence": "medium", "evidence": "Series/mini-series label or synopsis header, without explicit season/episode marker"}
    if labels & {"movie", "film", "pelicula", "largometraje", "feature film"}:
        return {"unit": "movie", "confidence": "high", "evidence": "Explicit movie format label"}
    return {"unit": "uncertain", "confidence": "low", "evidence": "Insufficient format evidence; no whole-series identity inferred"}


def _review_dates(reviews):
    def assemble(parts):
        part_index = next(iter(parts.values())).index
        values = pd.DataFrame({key: column.to_numpy(dtype=float, na_value=np.nan)
                               for key, column in parts.items()}, index=part_index)
        output = pd.Series(pd.NaT, index=part_index, dtype="datetime64[ns, UTC]")
        complete = values.notna().all(axis=1)
        if complete.any():
            output.loc[complete] = pd.to_datetime(values.loc[complete], errors="coerce", utc=True)
        return output
    dates = pd.Series(pd.NaT, index=reviews.index, dtype="datetime64[ns, UTC]")
    parts = {}
    for part in ["year", "month", "day"]:
        name = next((name for name in [f"author_review_date_{part}", f"author_review_{part}"] if name in reviews), None)
        if name:
            parts[part] = pd.to_numeric(reviews[name], errors="coerce")
    if len(parts) == 3:
        dates = assemble(parts)
    fallback = dates.isna()
    if fallback.any():
        raw = reviews.get("author_review_date", pd.Series(pd.NA, index=reviews.index)).astype("string").loc[fallback]
        parsed = pd.to_datetime(raw, errors="coerce", utc=True, format="mixed")
        # Convert Spanish publication dates explicitly instead of guessing locale.
        spanish = raw.str.casefold().str.extract(r"^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})$")
        spanish_parts = {"day": pd.to_numeric(spanish[0], errors="coerce"),
                         "month": spanish[1].map(SPANISH_MONTHS),
                         "year": pd.to_numeric(spanish[2], errors="coerce")}
        spanish_dates = assemble(spanish_parts)
        dates.loc[fallback] = spanish_dates.where(spanish_dates.notna(), parsed)
    return dates


def normalize_reviews(reviews):
    """Validate explicit scores, keep undated valid scores, and deduplicate safely."""
    required = {"film_id", "author_id", "author_rating"}
    if not required.issubset(reviews.columns):
        raise ValueError(f"Missing review columns: {sorted(required - set(reviews.columns))}")
    frame = reviews.copy()
    ids = frame[["film_id", "author_id"]].astype("string")
    missing = ids.isna().any(axis=1) | ids.apply(lambda column: column.str.strip().eq("")).any(axis=1)
    scores = pd.to_numeric(frame["author_rating"], errors="coerce")
    invalid_score = ~np.isfinite(scores) | scores.lt(1) | scores.gt(10) | scores.ne(np.floor(scores))
    dates = _review_dates(frame)
    good = ~missing & ~invalid_score
    clean = pd.DataFrame({"item_id": ids["film_id"].str.strip(), "user_id": ids["author_id"].str.strip(),
                          "rating": scores, "raw_rating": frame["author_rating"], "rated_at": dates}).loc[good].copy()
    quality = {"raw_rows": len(frame), "missing_identity_rows": int(missing.sum()),
               "invalid_rating_rows": int((~missing & invalid_score).sum()),
               "invalid_date_rows": int(dates.loc[good].isna().sum())}
    keys = ["user_id", "item_id"]
    quality["duplicate_pairs"] = int(clean.loc[clean.duplicated(keys, keep=False), keys].drop_duplicates().shape[0])
    quality["exact_duplicate_rows"] = int(clean.duplicated(keys + ["rating", "rated_at"]).sum())
    clean = clean.drop_duplicates(keys + ["rating", "rated_at"])
    latest = clean.groupby(keys)["rated_at"].transform("max")
    last = clean.loc[clean["rated_at"].eq(latest) | (clean["rated_at"].isna() & latest.isna())].copy()
    conflicts = last.groupby(keys)["rating"].transform("nunique") > 1
    quality["ambiguous_latest_pairs"] = int(last.loc[conflicts, keys].drop_duplicates().shape[0])
    clean = last.loc[~conflicts].drop_duplicates(keys).sort_values(keys).reset_index(drop=True)
    clean["rating"] = clean["rating"].astype(float)
    quality["rows_cleaned"] = len(clean)
    quality["clean_rows_with_date"] = int(clean["rated_at"].notna().sum())
    return clean, quality


def audit_rating_overlap(ratings, catalog):
    """Count actual joined ratings; unmatched/season/episode rows are not TV likes."""
    if catalog["item_id"].duplicated().any():
        raise ValueError("Catalog item IDs must be unique before the rating join.")
    joined = ratings.merge(catalog[["item_id", "unit"]], on="item_id", how="left", validate="many_to_one")
    series = joined.loc[joined["unit"].eq("whole_series")]
    movies = joined.loc[joined["unit"].eq("movie")]
    series_counts = series.groupby("user_id")["item_id"].nunique()
    movie_counts = movies.groupby("user_id")["item_id"].nunique()
    shared = set(series_counts.index) & set(movie_counts.index)
    return {"n_ratings": len(ratings), "n_users": ratings["user_id"].nunique(),
            "n_items": ratings["item_id"].nunique(), "n_whole_series_ratings": len(series),
            "n_whole_series_users": series["user_id"].nunique(), "n_whole_series_items": series["item_id"].nunique(),
            "n_movie_ratings": len(movies), "n_users_movies_and_series": len(shared),
            "n_users_whole_series_ge_5": int(series_counts.ge(5).sum()),
            "n_users_whole_series_ge_10": int(series_counts.ge(10).sum()),
            "n_users_both_ge_5": int(sum(series_counts[user] >= 5 and movie_counts[user] >= 5 for user in shared)),
            "n_orphan_ratings": int(joined["unit"].isna().sum()),
            "n_season_ratings": int(joined["unit"].eq("season").sum()),
            "n_episode_ratings": int(joined["unit"].eq("episode").sum()),
            "n_uncertain_ratings": int(joined["unit"].eq("uncertain").sum())}


def _read_manifest(root):
    path = Path(root) / CACHE_RELATIVE / "manifest.json"
    if not path.is_file():
        raise FileNotFoundError("Audit sources missing; run scripts/prepare_ratings_dataset_audit.py first.")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    for row in manifest["assets"]:
        if row["status"] == "ok":
            file = Path(row["local_path"])
            if not file.is_relative_to((Path(root) / CACHE_RELATIVE).resolve()) or sha256_file(file) != row["sha256"]:
                raise ValueError("An audit input is missing, altered, or outside its dedicated cache.")
    return manifest, path


def _asset(manifest, dataset, kind, suffix=None):
    matches = [row for row in manifest["assets"] if row["dataset"] == dataset and row["kind"] == kind
               and row["status"] == "ok" and (suffix is None or row["local_path"].endswith(suffix))]
    return Path(matches[0]["local_path"]) if matches else None


def _filmaffinity_catalog(information):
    rows = []
    for row in information.to_dict(orient="records"):
        title = row.get("film_original_title") or row.get("film_title") or ""
        result = classify_title(title, row.get("film_movie_types"), row.get("film_synospsis"))
        labels = _labels(row.get("film_movie_types"))
        movie_inferred = False
        # FilmAffinity leaves ordinary film format tags blank. Keep this inference
        # explicit; duration alone must not certify a whole-series rating unit.
        if (result["unit"] == "uncertain" and not labels and pd.notna(row.get("film_duration"))
                and 40 <= row["film_duration"] <= 300 and pd.notna(row.get("film_year"))):
            result = {"unit": "movie", "confidence": "medium", "evidence": "Untagged feature-length FilmAffinity entry; inferred movie, not externally verified"}
            movie_inferred = True
        rows.append({"item_id": str(row["film_id"]), "title": str(row.get("film_title") or ""),
                     "original_title": str(title), "year": row.get("film_year"),
                     "types": row.get("film_movie_types"), "synopsis": row.get("film_synospsis"),
                     "movie_inferred": movie_inferred, **result})
    catalog = pd.DataFrame(rows)
    if catalog["item_id"].duplicated().any():
        raise ValueError("FilmAffinity catalog has duplicate IDs; resolve before joining ratings.")
    return catalog


def _local_title_matches(root, catalog):
    """Propose exact title/year links to the local catalog, never claim an ID proof."""
    def title_key(value):
        text = re.sub(r"\s*\(\d{4}\)\s*$", "", _text(value))
        article = re.fullmatch(r"(.+),\s*(the|a|an)", text)
        if article:
            text = article[2] + " " + article[1]
        return re.sub(r"[^a-z0-9]+", "", text)
    index = {}
    local = []
    type_path = root / "data/raw/notebook15_tv_series/catalog.json"
    types = {}
    if type_path.is_file():
        old = json.loads(type_path.read_text(encoding="utf-8"))
        types = {int(row["movieId"]): row for row in old["movielens_types"]}
        local.extend({"title": row["title"], "year": row.get("year"), "imdbId": row["imdbId"],
                      "unit": "whole_series"} for row in old["series"])
    path = root / "data/raw/ml-latest-small/movies.csv"
    if path.is_file():
        for row in pd.read_csv(path).to_dict(orient="records"):
            year = re.search(r"\((\d{4})\)\s*$", row["title"])
            info = types.get(row["movieId"], {})
            if year and info.get("imdbId"):
                unit = ("whole_series" if info.get("titleType") in {"tvSeries", "tvMiniSeries"}
                        else "movie" if info.get("titleType") == "movie" else "uncertain")
                local.append({"title": row["title"], "year": int(year[1]), "imdbId": info["imdbId"], "unit": unit})
    for row in local:
        if row["year"] is not None and pd.notna(row["year"]):
            index.setdefault((title_key(row["title"]), int(row["year"]), row["unit"]), set()).add(row["imdbId"])
    rows = []
    for row in catalog.to_dict(orient="records"):
        matches = set()
        if pd.notna(row["year"]) and row["unit"] in {"movie", "whole_series"}:
            for title in [row["original_title"], row["title"]]:
                matches.update(index.get((title_key(title), int(row["year"]), row["unit"]), set()))
        rows.append({"item_id": row["item_id"], "title": row["title"], "unit": row["unit"],
                     "match_status": "proposed_unique" if len(matches) == 1 else "ambiguous" if matches else "unmatched",
                     "proposed_imdb_id": next(iter(matches)) if len(matches) == 1 else None,
                     "evidence": "Exact normalized title + start year + compatible unit against limited local catalog; manual review required"})
    return pd.DataFrame(rows)


def _audit_film(manifest, root):
    info_path, rating_path = _asset(manifest, "filmaffinity", "information"), _asset(manifest, "filmaffinity", "ratings")
    if info_path is None or rating_path is None:
        return {"dataset": "FilmAffinity", "scope": "documentation/access audit only", "access": "incomplete",
                "recommendation": "Cannot rank as verified until the two data tables are available"}, {}, {}, {}
    import pyarrow.parquet as pq
    info = pd.read_parquet(info_path)
    names = pq.read_schema(rating_path).names
    columns = [column for column in names if column in {
        "film_id", "author_id", "author_rating", "author_review_date", "author_review_date_day",
        "author_review_date_month", "author_review_date_year"}]
    raw = pd.read_parquet(rating_path, columns=columns)
    ratings, quality = normalize_reviews(raw)
    ratings["user_id"] = "fa:" + ratings["user_id"]
    catalog = _filmaffinity_catalog(info)
    metrics = audit_rating_overlap(ratings, catalog)
    joined = ratings.merge(catalog, on="item_id", how="left", validate="many_to_one")
    per_title = joined.groupby("item_id").agg(n_ratings=("rating", "size"), n_users=("user_id", "nunique"),
                                               mean_rating=("rating", "mean"), dated_ratings=("rated_at", "count"))
    title_summary = catalog.merge(per_title, on="item_id", how="left")
    title_summary[["n_ratings", "n_users", "dated_ratings"]] = title_summary[["n_ratings", "n_users", "dated_ratings"]].fillna(0).astype(int)
    unit_summary = joined.groupby(["unit", "confidence"], dropna=False).agg(
        ratings=("rating", "size"), users=("user_id", "nunique"), titles=("item_id", "nunique"),
        dated_ratings=("rated_at", "count")).reset_index()
    tv = joined.loc[joined["unit"] == "whole_series"]
    user_summary = joined.assign(is_series=joined["unit"].eq("whole_series").astype(int),
                                 is_movie=joined["unit"].eq("movie").astype(int)).groupby("user_id").agg(
        ratings=("rating", "size"), series_ratings=("is_series", "sum"), movie_ratings=("is_movie", "sum"),
        dated_ratings=("rated_at", "count"))
    dated = tv.loc[tv["rated_at"].notna()]
    dated_count = dated.groupby("user_id")["rated_at"].agg(["size", "nunique"])
    metrics["n_users_series_ge_5_with_distinct_review_dates"] = int(((dated_count["size"] >= 5) & (dated_count["nunique"] >= 2)).sum())
    metrics["n_high_confidence_series_ratings"] = int(tv["confidence"].eq("high").sum())
    metrics["n_movie_ratings_inferred"] = int(joined["movie_inferred"].fillna(False).sum())
    strict_movies = set(joined.loc[joined["unit"].eq("movie") & ~joined["movie_inferred"].fillna(False), "user_id"])
    metrics["n_users_movies_and_series_explicit_movie_label"] = len(strict_movies & set(tv["user_id"]))
    matches = _local_title_matches(root, catalog)
    match_tv = matches.loc[matches["unit"].eq("whole_series")]
    metrics["n_series_title_year_matches_to_local_catalog"] = int(match_tv["match_status"].eq("proposed_unique").sum())
    metrics["n_total_title_year_matches_to_local_catalog"] = int(matches["match_status"].eq("proposed_unique").sum())
    known_ids = ["film103430", "film103372", "film103496", "film100216", "film100483", "film100160"]
    examples = title_summary.loc[title_summary["item_id"].isin(known_ids)].copy()
    for unit in UNITS:
        choices = title_summary.loc[title_summary["unit"] == unit]
        if len(choices):
            examples = pd.concat([examples, choices.sample(min(8, len(choices)), random_state=160)])
    examples = examples.drop_duplicates("item_id")
    row = {"dataset": "FilmAffinity", "scope": "full published snapshot", "access": "retrieved and hash-verified",
           "catalog_rows": len(info), "raw_rating_rows": len(raw), **metrics,
           "rating_scale": "1--10 integer; only valid explicit scores retained",
           "time_field": "review publication date; rating-event timing unverified",
           "license_evidence": "Uploader-declared MIT in pinned card; upstream rights not independently certified",
           "external_ids": "FilmAffinity IDs; no published IMDb/TMDB crosswalk in these schemas",
           "recommendation": "Primary candidate if whole-series/shared-user coverage is nonzero; metadata classification and links require review"}
    details = {"metrics": metrics, "quality": quality,
               "rating_date_semantics": "Review publication dates are proxies, not proof of original/last-updated rating time.",
               "sample_bias": "Only published reviews with a score, not every FilmAffinity rating; reviewer selection and scraping coverage can bias preferences.",
               "unit_semantics": "Conservative metadata heuristics; high/medium confidence are rule evidence, not calibrated probabilities.",
               "movie_unit_semantics": "Ordinary untagged, feature-length entries are inferred movies; strict explicit-movie overlap is reported separately.",
               "source_schemas": {"information": {field.name: str(field.type) for field in pq.read_schema(info_path)},
                                  "ratings": {field.name: str(field.type) for field in pq.read_schema(rating_path)}},
               "missing_metadata": {column: int(info[column].isna().sum()) for column in info.columns},
               "date_range": {"min": str(ratings["rated_at"].min()), "max": str(ratings["rated_at"].max())}}
    exports = {"filmaffinity_catalog_units.csv": catalog, "filmaffinity_title_coverage.csv": title_summary,
               "filmaffinity_unit_counts.csv": unit_summary, "filmaffinity_user_coverage.csv": user_summary.reset_index(),
               "filmaffinity_local_title_links.csv": matches, "filmaffinity_classification_examples.csv": examples,
               "filmaffinity_clean_ratings.csv": ratings}
    return row, details, exports, {"catalog": catalog, "ratings": ratings, "title_summary": title_summary}


def _audit_mal(manifest):
    info_path = _asset(manifest, "mal2020", "information")
    rating_path = _asset(manifest, "mal2020", "ratings")
    if info_path is None or rating_path is None:
        return {"dataset": "MyAnimeList 2020", "scope": "documentation/access audit only", "access": "incomplete"}, {}, {}
    info, raw = pd.read_csv(info_path), pd.read_csv(rating_path)
    source = raw.rename(columns={"anime_id": "film_id", "user_id": "author_id", "rating": "author_rating"})
    ratings, quality = normalize_reviews(source)
    ratings["user_id"] = "mal2020:" + ratings["user_id"]
    rows = []
    for row in info.to_dict(orient="records"):
        tv = _text(row["Type"]) == "tv"
        unit = "movie" if _text(row["Type"]) == "movie" else "uncertain"
        rows.append({"item_id": str(row["MAL_ID"]), "title": row["Name"], "unit": unit,
                     "source_type": row["Type"], "tv_entry": tv,
                     "season_name_marker": bool(re.search(r"\b(?:season|\d+(?:st|nd|rd|th))\b", _text(row["Name"]))),
                     "evidence": "Anime-entry rating unit; TV is not a verified whole multi-season series" if tv else "Source anime format"})
    catalog = pd.DataFrame(rows)
    joined = ratings.merge(catalog, on="item_id", how="left", validate="many_to_one")
    metrics = {"observed_sample_ratings": len(ratings), "observed_sample_users": ratings["user_id"].nunique(),
               "observed_sample_items": ratings["item_id"].nunique(),
               "sample_ratings_on_tv_entries": int(joined["tv_entry"].fillna(False).sum()),
               "sample_ratings_on_movie_entries": int(joined["unit"].eq("movie").sum()),
               "catalog_tv_entries": int(catalog["tv_entry"].sum()),
               "catalog_explicit_season_name_markers": int(catalog["season_name_marker"].sum()),
               "catalog_movies": int(catalog["unit"].eq("movie").sum()),
               "orphan_sample_ratings": int(joined["unit"].isna().sum())}
    row = {"dataset": "MyAnimeList 2020", "scope": "full curator metadata plus first published rating sample; NOT full 57M ratings",
           "access": "metadata and sample retrieved", "catalog_rows": len(info), "raw_rating_rows": len(raw),
           "n_ratings": len(ratings), "n_users": ratings["user_id"].nunique(),
           "n_whole_series_ratings": None, "n_users_movies_and_series": None,
           "rating_scale": "1--10 integer; zero is unscored in list data",
           "time_field": "No rating-event date in published sample schema",
           "license_evidence": "No dataset license found in fetched curator files; requires clarification",
           "external_ids": "MAL anime IDs; IMDb/TMDB crosswalk not part of the sampled release",
           "recommendation": "Secondary anime benchmark; not a direct broad-TV whole-series dataset"}
    details = {"metrics": metrics, "quality": quality,
               "published_not_measured": {"complete_scored_ratings": 57_000_000, "users": 310_059,
                                          "anime_items": 16_872, "source": "pinned data/readme.md"},
               "limitations": ["The 500-row rating file is ordered/curator-selected, not a representative random sample.",
                               "TV entry IDs may identify seasons/sequels; do not relabel them as whole-series ratings.",
                               "No event timestamps: do not substitute anime air dates, season labels or user registration dates.",
                               "Anime-only domain and unverified license limit direct use for the requested broad movie/TV app."]}
    examples = catalog.loc[catalog["season_name_marker"]].head(20)
    return row, details, {"mal2020_catalog_units.csv": catalog, "mal2020_clean_sample_ratings.csv": ratings,
                          "mal2020_season_entry_examples.csv": examples}


def _audit_douban(manifest):
    sample = _asset(manifest, "douban10m", "sample_archive")
    access = [row for row in manifest["assets"] if row["dataset"] == "douban10m"]
    members = []
    if sample:
        # Inspect bounded members without extracting paths from an untrusted tar.
        with tarfile.open(sample, "r:gz") as archive:
            members = [{"name": row.name, "bytes": row.size} for row in archive.getmembers() if row.isfile()]
    row = {"dataset": "Douban MovieData-10M", "scope": "documentation and access audit; whole-series rating coverage unverified",
           "access": "sample archive available for further parsing" if sample else "public sample unavailable; full archive password-gated",
           "catalog_rows": None, "raw_rating_rows": None, "n_ratings": None, "n_users": None,
           "n_whole_series_ratings": None, "n_users_movies_and_series": None,
           "rating_scale": "Curator documents integer 1--5; rows not measured",
           "time_field": "Curator documents RATING_TIME; values not measured",
           "license_evidence": "Dataset docs: research only, attribution, no redistribution without permission; code MIT is separate",
           "external_ids": "Curator documents IMDB_ID; coverage not measured",
           "recommendation": "Unranked pending accessible data and whole-series unit verification"}
    details = {"published_not_measured": {"ratings": 4_169_420, "users": 600_384, "rated_items": 68_471},
               "access": [{key: asset.get(key) for key in ["kind", "url", "status", "error"]} for asset in access],
               "sample_members": members,
               "limitations": ["No measured TV rating count is available from documentation alone.",
                               "Crawler hardcodes type='movie'; this field cannot distinguish movies from series.",
                               "A gated full archive was not accessed or bypassed."]}
    return row, details, {}


def run_audit(root=ROOT):
    root = Path(root).resolve()
    manifest, source_path = _read_manifest(root)
    print("Auditing FilmAffinity's actual metadata and individual rating rows...", flush=True)
    fa, fa_details, fa_exports, _ = _audit_film(manifest, root)
    print("Auditing MyAnimeList metadata and the published small rating sample...", flush=True)
    mal, mal_details, mal_exports = _audit_mal(manifest)
    print("Auditing Douban access and documented schema...", flush=True)
    douban, douban_details, douban_exports = _audit_douban(manifest)
    summary = pd.DataFrame([fa, mal, douban])
    best = ("FilmAffinity" if fa.get("scope") == "full published snapshot"
            and fa.get("n_whole_series_ratings", 0) > 0 and fa.get("n_users_movies_and_series", 0) > 0 else None)
    decision = {
        "recommended_dataset": best,
        "decision_status": "best verified prototype candidate among retrieved inputs; conditional on manual unit/link/rights review" if best else "no source passed the observed whole-series plus shared-user gate",
        "reason": ("Actual individual ratings join to whole-series candidates and movie candidates from the same users; accessible title metadata and review dates support a reproducible prototype audit."
                   if best else "Do not choose a winner from advertised dataset totals or schemas without joined whole-series rating evidence."),
        "hard_gates": ["Actual explicit user/title/score rows retrieved", "Whole-series candidates distinguishable from seasons/episodes",
                       "Measured users with movie and whole-series feedback", "Public access and reproducible source identities"],
        "remaining_work": ["Review the exported title-unit examples and ambiguous cases; heuristic confidence is not a correctness guarantee.",
                           "Build and verify an IMDb/TMDB crosswalk; local exact-title/year matches are proposals only.",
                           "Review uploader/upstream usage conditions before moving data or derived assets into the shared app.",
                           "Treat review dates as proxies; establish an honest split/evaluation protocol before any model accuracy claim.",
                           "Audit reviewer-selection bias and sparse-user coverage before model training."],
    }
    output = root / "data/processed/notebook16_dataset_audit"
    output.mkdir(parents=True, exist_ok=True)
    access = pd.DataFrame([{key: row.get(key) for key in ["dataset", "kind", "status", "scope", "revision", "bytes", "url", "error"]}
                           for row in manifest["assets"]])
    exports = {"dataset_comparison.csv": summary, "source_access.csv": access,
               **fa_exports, **mal_exports, **douban_exports}
    for name, frame in exports.items():
        frame.to_csv(output / name, index=False)
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "audit": "notebook16_whole_series_ratings_sources",
              "app_changed": False, "models_trained": False, "test_feedback_read": False, "paid_api_calls": False,
              "sources_manifest_sha256": sha256_file(source_path), "script_sha256": sha256_file(Path(__file__)),
              "versions": {name: importlib.metadata.version(name) for name in ["pandas", "numpy", "pyarrow"]},
              "decision": decision, "datasets": {"filmaffinity": fa_details, "mal2020": mal_details, "douban10m": douban_details},
              "method": {"unit_rules": "Spanish/English explicit format labels and synopsis headers; explicit season/episode markers override broad labels; counts alone are not units.",
                         "duplicates": "Latest valid review date retained; conflicting scores tied at latest date (or all-undated ties) remove that pair, never resurrect an older score.",
                         "ratings": "Valid explicit scores only; unknown/unscored are not dislikes; users remain source-namespaced.",
                         "comparison": "Scope-aware structural suitability, no model-score leaderboard, no sample population extrapolation.",
                         "dates": "Dates are source field semantics, not invented viewing dates; FilmAffinity review dates are a proxy."},
              "files": {name: {"sha256": sha256_file(output / name), "rows": len(frame)} for name, frame in exports.items()}}
    (output / "audit_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return {"summary": summary, "decision": decision, "report": report, "output": output,
            "exports": exports, "access": access}


if __name__ == "__main__":
    result = run_audit()
    print(result["summary"].to_string(index=False))
    print(json.dumps(result["decision"], indent=2, ensure_ascii=False))
    print(f"Saved ratings-source audit to {result['output']}")
