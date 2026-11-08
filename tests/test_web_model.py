"""Portable model inference, notebook parity, cold start, and input contracts."""

import json
from contextlib import contextmanager
from pathlib import Path
import sys
import unittest
from uuid import uuid4

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.preprocessing import normalize

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.export_web_model import (
    notebook_functions, read_features, recommend, score_ratings, write_features,
)


@contextmanager
def binary_fixture_directory():
    # Python 3.14's private TemporaryDirectory ACL is inaccessible in the managed
    # Windows sandbox. Ordinary workspace directories inherit the writable ACL.
    directory = ROOT / "data" / ("web-model-test-" + uuid4().hex)
    directory.mkdir()
    try:
        yield directory
    finally:
        for path in directory.iterdir():
            path.unlink()
        directory.rmdir()


class PortableInferenceTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {
            "positiveThreshold": 4.0, "weights": {"plot": 0.25, "credits": 0.25, "imdb": 0.1},
            "creditRoles": ["cast"],
            "movies": [{"movieId": item, "popularity": count, "imdbAdjustment": quality}
                       for item, count, quality in [(1, 9, 0.1), (2, 10, -0.1), (3, 10, 0.2),
                                                    (4, 10, 0.2), (5, 8, 0), (6, 1, -0.2)]],
        }
        self.features = {
            "cf": normalize(csr_matrix([[1., 1], [1, 0], [0, 1], [0, 1], [1, 0], [0, 0]])),
            "plots": normalize(csr_matrix([[1., 0, 0], [1, 0, 0], [0, 1, 0],
                                           [0, 1, 1], [1, 1, 0], [0, 0, 0]])),
            "cast": normalize(csr_matrix([[1., 0], [0, 1], [1, 0], [1, 1], [0, 1], [0, 0]])),
        }

    def test_scores_and_rankings_match_notebook_formula(self):
        ratings = [{"movieId": 1, "rating": 5}, {"movieId": 3, "rating": 4},
                   {"movieId": 6, "rating": 4}, {"movieId": 2, "rating": 1}]
        functions = notebook_functions()
        feedback = np.array([[1., 0, 1, 0, 0, 1]])
        seen = np.array([[True, True, True, False, False, True]])
        scores = {name: functions["score_features"](feedback, matrix)[0]
                  for name, matrix in self.features.items()}
        base = functions["blend_with_fallback"](scores["cf"], scores["plots"], 0.25, seen)
        credit = functions["scale_unseen"](scores["cast"], seen)
        base = functions["blend_with_fallback"](base, credit, 0.25, seen)
        expected = functions["scale_unseen"](base, seen)[0] + 0.1 * np.array([0.1, -0.1, 0.2, 0.2, 0, -0.2])
        actual, actual_seen, cold = score_ratings(self.metadata, self.features, ratings)
        np.testing.assert_allclose(actual, expected, atol=1e-14, rtol=0)
        np.testing.assert_array_equal(actual_seen, seen[0])
        self.assertFalse(cold)
        expected_ids = functions["rank_unseen"](expected, seen[0], np.array([9, 10, 10, 10, 8, 1]), np.arange(1, 7))
        self.assertEqual([row["movieId"] for row in recommend(self.metadata, self.features, ratings)], expected_ids.tolist())

    def test_binary_roundtrip_uses_typed_little_endian_arrays_and_float64_scoring(self):
        with binary_fixture_directory() as directory:
            self.metadata["groups"] = write_features(directory, self.features)
            restored = read_features(directory, self.metadata)
            for name in self.features:
                self.assertEqual(restored[name].dtype, np.float32)
                np.testing.assert_allclose(restored[name].toarray(), self.features[name].toarray(), atol=3e-8)
            self.assertEqual(self.metadata["groups"][0]["indices"]["dtype"], "uint16")
            ratings = [{"movieId": 1, "rating": 5}]
            original = score_ratings(self.metadata, self.features, ratings)[0]
            portable = score_ratings(self.metadata, restored, ratings)[0]
            self.assertEqual(portable.dtype, np.float64)
            np.testing.assert_allclose(original, portable, atol=2e-7)
            self.assertEqual([row["movieId"] for row in recommend(self.metadata, self.features, ratings)],
                             [row["movieId"] for row in recommend(self.metadata, restored, ratings)])

    def test_corrupted_model_is_rejected(self):
        with binary_fixture_directory() as directory:
            self.metadata["groups"] = write_features(directory, self.features)
            (Path(directory) / "cf.data.bin").write_bytes(b"broken")
            with self.assertRaisesRegex(ValueError, "fingerprint changed"):
                read_features(directory, self.metadata)

    def test_no_likes_uses_popularity_then_imdb_then_movie_id(self):
        self.assertEqual([row["movieId"] for row in recommend(self.metadata, self.features, [])], [3, 4, 2, 1, 5, 6])
        dislikes = [{"movieId": 3, "rating": 3.5}, {"movieId": 1, "rating": 0.5}]
        self.assertEqual([row["movieId"] for row in recommend(self.metadata, self.features, dislikes)], [4, 2, 5, 6])

    def test_all_rated_movies_are_excluded_and_order_is_deterministic(self):
        ratings = [{"movieId": 1, "rating": 4}, {"movieId": 3, "rating": 5}, {"movieId": 2, "rating": 2}]
        first = recommend(self.metadata, self.features, ratings)
        reverse = recommend(self.metadata, self.features, list(reversed(ratings)))
        self.assertEqual([row["movieId"] for row in first], [row["movieId"] for row in reverse])
        self.assertFalse({1, 2, 3}.intersection(row["movieId"] for row in first))
        all_rated = [{"movieId": item, "rating": 4} for item in range(1, 7)]
        self.assertEqual(recommend(self.metadata, self.features, all_rated), [])

    def test_missing_content_uses_cf_instead_of_suppressing_candidates(self):
        features = {**self.features, "plots": csr_matrix((6, 0)), "cast": csr_matrix((6, 0))}
        ratings = [{"movieId": 1, "rating": 5}]
        scores, seen, _ = score_ratings(self.metadata, features, ratings)
        cf = np.asarray(features["cf"] @ features["cf"][0].T.todense()).ravel()
        cf /= np.where(seen, 0, cf).max()
        np.testing.assert_allclose(scores, cf + 0.1 * np.array([0.1, -0.1, 0.2, 0.2, 0, -0.2]))

    def test_invalid_ratings_never_silently_change_a_profile(self):
        bad = [[{"movieId": 1, "rating": value}] for value in [0, 5.5, 4.1, True, "5", float("nan")]]
        bad.extend([[{"movieId": 999, "rating": 4}], [{"movieId": "1", "rating": 4}],
                    [{"movieId": 1, "rating": 4}] * 2])
        for ratings in bad:
            with self.subTest(ratings=ratings), self.assertRaises(ValueError):
                recommend(self.metadata, self.features, ratings)


