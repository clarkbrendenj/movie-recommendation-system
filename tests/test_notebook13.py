"""Numerical feedback, candidate ranking, and validation boundary contracts."""

import ast
import inspect
import json
from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import negative_ratings_experiment as experiment


class RatingWeightTests(unittest.TestCase):
    def setUp(self):
        self.ratings = np.array([[0.5, 1, 1.5, 2, 2.5], [3, 3.5, 4, 4.5, 5]])

    def test_binary_likes_retains_original_threshold_and_explicit_dislikes(self):
        before = self.ratings.copy()
        positive, negative = experiment.rating_weights(self.ratings, "binary_likes")
        np.testing.assert_array_equal(positive, [[0, 0, 0, 0, 0], [0, 0, 1, 1, 1]])
        np.testing.assert_array_equal(negative, [[2, 1.5, 1, 0.5, 0], [0, 0, 0, 0, 0]])
        np.testing.assert_array_equal(self.ratings, before)

    def test_graded_likes_distinguishes_eight_nine_and_ten_out_of_ten(self):
        positive, negative = experiment.rating_weights(self.ratings, "graded_likes")
        np.testing.assert_array_equal(positive, [[0, 0, 0, 0, 0], [0, 0, 0.5, 1, 1.5]])
        np.testing.assert_array_equal(negative, [[2, 1.5, 1, 0.5, 0], [0, 0, 0, 0, 0]])

    def test_all_centered_uses_both_sides_of_neutral_six_out_of_ten(self):
        positive, negative = experiment.rating_weights(self.ratings, "all_centered")
        np.testing.assert_array_equal(positive, [[0, 0, 0, 0, 0], [0, 0.5, 1, 1.5, 2]])
        np.testing.assert_array_equal(negative, [[2.5, 2, 1.5, 1, 0.5], [0, 0, 0, 0, 0]])
        self.assertTrue(np.all((positive == 0) | (negative == 0)))

    def test_invalid_ratings_and_unknown_profiles_fail(self):
        for value in [0, 5.5, 4.1, float("nan"), float("inf")]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                experiment.rating_weights(np.array([value]), "binary_likes")
        with self.assertRaises(ValueError):
            experiment.rating_weights(self.ratings, "unknown")


class AffinityTests(unittest.TestCase):
    def test_weighted_profile_denominator_ignores_missing_feature_rows(self):
        feedback = csr_matrix([[1., 3, 2, 0], [0, 0, 4, 0]])
        features = csr_matrix([[1., 0], [0, 1], [0, 0], [1, 1]])
        feedback_before, features_before = feedback.copy(), features.copy()
        actual = experiment.weighted_affinity(feedback, features)
        np.testing.assert_allclose(actual, [[0.25, 0.75, 0, 1], [0, 0, 0, 0]])
        self.assertEqual((feedback != feedback_before).nnz, 0)
        self.assertEqual((features != features_before).nnz, 0)
        self.assertTrue(np.isfinite(actual).all())

    def test_affinity_is_invariant_to_common_profile_weight_multiplier(self):
        feedback = csr_matrix([[0.5, 1.5, 0]])
        features = csr_matrix([[1., 0], [0, 1], [0.5, 0.5]])
        np.testing.assert_allclose(experiment.weighted_affinity(feedback, features),
                                   experiment.weighted_affinity(feedback * 7, features))

    def test_normalization_uses_unseen_maximum_and_handles_no_signal(self):
        scores = np.array([[100., 2, 4], [0, 0, 0], [5, 0, 0]])
        seen = np.array([[True, False, False], [False, False, False], [True, False, False]])
        before = scores.copy()
        actual = experiment.normalize_unseen(scores, seen)
        np.testing.assert_allclose(actual, [[25, 0.5, 1], [0, 0, 0], [0, 0, 0]])
        np.testing.assert_array_equal(scores, before)
        self.assertTrue(np.isfinite(actual).all())

    def test_negative_and_nonfinite_affinity_signals_are_rejected(self):
        for scores in [np.array([[-1., 1]]), np.array([[float("nan"), 1]])]:
            with self.assertRaises(ValueError):
                experiment.normalize_unseen(scores, np.zeros_like(scores, dtype=bool))

    def test_signed_penalty_and_quality_are_added_once_without_clipping(self):
        positive = np.array([[0.8, 0.6, 0.1], [0, 0, 0]])
        negative = np.array([[1., 0.2, 0], [0.5, 0, 1]])
        adjustment = np.array([-0.1, 0.2, 0])
        before = [value.copy() for value in [positive, negative, adjustment]]
        actual = experiment.combine_scores(positive, negative, adjustment, 0.1, 0.5)
        np.testing.assert_allclose(actual, [[0.29, 0.52, 0.1], [-0.26, 0.02, -0.5]])
        for original, unchanged in zip([positive, negative, adjustment], before):
            np.testing.assert_array_equal(original, unchanged)
        zero = experiment.combine_scores(positive, negative, adjustment, 0.1, 0)
        np.testing.assert_allclose(zero, positive + 0.1 * adjustment)

    def test_missing_dislike_signal_leaves_positive_scores_unchanged(self):
        positive = np.array([[0.1, 0.9, 0.2]])
        np.testing.assert_allclose(
            experiment.combine_scores(positive, np.zeros_like(positive), np.zeros(3), 0.1, 1),
            positive,
        )


