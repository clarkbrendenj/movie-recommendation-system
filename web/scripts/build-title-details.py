"""Read exact local catalog identities and credits; emit display-only JSON to stdout."""
import ast
import argparse
import json
import sys
import unicodedata
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]


def read_json(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def names(value):
    if isinstance(value, str):
        try:
            value = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return []
    placeholders = {"animacion", "animation", "documental", "documentary", "reparto", "sin reparto", "unknown", "n/a", "no disponible", "no cast", "sin especificar", "varios", "varios directores"}
    def valid(name):
        canonical = "".join(char for char in unicodedata.normalize("NFKD", name) if not unicodedata.combining(char)).casefold()
        return canonical not in placeholders
    return list(dict.fromkeys(name.strip() for name in value if isinstance(name, str) and name.strip() and valid(name.strip()))) if isinstance(value, list) else []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    movie_catalog = read_json("web/public/model/metadata.json")["movies"]
    excluded = {item["movieId"] for item in read_json("web/public/catalog/movie-unit-exclusions.json")["excludedItems"]}
    credits = read_json("data/raw/imdb/movielens_credits.json")
    movie_credits = {item["movieId"]: item for item in credits["movies"]}
    person_names = credits["person_names"]
    items = {}
    titles = {}
    for movie in movie_catalog:
        movie_id = movie["movieId"]
        if movie_id in excluded:
            continue
        credit = movie_credits.get(movie_id, {})
        details = {"year": movie["year"], "cast": list(dict.fromkeys(person_names[p] for p in credit.get("cast", []) if p in person_names)),
                   "directors": list(dict.fromkeys(person_names[p] for p in credit.get("directors", []) if p in person_names))}
        if credit.get("imdbId"):
            details["metadataSource"] = {"name": "IMDb", "url": f"https://www.imdb.com/title/{credit['imdbId']}/fullcredits/"}
        items[str(movie_id)] = details
        titles[str(movie_id)] = movie["title"]
    info = pd.read_parquet(ROOT / "data/raw/notebook16_dataset_audit/filmaffinity/film_info.parquet",
                           columns=["film_id", "film_cast", "film_director"]).set_index("film_id")
    candidates = [item for item in read_json("web/public/tv-model/metadata.json")["items"] if item["candidate"] and item["eligible"]]
    for item in candidates:
        source_id = item["sourceId"]
        row = info.loc[source_id]
        source = {"name": "FilmAffinity", "url": f"https://www.filmaffinity.com/en/{source_id}.html"}
        items[str(item["movieId"])] = {"year": item["year"], "alternateTitle": item["alternateTitle"],
                                     "cast": names(row.film_cast), "directors": names(row.film_director),
                                     "metadataSource": source, "creditsSource": source}
        titles[str(item["movieId"])] = item["title"]
    output = json.dumps({"items": items, "titles": titles}, ensure_ascii=False, separators=(",", ":"))
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(output + "\n", encoding="utf-8")
        print(f"Extracted {len(items)} exact-ID title records.")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(output)


if __name__ == "__main__":
    main()
