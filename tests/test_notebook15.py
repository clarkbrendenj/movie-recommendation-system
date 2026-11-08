"""TV cold-item extension: frozen identities/features, scaling, and profile input."""

import ast
import inspect
import json
from pathlib import Path
import sys
import unittest

import numpy as np
from scipy.sparse import csr_matrix, issparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import tv_series_experiment as experiment


class CastTransformTests(unittest.TestCase):
    def test_person_ids_use_frozen_column_order_idf_and_binary_presence(self):
        records = [{"cast": ["nm0000001", "nm0000002", "nm0000002", "nm9999999"]},
                   {"cast": ["nm9999999"]}, {"cast": []}]
        before = json.loads(json.dumps(records))
        actual = experiment.transform_cast(records, ["nm0000002", "nm0000001"], np.array([2., 1]))
        self.assertTrue(issparse(actual))
        np.testing.assert_allclose(actual.toarray(), [[2 / np.sqrt(5), 1 / np.sqrt(5)], [0, 0], [0, 0]])
        self.assertEqual(records, before)
        self.assertTrue(np.isfinite(actual.data).all())

    def test_unknown_cast_does_not_fit_new_columns_or_change_known_actor_weight(self):
        known = experiment.transform_cast([{"cast": ["nm0000001"]}], ["nm0000001"], np.array([7.]))
        unknown_added = experiment.transform_cast(
            [{"cast": ["nm0000001", "nm9999999"]}], ["nm0000001"], np.array([7.])
        )
        self.assertEqual(known.shape, (1, 1))
        np.testing.assert_allclose(known.toarray(), [[1]])
        np.testing.assert_array_equal(known.toarray(), unknown_added.toarray())


class ReferenceScalingTests(unittest.TestCase):
    def test_only_unseen_original_candidates_determine_the_denominator(self):
        scores = np.array([[100., 2, 4, 8, 16], [0, 0, 0, 1, 2]])
        seen = np.array([[True, False, False, False, False], [False] * 5])
        reference = np.array([True, True, True, False, False])
        before = scores.copy()
        actual = experiment.scale_reference(scores, seen, reference)
        np.testing.assert_allclose(actual, [[25, 0.5, 1, 2, 4], [0, 0, 0, 0, 0]])
        np.testing.assert_array_equal(scores, before)
        self.assertTrue(np.isfinite(actual).all())

    def test_all_reference_items_seen_produces_a_finite_zero_signal(self):
        actual = experiment.scale_reference(
            np.array([[1., 2, 5]]), np.array([[True, True, False]]), np.array([True, True, False])
        )
        np.testing.assert_array_equal(actual, [[0, 0, 0]])


class ProfileInputTests(unittest.TestCase):
    def setUp(self):
        self.ids = ["ml:1", "imdb:tt0000002", "ml:3"]

    def test_eight_out_of_ten_is_inclusive_and_every_rating_is_seen(self):
        ratings = [{"itemId": "ml:1", "rating10": 7},
                   {"itemId": "imdb:tt0000002", "rating10": 8},
                   {"itemId": "ml:3", "rating10": 10}]
        before = json.loads(json.dumps(ratings))
        feedback, seen = experiment.validate_profile(ratings, self.ids)
        self.assertTrue(issparse(feedback))
        np.testing.assert_array_equal(feedback.toarray(), [[0, 1, 1]])
        np.testing.assert_array_equal(seen, [[True, True, True]])
        self.assertEqual(ratings, before)

    def test_empty_profile_retains_the_full_fixed_catalog(self):
        feedback, seen = experiment.validate_profile([], self.ids)
        self.assertEqual(feedback.shape, (1, 3))
        self.assertEqual(feedback.nnz, 0)
        np.testing.assert_array_equal(seen, [[False, False, False]])

    def test_bad_ratings_duplicates_and_wrong_identity_namespace_are_rejected(self):
        invalid = [[{"itemId": "ml:1", "rating10": value}]
                   for value in [0, 11, 7.5, True, "8", float("nan")]]
        invalid.extend([
            [{"itemId": "tvmaze:2", "rating10": 8}],
            [{"itemId": "imdb:tt0000001", "rating10": 8}],
            [{"itemId": "ml:1", "rating10": 8}, {"itemId": "ml:1", "rating10": 9}],
        ])
        for ratings in invalid:
            with self.subTest(ratings=ratings), self.assertRaises(ValueError):
                experiment.validate_profile(ratings, self.ids)