class RankingAndMetricTests(unittest.TestCase):
    def test_all_rated_items_are_excluded_and_ties_have_stable_secondary_keys(self):
        scores = np.array([10., 0.9, 0.9, 0.9, 0.8])
        seen = np.array([True, False, False, False, False])
        counts = np.array([50, 10, 10, 11, 99])
        ids = np.array([10, 40, 20, 30, 50])
        np.testing.assert_array_equal(experiment.rank_unseen(scores, seen, counts, ids, 10),
                                      [30, 20, 40, 50])
        np.testing.assert_array_equal(
            experiment.rank_unseen(-scores, np.ones_like(seen), counts, ids, 10), []
        )

    def test_recall_and_ideal_dcg_include_unavailable_validation_positives(self):
        validation = pd.DataFrame([
            (1, 10, 5.), (1, 999, 4.), (1, 30, 1.), (1, 40, 3.5),
            (2, 10, 2.), (2, 20, 3.), (3, 50, 4.),
        ], columns=["userId", "movieId", "rating"])
        rankings = {1: [30, 10, 40], 2: [10, 20], 3: [50]}
        before = validation.copy(deep=True)
        actual = experiment.evaluate_rankings(rankings, validation, k=10).set_index("userId")
        self.assertEqual(set(actual.index), {1, 3})
        self.assertEqual(actual.loc[1, "n_positives"], 2)
        self.assertEqual(actual.loc[1, "hits_at_10"], 1)
        self.assertEqual(actual.loc[1, "recall_at_10"], 0.5)
        self.assertAlmostEqual(actual.loc[1, "ndcg_at_10"],
                               (1 / np.log2(3)) / (1 + 1 / np.log2(3)))
        self.assertEqual(actual.loc[1, "disliked_hits_at_10"], 1)
        self.assertEqual(actual.loc[3, "recall_at_10"], 1)
        pd.testing.assert_frame_equal(validation, before)


class NotebookBoundaryTests(unittest.TestCase):
    def test_notebook_13_has_no_test_feedback_reader_or_paid_api_calls(self):
        path = ROOT / "notebooks/13_negative_ratings_recommendations.ipynb"
        notebook = json.loads(path.read_text(encoding="utf-8"))
        source = "\n".join("".join(cell["source"]) for cell in notebook["cells"]
                           if cell["cell_type"] == "code")
        ast.parse(source)
        self.assertNotIn("test_ratings.csv", source)
        self.assertNotIn("OPENAI_API_KEY", source)
        self.assertNotIn("OpenAI(", source)

    def test_experiment_does_not_open_test_feedback(self):
        source = "\n".join(inspect.getsource(function) for function in
                           [experiment.prepare_experiment, experiment.run_experiment])
        tree = ast.parse(source)
        constants = {node.value for node in ast.walk(tree)
                     if isinstance(node, ast.Constant) and isinstance(node.value, str)}
        self.assertIn("validation_ratings.csv", constants)
        self.assertNotIn("test_ratings.csv", constants)


if __name__ == "__main__":
    unittest.main()
