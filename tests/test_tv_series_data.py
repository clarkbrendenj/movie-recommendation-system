"""Offline metadata and cache-contract checks for the notebook-15 TV catalog."""

import csv
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
from uuid import uuid4

from scripts import prepare_tv_series as tv


def show(imdb="tt0000001", show_id=1, **changes):
    row = {"id": show_id, "name": "A Series", "language": "English", "type": "Scripted",
           "externals": {"imdb": imdb}, "summary": "<p>A &amp; B.</p>",
           "genres": ["Drama"], "url": f"https://www.tvmaze.com/shows/{show_id}/a-series"}
    row.update(changes)
    return row


def basic(imdb="tt0000001", kind="tvSeries"):
    return {"tconst": imdb, "titleType": kind, "primaryTitle": "A Series", "startYear": "2001"}


class TVCatalogTests(unittest.TestCase):
    def test_selection_is_bounded_and_not_based_on_rating(self):
        selected = tv.select_shows([show(show_id=1, rating={"average": 1}),
                                    show("tt0000002", 2, language="French"),
                                    show("tt0000003", 3, type="Reality"),
                                    show("tt0000004", 4, type="Documentary")])
        self.assertEqual([row["id"] for row in selected], [1, 4])
        with self.assertRaises(ValueError):
            tv.select_shows([show(show_id=251)])
        with self.assertRaises(ValueError):
            tv.select_shows([show(), show()])

    def test_exact_type_join_keeps_unknown_movielens_entries(self):
        links = [{"movieId": "10", "imdbId": "1"},
                 {"movieId": "11", "imdbId": "999"},
                 {"movieId": "12", "imdbId": ""}]
        catalog = tv.build_catalog(links, [show(), show("tt0000002", 2)],
                                   [basic(), basic("tt0000002", "tvEpisode")], [], [])
        self.assertEqual(len(catalog["series"]), 1)
        self.assertEqual([row["titleType"] for row in catalog["movielens_types"]],
                         ["tvSeries", None, None])
        self.assertEqual(catalog["series"][0]["imdbId"], "tt0000001")

    def test_cast_uses_ordered_distinct_imdb_actor_ids(self):
        principals = [{"tconst": "tt0000001", "ordering": str(order),
                       "category": category, "nconst": person}
                      for order, category, person in [
                          (9, "actor", "nm0000009"), (3, "actress", "nm0000003"),
                          (1, "director", "nm0000001"), (2, "actor", "nm0000002"),
                          (4, "actor", "nm0000002"), (5, "actor", "nm0000005"),
                          (6, "actor", "nm0000006"), (7, "actor", "nm0000007"),
                          (0, "actor", "A Name"),
                      ]]
        catalog = tv.build_catalog([], [show()], [basic()], principals, [])
        self.assertEqual(catalog["series"][0]["cast"],
                         ["nm0000002", "nm0000003", "nm0000005", "nm0000006", "nm0000007"])

    def test_html_is_text_and_invalid_aggregate_is_missing(self):
        self.assertEqual(tv.plain_summary("<p>A &amp; B.</p><p>C<br>D</p><script>bad()</script>"),
                         "A & B. C D")
        for rating, votes in [("nan", "10"), ("8.1", "0"), ("11", "50"), ("\\N", "\\N")]:
            with self.subTest(rating=rating, votes=votes):
                catalog = tv.build_catalog([], [show()], [basic()], [],
                                           [{"tconst": "tt0000001", "averageRating": rating,
                                             "numVotes": votes}])
                self.assertIsNone(catalog["series"][0]["averageRating"])
                self.assertIsNone(catalog["series"][0]["numVotes"])

    def test_title_name_never_resolves_or_conflates_identifiers(self):
        catalog = tv.build_catalog([], [show(), show("tt0000002", 2)], [basic()], [], [])
        self.assertEqual([row["imdbId"] for row in catalog["series"]], ["tt0000001"])
        deduplicated = tv.select_shows([show(show_id=2), show(show_id=1)])
        self.assertEqual([row["id"] for row in deduplicated], [1])


class TVCacheTests(unittest.TestCase):
    def setUp(self):
        self.allowed = (tv.ROOT / "data").resolve()
        self.root = self.allowed / f"test_tv_data_{uuid4().hex}"
        self.root.mkdir(parents=True)
        links = self.root / "data/raw/ml-latest-small/links.csv"
        links.parent.mkdir(parents=True)
        links.write_text("movieId,imdbId,tmdbId\n10,2,\n", encoding="utf-8")

    def tearDown(self):
        resolved = self.root.resolve()
        if resolved.parent != self.allowed or not resolved.name.startswith("test_tv_data_"):
            raise ValueError("Unsafe test fixture cleanup path.")
        shutil.rmtree(resolved)

    @staticmethod
    def fake_tvmaze(path):
        rows = [show()]
        path.write_text(json.dumps(rows), encoding="utf-8")
        return rows, {"url": tv.TVMAZE_URL, "subset_sha256": tv.file_sha256(path), "records": 1}

    @staticmethod
    def fake_subset(dataset, wanted_ids, path):
        if dataset == "title.basics":
            rows = [basic(), basic("tt0000002", "movie")]
        elif dataset == "title.principals":
            rows = [{"tconst": "tt0000001", "ordering": "1", "category": "actor", "nconst": "nm0000001"}]
        else:
            rows = [{"tconst": "tt0000001", "averageRating": "8.5", "numVotes": "100"}]
        with path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]), delimiter="\t")
            writer.writeheader()
            writer.writerows(rows)
        return {"url": f"https://datasets.imdbws.com/{dataset}.tsv.gz",
                "subset_sha256": tv.file_sha256(path)}

    def test_second_run_is_offline_and_tampering_refreshes_only_affected_subset(self):
        with patch.object(tv, "_download_tvmaze", side_effect=self.fake_tvmaze) as download:
            with patch.object(tv, "stream_subset", side_effect=self.fake_subset) as subset:
                catalog_path = tv.prepare_catalog(self.root)
                self.assertEqual(subset.call_count, 3)
                self.assertEqual(download.call_count, 1)
                first = catalog_path.read_bytes()
                tv.prepare_catalog(self.root)
                self.assertEqual(subset.call_count, 3)
                self.assertEqual(download.call_count, 1)
                self.assertEqual(first, catalog_path.read_bytes())
                ratings_path = catalog_path.parent / "title.ratings.tsv"
                ratings_path.write_text("tampered", encoding="utf-8")
                tv.prepare_catalog(self.root)
                self.assertEqual(subset.call_count, 4)
                self.assertEqual(subset.call_args.args[0], "title.ratings")
                manifest = json.loads((catalog_path.parent / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["catalog_sha256"], tv.file_sha256(catalog_path))
                self.assertFalse(manifest["test_feedback_read"])


if __name__ == "__main__":
    unittest.main()
