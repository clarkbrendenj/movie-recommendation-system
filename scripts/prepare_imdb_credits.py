r"""Stream official IMDb TSVs and retain credits for this MovieLens catalog only.

Usage: .venv\Scripts\python.exe scripts/prepare_imdb_credits.py
IMDb data is subject to https://data.imdb.com/non-commercial-datasets/.
"""

import argparse
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import ssl
import urllib.request


SOURCE_BASE = "https://datasets.imdbws.com/"
CAST_LIMIT = 5


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def split_ids(value):
    return sorted(set(value.split(","))) if value and value != "\\N" else []


class HashingReader:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.bytes_read = 0

    def read(self, size=-1):
        block = self.stream.read(size)
        self.digest.update(block)
        self.bytes_read += len(block)
        return block


def stream_subset(dataset, wanted_ids, destination):
    """Download/decompress incrementally; keep only matching first-column IDs.

    The full compressed stream is hashed, but never stored or fully expanded.
    Write via a temporary file so interrupted downloads are not accepted.
    """
    try:
        import truststore
    except ImportError:
        context = ssl.create_default_context()
    else:
        context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    url = SOURCE_BASE + dataset + ".tsv.gz"
    request = urllib.request.Request(url, headers={"User-Agent": "MovieLensCreditsResearch/1.0"})
    destination = Path(destination)
    partial = destination.with_suffix(destination.suffix + ".partial")
    wanted = {value.encode("utf-8") for value in wanted_ids}
    print(f"Streaming {url}", flush=True)
    kept = total = 0
    with urllib.request.urlopen(request, context=context, timeout=120) as response:
        hashed = HashingReader(response)
        with gzip.GzipFile(fileobj=hashed) as archive, partial.open("wb") as output:
            header = archive.readline()
            if b"\t" not in header:
                raise ValueError(f"Unexpected TSV header in {url}")
            output.write(header)
            for line in archive:
                total += 1
                if line.partition(b"\t")[0] in wanted:
                    output.write(line)
                    kept += 1
                if total % 5_000_000 == 0:
                    print(f"{dataset}: scanned {total:,} rows; kept {kept:,}", flush=True)
        # Include trailing bytes, if any, in the compressed-source checksum.
        while hashed.read(1024 * 1024):
            pass
        info = {
            "url": url,
            "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
            "last_modified": response.headers.get("Last-Modified"),
            "etag": response.headers.get("ETag"),
            "compressed_sha256": hashed.digest.hexdigest(),
            "compressed_bytes": hashed.bytes_read,
            "source_rows": total,
            "retained_rows": kept,
        }
    partial.replace(destination)
    info["subset_sha256"] = file_sha256(destination)
    print(f"{dataset}: retained {kept:,} rows", flush=True)
    return info


def read_tsv(path):
    with Path(path).open(encoding="utf-8", newline="") as stream:
        yield from csv.DictReader(stream, delimiter="\t", quoting=csv.QUOTE_NONE)


def build_catalog(links, crew_rows, principal_rows, name_rows):
    """Resolve exact external IDs; principal order is a cast-selection proxy."""
    crews = {row["tconst"]: row for row in crew_rows}
    cast = {}
    for row in principal_rows:
        if row["category"] in {"actor", "actress"} and row["nconst"] != "\\N":
            cast.setdefault(row["tconst"], []).append((int(row["ordering"]), row["nconst"]))
    names = {row["nconst"]: row["primaryName"] for row in name_rows}
    catalog = []
    for row in links:
        imdb_id = "tt" + row["imdbId"].zfill(7) if row["imdbId"] else None
        crew = crews.get(imdb_id, {})
        actors = list(dict.fromkeys(person for _, person in sorted(cast.get(imdb_id, []))))
        entry = {
            "movieId": int(row["movieId"]),
            "imdbId": imdb_id,
            "directors": split_ids(crew.get("directors", "")),
            "writers": split_ids(crew.get("writers", "")),
            "cast": actors[:CAST_LIMIT],
        }
        catalog.append(entry)
    return {"movies": catalog, "person_names": names}


def prepare_credits(project_root, force=False):
    root = Path(project_root).resolve()
    links_path = root / "data/raw/ml-latest-small/links.csv"
    output = root / "data/raw/imdb"
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "credits_manifest.json"
    catalog_path = output / "movielens_credits.json"
    links_hash = file_sha256(links_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    sources = manifest.get("sources", {}) if manifest.get("links_sha256") == links_hash else {}
    with links_path.open(encoding="utf-8", newline="") as stream:
        links = list(csv.DictReader(stream))
    wanted_titles = {"tt" + row["imdbId"].zfill(7) for row in links if row["imdbId"]}
    for dataset in ("title.crew", "title.principals", "name.basics"):
        if dataset == "name.basics":
            people = set()
            for row in read_tsv(output / "title.crew.tsv"):
                people.update(split_ids(row["directors"]))
                people.update(split_ids(row["writers"]))
            for row in read_tsv(output / "title.principals.tsv"):
                if row["category"] in {"actor", "actress"}:
                    people.add(row["nconst"])
            wanted_ids = people
        else:
            wanted_ids = wanted_titles
        path = output / f"{dataset}.tsv"
        info = sources.get(dataset)
        if force or not info or not path.exists() or file_sha256(path) != info["subset_sha256"]:
            sources[dataset] = stream_subset(dataset, wanted_ids, path)
            manifest = {"links_sha256": links_hash, "sources": sources}
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        else:
            print(f"Using verified subset: {dataset}", flush=True)
    catalog = build_catalog(
        links, read_tsv(output / "title.crew.tsv"),
        read_tsv(output / "title.principals.tsv"), read_tsv(output / "name.basics.tsv"),
    )
    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    manifest.update({
        "schema_version": 1,
        "cast_limit": CAST_LIMIT,
        "cast_policy": "first five distinct actor/actress principal credits by ordering; not verified leads",
        "writer_policy": "all IMDb title.crew writer IDs; writing roles not distinguished",
        "terms": "https://data.imdb.com/non-commercial-datasets/",
        "catalog_sha256": file_sha256(catalog_path),
        "catalog_movies": len(catalog["movies"]),
    })
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(catalog['movies']):,} MovieLens credit records: {catalog_path}", flush=True)
    return catalog_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--force", action="store_true", help="Refresh the complete IMDb snapshot.")
    args = parser.parse_args()
    prepare_credits(args.project_root, force=args.force)
