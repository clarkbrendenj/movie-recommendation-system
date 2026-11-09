"""Training-only source-unit spot-check and confirmed notebook-18 exclusions.

Annotations are manual readings of the frozen FilmAffinity source metadata, not
external verification, population accuracy estimates, or feedback-driven edits.
The original notebook-16/17 labels and recommendation results are never changed.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path("data/processed/notebook18_filmaffinity")
REVIEWED_CATALOG_SHA256 = "e9c50d7b82311be639b5fae2f90fbf7bbc1e97b8f73644b62055df95948c884b"
REVIEWED_MARKER_IDS_SHA256 = "eb3432a8dbbec11030a69112a5398c7020bf954075c86c1741d3740df20b2d16"
LIKE_THRESHOLD = 8
SEED = 42

CLAUSE_PATTERN = re.compile(
    r"(?:temporad.{0,200}(?:vot|independ|separad)|(?:vot|independ|separad).{0,200}temporad|temporadas posteriores)", re.I)
SEASON_PATTERN = re.compile(
    r"\b(?:temporada\s*(?:[0-9]+|[ivx]+)\b|(?:primera?|segunda|tercera|cuarta|quinta|sexta|s[eé]ptima|octava|novena|d[eé]cima)\s+temporada|\d+[ªº]\s+temporada|(?:volumen|vol\.?)\s*\d+|season\s*\d+)", re.I)

# Fixed after inspecting the prespecified training-only sample, before any
# notebook-18 validation scoring. Excerpts must match the frozen source exactly.
SAMPLE_REVIEWS = {
    "film489970": ("source_supports_whole_series", "Header explicitly describes the full five-season, 62-episode run.",
                   "Serie de TV (2008-2013). 5 temporadas. 62 episodios."),
    "film372160": ("source_supports_whole_series", "Open-ended series header spans 36 seasons rather than naming a particular season.",
                   "Serie de TV (1989-). 36 temporadas."),
    "film370639": ("source_supports_whole_series", "Header explicitly describes the six-season run and total episode count.",
                   "Serie de TV (2004-2010). 6 temporadas. 121 episodios."),
    "film392777": ("source_supports_whole_series", "The source groups three seasons and 18 episodes under this title.",
                   "3 temporadas. 18 episodios."),
    "film667520": ("source_supports_whole_series", "The seven-season run is identified explicitly in the source header.",
                   "Serie de TV (1993-2000). 7 temporadas. 158 episodios."),
    "film231065": ("source_supports_whole_series", "Multiyear series header; no particular-season or independent-season-voting qualification appears.",
                   "Serie de TV (2022-2024)."),
    "film640188": ("source_supports_whole_series", "The miniseries header and complete numbered episode list support a single ten-episode miniseries unit.",
                   "Miniserie de TV. 10 episodios."),
    "film624827": ("source_supports_whole_series", "The source identifies a five-episode miniseries rather than an episode or numbered season.",
                   "Miniserie de TV (2019). 5 episodios."),
    "film745751": ("source_indicates_season_or_episode", "The eight-episode 2016 entry explicitly sends later seasons to independently voted title pages; this is a first-season-scoped rating unit.",
                   "Las Temporadas posteriores (2 en adelante) pueden votarse independientemente en sus fichas correspondientes."),
    "film662558": ("ambiguous_source_unit", "The miniseries label is consistent with a whole work, but no episode total or explicit run scope is supplied; leave the unit unconfirmed.",
                   "Miniserie sobre la controvertida reina de Escocia"),
    "film711307": ("ambiguous_source_unit", "A single-year series header and 20 episodes do not establish whether the rating unit covers a complete series or one season.",
                   "Serie de TV (2019). 20 episodios."),
    "film203041": ("ambiguous_source_unit", "The six-episode series header lacks explicit full-run or season scope; source-only review cannot confirm the complete unit.",
                   "Serie de TV. 6 episodios."),
}

# Full-catalog manual review of explicit season/voting markers. An anthology
# season remains a season even when the source also calls it a miniseries.
CONFIRMED_EXCLUSIONS = {
    "film151087": ("The source directly identifies this entry as Stranger Things' second season.",
                   "La segunda temporada de 'Stranger Things'"),
    "film196789": ("The source directly identifies Asylum as American Horror Story's second season.",
                   'Segunda temporada de la serie "American Horror Story"'),
    "film410609": ("The named entry is explicitly the third season of 13 Reasons Why, not its complete series.",
                   'Tercera temporada de "Por 13 razones"'),
    "film442387": ("The source explicitly identifies this Feud entry as season two.",
                   'Segunda temporada de la serie de antología de Ryan Murphy "Feud".'),
    "film468690": ("Homecoming 2 is described as the second-season story continuing the first-season revelations.",
                   "La segunda temporada es una historia totalmente nueva"),
    "film528128": ("Volume 2 is explicitly the second season of the parent anthology series.",
                   "Temporada 2 de la serie antológica de cortos"),
    "film539332": ("Good Omens 2 is explicitly the second season of the 2019 miniseries.",
                   "Segunda temporada de la miniserie ‘Good Omens’ (2019)."),
    "film662961": ("The 26-episode Phantom Blood/Battle Tendency entry explicitly covers the first season, not every season of JoJo's Bizarre Adventure.",
                   'La primera temporada abarca dos arcos argumentales diferentes "Phantom Blood" y "Battle Tendency"'),
    "film664726": ("The three-episode Time entry is separate from the second season, which the source says has its own title page.",
                   "Time tiene una segunda temporada 2T con trama, localización (es otra prisión) y protagonistas diferentes, con ficha propia."),
    "film710523": ("True Detective II is explicitly the second season of the HBO series.",
                   "Segunda temporada de la popular serie de la HBO"),
    "film716612": ("Fargo V is explicitly the fifth season of Fargo.",
                   "Quinta temporada de 'Fargo'."),
    "film745751": (SAMPLE_REVIEWS["film745751"][1], SAMPLE_REVIEWS["film745751"][2]),
}

AMBIGUOUS_MARKERS = {
    "film189701": "Cruel Summer describes a later anthology season without establishing separate rating-page scope.",
    "film552344": "An eight-episode Nine Perfect Strangers description also announces season two; incomplete metadata alone does not prove a season-specific rating page.",
    "film566155": "The End of the F***ing World retains an eight-episode initial description while mentioning season two; possible stale metadata, not definitive independent voting evidence.",
    "film647552": "Goosebumps describes one season and a subsequent new-cast season; the source does not explicitly establish separate voting scope.",
    "film668719": "Jujutsu Kaisen retains an initial 24-episode description while announcing later seasons; source completeness and rating-page scope remain uncertain.",
    "film696022": "Memorias de Idhun has inconsistent one-season/two-season wording; no confirmed separate-rating unit can be inferred.",
    "film714201": "Beef mentions a future second anthology season without explicit separate title-page voting; do not automatically exclude it.",
    "film737757": "The X-Files entry describes a 2016-2018 revival; whether this is a separate complete revival work or a subset of the original series requires an identity policy or external verification.",
    "film753827": "El marginal 2 is a numbered prequel entry referring to a first season, but the source does not explicitly identify it as a second-season voting unit.",
}


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _write_json(path, value):
    partial = path.with_suffix(path.suffix + ".partial")
    partial.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    partial.replace(path)


def _text(value):
    return " ".join(str(value).split())


def _check_excerpt(row, excerpt):
    if _text(excerpt) not in _text(row["synopsis"]):
        raise ValueError(f"Reviewed evidence no longer matches the frozen source: {row['item_id']}")


def run_spotcheck(root: Path = ROOT) -> dict:
    """Export the fixed sample plus a metadata-only universal exclusion list."""
    root = Path(root).resolve()
    old = root / "data/processed/notebook17_filmaffinity"
    report_path = old / "experiment_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    catalog_path, train_path = old / "training_catalog.csv", old / "train.csv"
    catalog_hash, train_hash = sha256_file(catalog_path), sha256_file(train_path)
    if catalog_hash != report["files"]["training_catalog.csv"] or catalog_hash != REVIEWED_CATALOG_SHA256:
        raise ValueError("Training catalog differs from the source snapshot reviewed for this audit.")
    if train_hash != report["split"]["files"]["train.csv"]:
        raise ValueError("Training ratings differ from notebook 17's frozen split.")
    catalog = pd.read_csv(catalog_path)
    train = pd.read_csv(train_path, usecols=["item_id", "rating"])
    likes = train.loc[train.rating >= LIKE_THRESHOLD].groupby("item_id").size()
    series = catalog.loc[catalog.unit.eq("whole_series") & catalog.confidence.isin(["high", "medium"])].copy()
    series["train_likes"] = series.item_id.map(likes).fillna(0).astype(int)
    samples, strata = [], []
    for confidence in ("high", "medium"):
        group = series.loc[series.confidence.eq(confidence)].sort_values(
            ["train_likes", "item_id"], ascending=[False, True], kind="stable")
        if len(group) < 6:
            raise ValueError(f"Not enough {confidence}-confidence entries for the prespecified sample.")
        top = group.head(3).copy()
        top["sampling_stratum"] = "top_training_likes"
        remaining = group.loc[~group.item_id.isin(top.item_id)].copy()
        cutoff = float(remaining.train_likes.median())
        low = remaining.loc[remaining.train_likes <= cutoff].copy()
        low["seed_hash"] = low.item_id.map(
            lambda item: hashlib.sha256(f"{SEED}|{confidence}|{item}".encode("utf-8")).hexdigest())
        low = low.sort_values(["seed_hash", "item_id"], kind="stable").head(3).copy()
        if len(low) != 3:
            raise ValueError("Low-support stratum has fewer than three candidates.")
        low["sampling_stratum"] = "low_support_seed42"
        samples.extend([top, low])
        strata.append({"confidence": confidence, "catalog_entries": int(len(group)),
                       "low_support_train_like_cutoff": cutoff, "top_sample": 3, "low_support_sample": 3})
    sample = pd.concat(samples, ignore_index=True)
    if set(sample.item_id) != set(SAMPLE_REVIEWS):
        raise ValueError("The deterministic sample differs from the twelve manually reviewed entries.")
    sample_rows = []
    for row in sample.to_dict("records"):
        assessment, note, excerpt = SAMPLE_REVIEWS[row["item_id"]]
        _check_excerpt(row, excerpt)
        sample_rows.append({key: row[key] for key in
                            ("item_id", "title", "original_title", "confidence", "train_likes", "sampling_stratum")})
        sample_rows[-1].update({"assessment": assessment, "review_note": note, "evidence_excerpt": excerpt})

    flagged = []
    for row in series.sort_values("item_id").to_dict("records"):
        synopsis = _text(row["synopsis"])
        combined = f"{row['title']} {row['original_title']} {synopsis}"
        clause, season = CLAUSE_PATTERN.search(synopsis), SEASON_PATTERN.search(combined)
        if not clause and not season:
            continue
        if row["item_id"] in CONFIRMED_EXCLUSIONS:
            reason, excerpt = CONFIRMED_EXCLUSIONS[row["item_id"]]
            _check_excerpt(row, excerpt)
            assessment = "confirmed_season_scoped_unit"
        elif row["item_id"] in AMBIGUOUS_MARKERS:
            assessment, reason = "ambiguous_scope_retained", AMBIGUOUS_MARKERS[row["item_id"]]
            excerpt = synopsis[:220]
        else:
            assessment = "no_confirmed_scope_error_retained"
            reason = ("Reviewed source context concerns renewal, cancellation, plot, or a whole-run season discussion; "
                      "it does not establish season-specific voting. This is not independent whole-series verification.")
            excerpt = synopsis[:220]
        flagged.append({"item_id": row["item_id"], "title": row["title"], "original_title": row["original_title"],
                        "confidence": row["confidence"], "train_likes": row["train_likes"],
                        "assessment": assessment, "reason": reason, "evidence_excerpt": excerpt})
    marker_hash = hashlib.sha256("\n".join(sorted(row["item_id"] for row in flagged)).encode("utf-8")).hexdigest()
    if marker_hash != REVIEWED_MARKER_IDS_SHA256:
        raise ValueError("Explicit-marker candidate set differs from the 204 source entries manually reviewed.")
    exclusions = [row for row in flagged if row["assessment"] == "confirmed_season_scoped_unit"]
    if set(row["item_id"] for row in exclusions) != set(CONFIRMED_EXCLUSIONS):
        raise ValueError("Confirmed source-unit exclusion list changed unexpectedly.")
    output = root / OUTPUT
    output.mkdir(parents=True, exist_ok=True)
    sample_path, exclusion_path = output / "unit_spotcheck.csv", output / "confirmed_unit_exclusions.csv"
    pd.DataFrame(sample_rows).to_csv(sample_path, index=False)
    pd.DataFrame(exclusions).to_csv(exclusion_path, index=False)
    assessments = pd.DataFrame(sample_rows)
    payload = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "scope": {"metadata_and_training_only": True, "validation_feedback_read": False,
                  "reserved_test_read": False, "movielens_feedback_read": False, "paid_api_calls": False,
                  "external_sources_consulted": False, "original_catalog_modified": False,
                  "interpretation": "Source-only manual annotations; not external proof, calibrated confidence, or a population accuracy estimate.",
                  "application": "Use confirmed IDs uniformly as notebook-18 exclusions; never selectively remove entries by recommendation performance."},
        "sample_design": {"seed": SEED, "sample_size": len(sample_rows), "strata": strata,
                          "rule": "Within high/medium confidence: three largest training-like counts (item ID ties), then three smallest SHA256(42|confidence|item_id) in the remaining at-or-below-median training-like pool.",
                          "selection_before_source_reading": True},
        "sample_rows": sample_rows,
        "counts": {str(key): int(value) for key, value in assessments.assessment.value_counts().items()},
        "assessments": [{key: row[key] for key in ("item_id", "assessment", "review_note")} for row in sample_rows],
        "full_catalog_marker_review": {"training_whole_series_candidates": int(len(series)),
                                       "flagged_entries_reviewed": len(flagged), "flagged_item_ids_sha256": marker_hash,
                                       "clause_pattern": CLAUSE_PATTERN.pattern, "season_pattern": SEASON_PATTERN.pattern,
                                       "reviewed_entries": flagged,
                                       "not_exhaustive": "Marker search can miss implicit or differently worded scope errors; unflagged entries are not verified."},
        "hard_source_error": bool(exclusions), "excluded_item_ids": sorted(CONFIRMED_EXCLUSIONS),
        "exclusion_reasons": exclusions,
        "input_sha256": {"experiment_report.json": sha256_file(report_path),
                         "training_catalog.csv": catalog_hash, "train.csv": train_hash},
        "runner_sha256": sha256_file(Path(__file__)),
        "source_revision": report["provenance"]["source_revision"],
        "files": {sample_path.name: sha256_file(sample_path), exclusion_path.name: sha256_file(exclusion_path)},
    }
    report_path = output / "unit_spotcheck.json"
    _write_json(report_path, payload)
    print(f"Source spot-check: {len(sample_rows)} fixed entries; {payload['counts']}", flush=True)
    print(f"Reviewed {len(flagged)} explicit-marker hits across {len(series)} training series candidates; confirmed {len(exclusions)} season-scoped units.", flush=True)
    return {**payload, "output_files_sha256": {**payload["files"], report_path.name: sha256_file(report_path)}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    args = parser.parse_args()
    result = run_spotcheck(args.project_root)
    print(json.dumps({"counts": result["counts"], "excluded_item_ids": result["excluded_item_ids"]}, indent=2))
