"""Exact-ID ratings linkage, snapshot caching, smoothing, and ranking contracts."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.prepare_imdb_credits import file_sha256
from scripts.prepare_imdb_ratings import build_ratings_catalog, prepare_ratings
from scripts.imdb_ratings_model import rating_prior, rerank_with_ratings


class RatingsLinkageTests(unittest.TestCase):
    def test_exact_ids_missing_and_invalid_observations_preserve_all_movies(self):
        links = [{"movieId": str(i), "imdbId": imdb} for i, imdb in
                 [(1, "114709"), (2, ""), (3, "3"), (4, "4"), (5, "5"), (6, "6")]]
        rows = [{"tconst": imdb, "averageRating": rating, "numVotes": votes} for imdb, rating, votes in
                [("tt0114709", "8.3", "1000"), ("tt0000003", "nan", "10"),
                 ("tt0000004", "8", "0"), ("tt0000005", "11", "100"),
                 ("tt0000006", "\\N", "\\N")]]
        result = build_ratings_catalog(links, rows)["movies"]
        self.assertEqual(len(result), len(links))
        self.assertEqual(result[0], {"movieId": 1, "imdbId": "tt0114709", "averageRating": 8.3, "numVotes": 1000})
        self.assertIsNone(result[1]["imdbId"])
        self.assertTrue(all(row["averageRating"] is None for row in result[1:]))
        json.dumps(result, allow_nan=False)

    def test_duplicate_ids_are_rejected(self):
        row = {"tconst": "tt0000001", "averageRating": "8", "numVotes": "10"}
        with self.assertRaises(ValueError):
            build_ratings_catalog([], [row, row])
        with self.assertRaises(ValueError):
            build_ratings_catalog([{"movieId": "1", "imdbId": ""}] * 2, [])

    def test_verified_cache_reuse_corruption_and_explicit_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / "data/raw/ml-latest-small"
            raw.mkdir(parents=True)
            (raw / "links.csv").write_text("movieId,imdbId\n1,1\n2,\n", encoding="utf-8")
            def download(dataset, wanted, destination):
                self.assertEqual(dataset, "title.ratings")
                self.assertEqual(wanted, {"tt0000001"})
                destination.write_text("tconst\taverageRating\tnumVotes\ntt0000001\t8.0\t100\n", encoding="utf-8")
                return {"subset_sha256": file_sha256(destination), "url": "fixture"}
            with patch("scripts.prepare_imdb_ratings.stream_subset", side_effect=download) as stream:
                path = prepare_ratings(root)
                first = path.read_bytes()
                path.write_text("corrupt", encoding="utf-8")
                prepare_ratings(root)
                self.assertEqual(stream.call_count, 1)
                self.assertEqual(first, path.read_bytes())
                (path.parent / "title.ratings.tsv").write_text("corrupt", encoding="utf-8")
                prepare_ratings(root)
                self.assertEqual(stream.call_count, 2)
                prepare_ratings(root, force=True)
                self.assertEqual(stream.call_count, 3)


class PriorTests(unittest.TestCase):
    def test_candidate_only_center_vote_smoothing_and_missing_neutrality(self):
        records = [{"movieId": 1, "averageRating": 8, "numVotes": 1000},
                   {"movieId": 2, "averageRating": 4, "numVotes": 100},
                   {"movieId": 3, "averageRating": None, "numVotes": None},
                   {"movieId": 99, "averageRating": 10, "numVotes": 1000000}]
        prior = rating_prior(records, [2, 3, 1, 4])
        self.assertEqual(prior["center"], 6)
        np.testing.assert_allclose(prior["smoothed"], [6 - 2 / 11, 6, 7, 6])
        np.testing.assert_allclose(prior["adjustment"], [-2 / 99, 0, 1 / 9, 0])
        np.testing.assert_array_equal(prior["covered"], [True, False, True, False])

    def test_same_rating_with_few_votes_is_shrunk_more(self):
        records = [{"movieId": i, "averageRating": r, "numVotes": v}
                   for i, r, v in [(1, 9, 10), (2, 9, 100000), (3, 3, 1000)]]
        prior = rating_prior(records, [1, 2, 3])
        self.assertLess(prior["smoothed"][0], prior["smoothed"][1])

    def test_invalid_prior_and_no_observations_fail_explicitly(self):
        for m in [0, -1, float("nan")]:
            with self.assertRaises(ValueError):
                rating_prior([], [1], m)
        for ids in [[], [1, 1], [1]]:
            with self.assertRaises(ValueError):
                rating_prior([], ids)


class RerankingTests(unittest.TestCase):
    def test_zero_weight_ranking_and_missing_score_are_preserved(self):
        base = np.array([[100, 1, 2, 0], [0, 0, 0, 0]])
        seen = np.array([[True, False, False, False], [False] * 4])
        adjustment = np.array([0, 0, -0.2, 0.1])
        zero = rerank_with_ratings(base, adjustment, 0, seen)
        np.testing.assert_allclose(zero, [[50, 0.5, 1, 0], [0, 0, 0, 0]])
        result = rerank_with_ratings(base, adjustment, 1, seen)
        np.testing.assert_allclose(result, zero + adjustment)
        self.assertEqual(result[0, 1], zero[0, 1])
        self.assertTrue(np.isfinite(result).all())

    def test_quality_can_change_the_recommendation(self):
        scores = rerank_with_ratings([[0.8, 0.79]], [-0.2, 0.2], 0.5, [[False, False]])
        self.assertEqual(int(scores.argmax()), 1)

    def test_invalid_arrays_and_weights_are_rejected(self):
        for base, adjustment, weight, seen in [
            ([[float("nan")]], [0], 0.1, [[False]]),
            ([[1]], [float("inf")], 0.1, [[False]]),
            ([[1]], [2], 0.1, [[False]]),
            ([[1]], [0, 0], 0.1, [[False]]),
            ([[1]], [0], -0.1, [[False]]),
            ([[1]], [0], 2, [[False]]),
        ]:
            with self.assertRaises(ValueError):
                rerank_with_ratings(base, adjustment, weight, seen)


if __name__ == "__main__":
    unittest.main()
