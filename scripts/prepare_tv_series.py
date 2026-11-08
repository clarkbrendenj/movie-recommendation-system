"""Cache a bounded, exact-ID TV catalog for notebook 15; no API key is needed.

Only TVmaze show-index page zero is fetched. IMDb files are streamed rather than
stored in full; this includes the large title.principals download on the first run.
All outputs live separately from the existing MovieLens/IMDb caches.
"""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import ssl
import sys
import time
from urllib.error import HTTPError
import urllib.request

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.prepare_imdb_credits import file_sha256, read_tsv, stream_subset


ROOT = Path(__file__).resolve().parents[1]
TVMAZE_URL = "https://api.tvmaze.com/shows?page=0"
SERIES_TYPES = {"tvSeries", "tvMiniSeries"}
SHOW_TYPES = {"Scripted", "Animation", "Documentary"}
CAST_LIMIT = 5


class _SummaryParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.suppressed = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.suppressed += 1
        if tag in {"p", "br", "div", "li"}:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.suppressed = max(0, self.suppressed - 1)
        if tag in {"p", "div", "li"}:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.suppressed:
            self.parts.append(data)


def plain_summary(value):
    """Extract text without retaining HTML or script/style contents."""
    parser = _SummaryParser()
    parser.feed(value or "")
    parser.close()
    return " ".join("".join(parser.parts).split())


def _write_json(path, value):
    partial = path.with_suffix(path.suffix + ".partial")
    partial.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                       encoding="utf-8")
    partial.replace(path)


def _ids_hash(values):
    return hashlib.sha256("\n".join(sorted(set(values))).encode("utf-8")).hexdigest()


def _linked_imdb(value):
    value = str(value or "").strip()
    if not value:
        return None
    if not value.isdigit():
        raise ValueError(f"Invalid MovieLens IMDb ID: {value!r}")
    return "tt" + value.zfill(7)


def select_shows(rows):
    """Prespecify the catalog by source ID/language/type, never by ratings."""
    if not isinstance(rows, list) or len(rows) > 250:
        raise ValueError("TVmaze page zero must be a list of at most 250 shows.")
    selected, seen_ids, seen_imdb = [], set(), set()
    for row in sorted(rows, key=lambda entry: int(entry["id"])):
        show_id = int(row["id"])
        if not 0 <= show_id <= 250 or show_id in seen_ids:
            raise ValueError(f"Unexpected or duplicate TVmaze page-zero ID: {show_id}")
        seen_ids.add(show_id)
        imdb_id = (row.get("externals") or {}).get("imdb")
        if (row.get("language") != "English" or row.get("type") not in SHOW_TYPES
                or not isinstance(imdb_id, str) or not re.fullmatch(r"tt\d{7,}", imdb_id)):
            continue
        if imdb_id in seen_imdb:
            continue
        seen_imdb.add(imdb_id)
        selected.append(row)
    return selected


def build_catalog(links, shows, basic_rows, principal_rows, rating_rows):
    """Join solely on IMDb identifiers; unknown MovieLens types remain explicit."""
    basics = {}
    for row in basic_rows:
        if row["tconst"] in basics:
            raise ValueError(f"Duplicate IMDb title: {row['tconst']}")
        basics[row["tconst"]] = row
    cast = {}
    for row in principal_rows:
        if row["category"] in {"actor", "actress"} and re.fullmatch(r"nm\d{7,}", row["nconst"]):
            cast.setdefault(row["tconst"], []).append((int(row["ordering"]), row["nconst"]))
    ratings = {}
    for row in rating_rows:
        imdb_id = row["tconst"]
        if imdb_id in ratings:
            raise ValueError(f"Duplicate IMDb rating: {imdb_id}")
        try:
            average, votes = float(row["averageRating"]), int(row["numVotes"])
        except (ValueError, TypeError):
            average, votes = None, None
        if average is None or not math.isfinite(average) or not 1 <= average <= 10 or votes <= 0:
            average, votes = None, None
        ratings[imdb_id] = (average, votes)
    series = []
    for show in select_shows(shows):
        imdb_id = show["externals"]["imdb"]
        basic = basics.get(imdb_id, {})
        if basic.get("titleType") not in SERIES_TYPES:
            continue
        actors = list(dict.fromkeys(person for _, person in sorted(cast.get(imdb_id, []))))
        year = basic.get("startYear")
        average, votes = ratings.get(imdb_id, (None, None))
        series.append({
            "imdbId": imdb_id, "tvmazeId": int(show["id"]), "title": show["name"],
            "year": int(year) if year and year != "\\N" else None,
            "summary": plain_summary(show.get("summary")), "genres": show.get("genres") or [],
            "cast": actors[:CAST_LIMIT], "averageRating": average, "numVotes": votes,
            "titleType": basic["titleType"], "tvmazeUrl": show["url"],
        })
    movielens_types = []
    seen_movies = set()
    for link in links:
        movie_id, imdb_id = int(link["movieId"]), _linked_imdb(link.get("imdbId"))
        if movie_id in seen_movies:
            raise ValueError(f"Duplicate MovieLens movie ID: {movie_id}")
        seen_movies.add(movie_id)
        basic = basics.get(imdb_id, {})
        movielens_types.append({"movieId": movie_id, "imdbId": imdb_id,
                               "titleType": basic.get("titleType"),
                               "primaryTitle": basic.get("primaryTitle")})
    return {"series": series, "movielens_types": movielens_types}


