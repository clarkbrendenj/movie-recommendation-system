"""Build a metadata-only app film filter without altering frozen movie features."""

import hashlib
import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_TYPES = {"tvSeries", "tvMiniSeries", "tvEpisode"}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(root=ROOT):
    root = Path(root)
    paths = {
        "modelMetadata": root / "web/public/model/metadata.json",
        "movieLensLinks": root / "data/raw/ml-latest-small/links.csv",
        "imdbTitleBasics": root / "data/raw/notebook15_tv_series/title.basics.tsv",
    }
    metadata = json.loads(paths["modelMetadata"].read_text(encoding="utf-8"))
    movies = pd.DataFrame(metadata["movies"])[["movieId", "title"]]
    links = pd.read_csv(paths["movieLensLinks"], dtype={"imdbId": "str"})
    links["tconst"] = links.imdbId.map(
        lambda value: "tt" + value.zfill(7) if isinstance(value, str) and value.isdigit() else None
    )
    basics = pd.read_csv(paths["imdbTitleBasics"], sep="\t", dtype="str", na_values="\\N",
                         usecols=["tconst", "titleType"])
    joined = movies.merge(links[["movieId", "tconst"]], on="movieId", how="left", validate="one_to_one")
    joined = joined.merge(basics, on="tconst", how="left", validate="many_to_one")
    excluded = joined.loc[joined.titleType.isin(EXCLUDED_TYPES)].sort_values("movieId")
    if len(joined) != metadata["itemCount"] or len(joined) != 6885 or len(excluded) != 67:
        raise ValueError("The frozen catalog/type snapshot changed; review this overlay before replacing it.")
    overlay = {
        "version": 1,
        "featureItemCount": len(joined),
        "candidateCount": len(joined) - len(excluded),
        "unknownTitleTypes": int(joined.titleType.isna().sum()),
        "titleTypeCounts": {str(key): int(value) for key, value in joined.titleType.fillna("unknown").value_counts().sort_index().items()},
        "excludedItems": [{"movieId": int(row.movieId), "imdbId": row.tconst, "titleType": row.titleType}
                          for row in excluded.itertuples(index=False)],
        "sources": {key: {"path": str(path.relative_to(root)).replace("\\", "/"), "sha256": sha256(path)}
                    for key, path in paths.items()},
        "generatorSha256": sha256(Path(__file__)),
        "policy": "Exact linked IMDb tvSeries/tvMiniSeries/tvEpisode IDs are excluded from the film view before top-k/pagination. All frozen feature rows and legacy ratings remain intact.",
        "benchmark": "Recall@10 0.122573 belongs to the original unfiltered 6,885-item catalog; this film-view filter has not been re-benchmarked.",
    }
    output = root / "web/public/catalog/movie-unit-exclusions.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(overlay, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Saved {len(excluded)} exact-ID exclusions; {overlay['candidateCount']} film-view candidates; {overlay['unknownTitleTypes']} unknown types remain unverified.")
    return overlay


if __name__ == "__main__":
    prepare()
