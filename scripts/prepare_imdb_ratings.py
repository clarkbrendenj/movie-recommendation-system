"""Prepare exact-ID MovieLens matches from IMDb's official title.ratings TSV."""

import argparse
import csv
import json
import math
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.prepare_imdb_credits import file_sha256, read_tsv, stream_subset


def build_ratings_catalog(links, rating_rows):
    """Keep every linked movie; reject invalid observations rather than inventing ratings."""
    ratings = {}
    for row in rating_rows:
        imdb_id = row["tconst"]
        if imdb_id in ratings:
            raise ValueError(f"Duplicate IMDb rating: {imdb_id}")
        try:
            average = float(row["averageRating"])
            votes = int(row["numVotes"])
        except (TypeError, ValueError):
            average, votes = None, None
        if average is None or not math.isfinite(average) or not 1 <= average <= 10 or votes <= 0:
            average, votes = None, None
        ratings[imdb_id] = (average, votes)
    movies = []
    for row in links:
        imdb_id = "tt" + row["imdbId"].zfill(7) if row["imdbId"] else None
        average, votes = ratings.get(imdb_id, (None, None))
        movies.append({"movieId": int(row["movieId"]), "imdbId": imdb_id,
                       "averageRating": average, "numVotes": votes})
    if len({row["movieId"] for row in movies}) != len(movies):
        raise ValueError("MovieLens links contain duplicate movie IDs.")
    return {"movies": movies}


def prepare_ratings(project_root, force=False):
    root = Path(project_root).resolve()
    links_path = root / "data/raw/ml-latest-small/links.csv"
    output = root / "data/raw/imdb"
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "ratings_manifest.json"
    catalog_path = output / "movielens_ratings.json"
    subset_path = output / "title.ratings.tsv"
    links_hash = file_sha256(links_path)
    with links_path.open(encoding="utf-8", newline="") as stream:
        links = list(csv.DictReader(stream))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    source = manifest.get("source", {})
    if (force or manifest.get("links_sha256") != links_hash or not subset_path.is_file()
            or file_sha256(subset_path) != source.get("subset_sha256")):
        wanted = {"tt" + row["imdbId"].zfill(7) for row in links if row["imdbId"]}
        source = stream_subset("title.ratings", wanted, subset_path)
    else:
        print("Using verified subset: title.ratings", flush=True)
    catalog = build_ratings_catalog(links, read_tsv(subset_path))
    catalog_path.write_text(json.dumps(catalog, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    manifest = {"schema_version": 1, "links_sha256": links_hash, "source": source,
                "catalog_sha256": file_sha256(catalog_path), "catalog_movies": len(catalog["movies"]),
                "terms": "https://data.imdb.com/non-commercial-datasets/"}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(catalog['movies']):,} MovieLens rating records: {catalog_path}", flush=True)
    return catalog_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--force", action="store_true", help="Refresh the IMDb ratings snapshot.")
    args = parser.parse_args()
    prepare_ratings(args.project_root, force=args.force)