def _download_tvmaze(path):
    try:
        import truststore
    except ImportError:
        context = ssl.create_default_context()
    else:
        context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    request = urllib.request.Request(TVMAZE_URL, headers={"User-Agent": "MovieLensTVResearch/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=45, context=context) as response:
                payload = response.read()
                rows = json.loads(payload.decode("utf-8"))
                select_shows(rows)
                info = {"url": TVMAZE_URL, "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
                        "last_modified": response.headers.get("Last-Modified"),
                        "etag": response.headers.get("ETag"), "records": len(rows)}
            partial = path.with_suffix(path.suffix + ".partial")
            partial.write_bytes(payload)
            partial.replace(path)
            info["subset_sha256"] = file_sha256(path)
            return rows, info
        except HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504} or attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError("TVmaze retries exhausted.")


def prepare_catalog(project_root=ROOT, force=False):
    """Download once, verify cached hashes thereafter, and return catalog.json."""
    root = Path(project_root).resolve()
    links_path = root / "data/raw/ml-latest-small/links.csv"
    output = root / "data/raw/notebook15_tv_series"
    output.mkdir(parents=True, exist_ok=True)
    manifest_path, catalog_path = output / "manifest.json", output / "catalog.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    with links_path.open(encoding="utf-8", newline="") as stream:
        links = list(csv.DictReader(stream))
    links_hash = file_sha256(links_path)
    sources = manifest.get("sources", {})
    tvmaze_path = output / "tvmaze_page_0.json"
    tvmaze_info = sources.get("tvmaze", {})
    if (force or tvmaze_info.get("url") != TVMAZE_URL or not tvmaze_path.is_file()
            or file_sha256(tvmaze_path) != tvmaze_info.get("subset_sha256")):
        print(f"Fetching bounded TVmaze index: {TVMAZE_URL}", flush=True)
        shows, sources["tvmaze"] = _download_tvmaze(tvmaze_path)
    else:
        print("Using verified TVmaze page zero.", flush=True)
        shows = json.loads(tvmaze_path.read_text(encoding="utf-8"))
    selected = select_shows(shows)
    wanted = {_linked_imdb(row.get("imdbId")) for row in links}
    wanted.discard(None)
    wanted.update(show["externals"]["imdb"] for show in selected)

    def checkpoint():
        manifest.update({"schema_version": 1, "links_sha256": links_hash, "sources": sources,
                         "selection_policy": {"tvmaze_pages": [0], "language": "English",
                                              "show_types": sorted(SHOW_TYPES),
                                              "imdb_title_types": sorted(SERIES_TYPES),
                                              "rating_filter": None, "cast_limit": CAST_LIMIT,
                                              "joins": "exact IMDb title/person IDs only"}})
        _write_json(manifest_path, manifest)

    def subset(dataset, wanted_ids):
        path, info = output / f"{dataset}.tsv", sources.get(dataset, {})
        wanted_hash = _ids_hash(wanted_ids)
        if (force or info.get("wanted_ids_sha256") != wanted_hash or not path.is_file()
                or file_sha256(path) != info.get("subset_sha256")):
            info = stream_subset(dataset, wanted_ids, path)
            info.update({"wanted_ids_sha256": wanted_hash, "wanted_ids_count": len(wanted_ids)})
            sources[dataset] = info
            checkpoint()
        else:
            print(f"Using verified TV subset: {dataset}", flush=True)
        return path

    checkpoint()
    basics_path = subset("title.basics", wanted)
    basic_rows = list(read_tsv(basics_path))
    series_ids = {row["tconst"] for row in basic_rows if row["titleType"] in SERIES_TYPES}
    # Retain classified MovieLens series too; their types and exact credits can be audited.
    principals_path = subset("title.principals", series_ids)
    ratings_path = subset("title.ratings", series_ids)
    catalog = build_catalog(links, shows, basic_rows, read_tsv(principals_path), read_tsv(ratings_path))
    if not catalog["series"]:
        raise ValueError("The bounded TVmaze page produced no confirmed IMDb series.")
    _write_json(catalog_path, catalog)
    manifest.update({"catalog_sha256": file_sha256(catalog_path),
                     "script_sha256": file_sha256(Path(__file__)),
                     "catalog_series": len(catalog["series"]),
                     "movielens_entries": len(catalog["movielens_types"]),
                     "selected_tvmaze_before_imdb_confirmation": len(selected),
                     "classified_series_ids": len(series_ids),
                     "terms": {"tvmaze": "https://www.tvmaze.com/api#licensing",
                               "imdb": "https://data.imdb.com/non-commercial-datasets/"},
                     "attribution": ["TVmaze metadata, CC BY-SA: https://www.tvmaze.com/",
                                     "Information courtesy of IMDb (https://www.imdb.com). Used with permission."],
                     "test_feedback_read": False})
    checkpoint()
    print(f"Prepared {len(catalog['series'])} TV series; classified {len(links)} MovieLens entries.", flush=True)
    print(f"Catalog: {catalog_path}", flush=True)
    return catalog_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    parser.add_argument("--force", action="store_true", help="Refresh the bounded source snapshots.")
    args = parser.parse_args()
    prepare_catalog(args.project_root, force=args.force)
