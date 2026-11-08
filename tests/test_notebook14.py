"""Like-threshold ablation: inclusive boundaries, CF basis, and evaluation cohorts."""

import ast
import inspect
import json
from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix, issparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import like_threshold_experiment as experiment


class FeedbackAndBasisTests(unittest.TestCase):
    def setUp(self):
        self.train = pd.DataFrame([
            (20, 12, 3.), (20, 11, 3.5), (10, 13, 4.),
            (10, 11, 2.), (20, 13, 5.), (30, 12, 0.5),
        ], columns=["userId", "movieId", "rating"])
        self.users = np.array([30, 10, 20])
        self.ids = np.array([13, 12, 11])

    def test_seven_out_of_ten_is_inclusive_and_keeps_explicit_index_order(self):
        original = self.train.copy(deep=True)
        eight = experiment.make_feedback(self.train, self.users, self.ids, 4.)
        seven = experiment.make_feedback(self.train, self.users, self.ids, 3.5)
        self.assertTrue(issparse(eight))
        self.assertTrue(issparse(seven))
        np.testing.assert_array_equal(eight.toarray(), [[0, 0, 0], [1, 0, 0], [1, 0, 0]])
        np.testing.assert_array_equal(seven.toarray(), [[0, 0, 0], [1, 0, 0], [1, 0, 1]])
        self.assertEqual(eight.shape, (3, 3))
        self.assertEqual(seven.shape, eight.shape)
        pd.testing.assert_frame_equal(self.train, original)
        np.testing.assert_array_equal(self.users, [30, 10, 20])
        np.testing.assert_array_equal(self.ids, [13, 12, 11])

    def test_cf_basis_changes_when_the_training_threshold_changes(self):
        eight_feedback = experiment.make_feedback(self.train, self.users, self.ids, 4.)
        seven_feedback = experiment.make_feedback(self.train, self.users, self.ids, 3.5)
        eight = experiment.fit_cf_basis(eight_feedback)
        seven = experiment.fit_cf_basis(seven_feedback)
        self.assertTrue(issparse(eight))
        self.assertTrue(issparse(seven))
        np.testing.assert_allclose(eight.toarray(),
                                   [[0, 1 / np.sqrt(2), 1 / np.sqrt(2)], [0, 0, 0], [0, 0, 0]])
        np.testing.assert_allclose(seven.toarray(),
                                   [[0, 1 / np.sqrt(2), 1 / np.sqrt(2)], [0, 0, 0], [0, 0, 1]])
        eight_similarity = (eight @ eight.T).toarray()
        seven_similarity = (seven @ seven.T).toarray()
        self.assertEqual(eight_similarity[0, 2], 0)
        self.assertAlmostEqual(seven_similarity[0, 2], 1 / np.sqrt(2))

    def test_cf_basis_normalizes_item_rows_without_mutating_feedback(self):
        feedback = csr_matrix([[1., 1, 0], [1, 0, 0]])
        before = feedback.copy()
        basis = experiment.fit_cf_basis(feedback)
        np.testing.assert_allclose(np.sqrt(basis.multiply(basis).sum(axis=1)).A1, [1, 1, 0])
        self.assertEqual((before != feedback).nnz, 0)
        self.assertTrue(np.isfinite(basis.data).all())


class EvaluationThresholdTests(unittest.TestCase):
    def setUp(self):
        self.validation = pd.DataFrame([
            (1, 10, 4.5), (1, 999, 4.), (1, 30, 3.5), (1, 20, 1.),
            (2, 10, 3.5), (2, 40, 2.), (3, 50, 5.),
        ], columns=["userId", "movieId", "rating"])
        self.rankings = {1: [30, 10, 20], 2: [10, 40], 3: [50]}

    def test_eight_threshold_matches_original_positive_definition(self):
        actual = experiment.evaluate_threshold(self.rankings, self.validation, threshold=4.)
        rows = actual.set_index("userId")
        self.assertEqual(set(rows.index), {1, 3})
        self.assertEqual(rows.loc[1, "n_positives"], 2)
        self.assertEqual(rows.loc[1, "hits_at_10"], 1)
        self.assertEqual(rows.loc[1, "recall_at_10"], 0.5)
        self.assertAlmostEqual(rows.loc[1, "ndcg_at_10"],
                               (1 / np.log2(3)) / (1 + 1 / np.log2(3)))

    def test_seven_threshold_changes_labels_and_adds_eligible_users(self):
        rows = experiment.evaluate_threshold(
            self.rankings, self.validation, threshold=3.5
        ).set_index("userId")
        self.assertEqual(set(rows.index), {1, 2, 3})
        self.assertEqual(rows.loc[1, "n_positives"], 3)
        self.assertEqual(rows.loc[1, "hits_at_10"], 2)
        self.assertAlmostEqual(rows.loc[1, "recall_at_10"], 2 / 3)
        self.assertAlmostEqual(rows.loc[1, "ndcg_at_10"],
                               (1 + 1 / np.log2(3)) / (1 + 1 / np.log2(3) + 0.5))
        self.assertEqual(rows.loc[2, "recall_at_10"], 1)

    def test_common_cohort_keeps_requested_users_and_all_positive_denominators(self):
        before = self.validation.copy(deep=True)
        rows = experiment.evaluate_threshold(
            self.rankings, self.validation, threshold=3.5, users=[1, 3]
        ).set_index("userId")
        self.assertEqual(set(rows.index), {1, 3})
        self.assertEqual(rows.loc[1, "n_positives"], 3)
        self.assertAlmostEqual(rows.loc[1, "recall_at_10"], 2 / 3)
        pd.testing.assert_frame_equal(self.validation, before)

    def test_requested_users_without_qualifying_positives_fail_instead_of_disappearing(self):
        with self.assertRaises(ValueError):
            experiment.evaluate_threshold(self.rankings, self.validation, threshold=4., users=[1, 2])
        with self.assertRaises(ValueError):
            experiment.evaluate_threshold(self.rankings, self.validation, threshold=4., users=[999])

    def test_missing_rankings_fail_instead_of_shrinking_the_evaluation_cohort(self):
        with self.assertRaises(ValueError):
            experiment.evaluate_threshold({1: [10]}, self.validation, threshold=4.)

    def test_unknown_recommendations_do_not_become_negative_ground_truth(self):
        rows = experiment.evaluate_threshold(
            {1: [777, 10], 3: [888, 50]}, self.validation, threshold=4.
        ).set_index("userId")
        self.assertEqual(rows.loc[1, "hits_at_10"], 1)
        self.assertEqual(rows.loc[1, "n_positives"], 2)
        self.assertEqual(rows.loc[1, "recall_at_10"], 0.5)
        self.assertAlmostEqual(rows.loc[3, "ndcg_at_10"], 1 / np.log2(3))


class NotebookBoundaryTests(unittest.TestCase):
    def test_notebook_14_and_helper_do_not_read_test_feedback_or_api_credentials(self):
        notebooks = list((ROOT / "notebooks").glob("14_*.ipynb"))
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