@unittest.skipUnless((ROOT / "data/web_model/metadata.json").exists(), "Export the local model to run integration checks.")
class ExportedModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = ROOT / "data/web_model"
        cls.metadata = json.loads((cls.directory / "metadata.json").read_text(encoding="utf-8"))
        cls.features = read_features(cls.directory, cls.metadata)

    def test_notebook_parity_and_memory_budget_were_verified(self):
        verification = self.metadata["verification"]
        self.assertTrue(verification["allPersonalizedTop10Identical"])
        self.assertEqual(verification["savedValidationUsersVerified"], 594)
        self.assertGreater(verification["personalizedUsersCompared"], 590)
        self.assertLess(verification["maxAbsoluteScoreDifference"], 2e-6)
        self.assertLess(self.metadata["sparseBytes"], 64 * 1024 * 1024)
        self.assertEqual(self.metadata["weights"], {"plot": 0.25, "credits": 0.25, "imdb": 0.1})

    def test_reference_cases_are_reproducible(self):
        cases = json.loads((self.directory / "reference.json").read_text(encoding="utf-8"))["cases"]
        for case in cases:
            with self.subTest(name=case["name"]):
                recs = recommend(self.metadata, self.features, case["ratings"])
                self.assertEqual([row["movieId"] for row in recs], case["top10"])
                np.testing.assert_allclose([row["score"] for row in recs],
                                           [row["score"] for row in case["scores"]], atol=1e-12)
                self.assertFalse({row["movieId"] for row in case["ratings"]}.intersection(case["top10"]))


if __name__ == "__main__":
    unittest.main()