class FrozenScoringTests(unittest.TestCase):
    def setUp(self):
        self.features = {
            "cf": csr_matrix([[1., 0], [0.8, 0.6], [0.6, 0.8], [0, 1], [0, 0], [0, 0]]),
            "plots": csr_matrix([[1., 0], [0.6, 0.8], [0.8, 0.6], [0, 1], [1, 0], [0, 1]]),
            "cast": csr_matrix([[1., 0], [0, 1], [1, 0], [0, 1], [0, 1], [1, 0]]),
        }
        self.weights = {"plot": 0.25, "credits": 0.25, "imdb": 0.1}
        self.adjustment = np.array([0., 0.2, -0.1, 0, 0.3, -0.2])
        self.feedback = csr_matrix([[1., 0, 0, 0, 0, 0]])
        self.seen = np.array([[True, False, False, True, False, False]])
        self.reference = np.array([True, True, True, True, False, False])

    def score(self, feedback=None, features=None, seen=None):
        return experiment.score_profiles(
            self.feedback if feedback is None else feedback,
            self.features if features is None else features,
            self.weights, self.adjustment,
            self.seen if seen is None else seen, self.reference,
        )

    def test_hybrid_uses_reference_anchors_and_adds_frozen_prior_once(self):
        scores = self.score()
        # Hand-calculated CF/plot blend, then cast blend, then reference scaling.
        expected = np.array([[25 / 18, 5 / 6, 1, 0, 5 / 18, 5 / 18]])
        expected += self.weights["imdb"] * self.adjustment
        np.testing.assert_allclose(scores, expected, atol=1e-14, rtol=0)

    def test_appending_cold_tv_rows_preserves_all_original_candidate_scores(self):
        expanded = self.score()
        original = experiment.score_profiles(
            self.feedback[:, :4], {name: matrix[:4] for name, matrix in self.features.items()},
            self.weights, self.adjustment[:4], self.seen[:, :4], np.ones(4, dtype=bool),
        )
        np.testing.assert_allclose(expanded[:, :4], original, atol=1e-14, rtol=0)

    def test_missing_content_falls_back_without_suppressing_collaborative_signal(self):
        features = {**self.features, "plots": csr_matrix((6, 0)), "cast": csr_matrix((6, 0))}
        expected = np.array([[1.25, 1, 0.75, 0, 0, 0]]) + 0.1 * self.adjustment
        np.testing.assert_allclose(self.score(features=features), expected, atol=1e-14, rtol=0)

    def test_liking_new_tv_transfers_content_to_movies_despite_zero_tv_cf_rows(self):
        feedback = csr_matrix([[0., 0, 0, 0, 1, 0]])
        seen = np.array([[False, False, False, False, True, False]])
        scores = self.score(feedback=feedback, seen=seen)
        expected = np.array([[1, 14 / 15, 0.8, 1 / 3, 4 / 3, 0]]) + 0.1 * self.adjustment
        np.testing.assert_allclose(scores, expected, atol=1e-14, rtol=0)

    def test_empty_positive_profile_uses_only_the_original_imdb_adjustment(self):
        np.testing.assert_allclose(self.score(feedback=csr_matrix((1, 6))),
                                   (0.1 * self.adjustment)[None, :], atol=1e-14, rtol=0)

    def test_scoring_does_not_mutate_feedback_features_or_prior(self):
        feedback_before = self.feedback.copy()
        features_before = {name: matrix.copy() for name, matrix in self.features.items()}
        adjustment_before = self.adjustment.copy()
        seen_before = self.seen.copy()
        self.score()
        self.assertEqual((feedback_before != self.feedback).nnz, 0)
        for name in self.features:
            self.assertEqual((features_before[name] != self.features[name]).nnz, 0)
        np.testing.assert_array_equal(self.adjustment, adjustment_before)
        np.testing.assert_array_equal(self.seen, seen_before)


class NotebookBoundaryTests(unittest.TestCase):
    def test_notebook_15_and_helper_do_not_read_test_feedback_or_paid_api_credentials(self):
        notebooks = list((ROOT / "notebooks").glob("15_*.ipynb"))
        self.assertEqual(len(notebooks), 1)
        notebook = json.loads(notebooks[0].read_text(encoding="utf-8"))
        code = "\n".join("".join(cell["source"]) for cell in notebook["cells"]
                         if cell["cell_type"] == "code")
        ast.parse(code)
        for source in [code, inspect.getsource(experiment)]:
            self.assertNotIn("test_ratings.csv", source)
            self.assertNotIn("OPENAI_API_KEY", source)
            self.assertNotIn("OpenAI(", source)


if __name__ == "__main__":
    unittest.main()
