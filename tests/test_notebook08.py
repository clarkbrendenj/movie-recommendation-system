"""Numerical and evaluation checks for notebook 08, without running its search."""

import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd
from scipy.linalg import cho_factor, cho_solve
from scipy.special import expit


def load_definitions():
    path = (
        Path(__file__).resolve().parents[1]
        / "notebooks"
        / "08_learned_collaborative_filtering.ipynb"
    )
    notebook = json.loads(path.read_text(encoding="utf-8"))
    namespace = {
        "np": np,
        "pd": pd,
        "cho_factor": cho_factor,
        "cho_solve": cho_solve,
        "expit": expit,
    }
    required = {"bpr-definitions", "ease-definitions", "evaluation-functions"}
    found = set()
    for cell in notebook["cells"]:
        if cell.get("id") in required:
            exec(compile("".join(cell["source"]), f"{path}:{cell['id']}", "exec"), namespace)
            found.add(cell["id"])
    if found != required:
        raise AssertionError(f"Missing notebook definition cells: {required - found}")
    return namespace


FUNCTIONS = load_definitions()


class BPRTests(unittest.TestCase):
    def test_gradients_match_finite_differences_with_repeated_indices(self):
        rng = np.random.default_rng(5)
        user_factors = rng.normal(size=(3, 2))
        item_factors = rng.normal(size=(4, 2))
        users = np.array([0, 0, 1, 1, 0])
        positives = np.array([0, 1, 1, 2, 0])
        negatives = np.array([2, 2, 3, 0, 3])
        regularization = 0.07

        def independent_objective():
            total = 0.0
            for user, positive, negative in zip(users, positives, negatives):
                u, i, j = user_factors[user], item_factors[positive], item_factors[negative]
                total += np.logaddexp(0.0, -(u @ (i - j)))
                total += regularization / 2 * (u @ u + i @ i + j @ j)
            return total / len(users)

        loss, grad_users, grad_items = FUNCTIONS["bpr_loss_gradients"](
            user_factors, item_factors, users, positives, negatives, regularization
        )
        self.assertAlmostEqual(loss, independent_objective(), places=12)
        epsilon = 1e-6
        for parameter, analytical in [(user_factors, grad_users), (item_factors, grad_items)]:
            numerical = np.zeros_like(parameter)
            for index in np.ndindex(parameter.shape):
                original = parameter[index]
                parameter[index] = original + epsilon
                upper = independent_objective()
                parameter[index] = original - epsilon
                lower = independent_objective()
                parameter[index] = original
                numerical[index] = (upper - lower) / (2 * epsilon)
            np.testing.assert_allclose(analytical, numerical, atol=2e-9, rtol=2e-7)

    def test_negative_sampler_excludes_likes_and_rejects_full_positive_users(self):
        feedback = np.array([[1, 0, 1, 0], [0, 1, 0, 0]], dtype=float)
        users = np.tile([0, 1], 300)
        sampler = FUNCTIONS["sample_bpr_negatives"]
        first = sampler(feedback, users, np.random.default_rng(8))
        second = sampler(feedback, users, np.random.default_rng(8))
        np.testing.assert_array_equal(first, second)
        self.assertTrue((feedback[users, first] == 0).all())
        self.assertEqual(set(first[users == 0]), {1, 3})
        with self.assertRaisesRegex(ValueError, "alternatives"):
            sampler(np.ones((1, 4)), np.array([0]), np.random.default_rng(8))

    def test_training_learns_toy_preferences_and_is_repeatable(self):
        feedback = np.array([
            [1, 1, 0, 0],
            [1, 1, 0, 0],
            [0, 0, 1, 1],
            [0, 0, 1, 1],
            [0, 0, 0, 0],
        ], dtype=float)

        def train():
            snapshots = []
            for epoch, users, items, loss in FUNCTIONS["bpr_training_epochs"](
                feedback, factors=3, regularization=0.001, epochs=60,
                learning_rate=0.03, batch_size=4, seed=13,
            ):
                if epoch in (1, 60):
                    snapshots.append((users.copy(), items.copy(), loss))
            return snapshots

        first, second = train(), train()
        self.assertLess(first[-1][2], 0.4 * first[0][2])
        users, items, _ = first[-1]
        scores = users @ items.T
        for row in range(4):
            self.assertGreater(scores[row, feedback[row] == 1].min(),
                               scores[row, feedback[row] == 0].max())
        np.testing.assert_array_equal(users[-1], np.zeros(3))
        for left, right in zip(first, second):
            np.testing.assert_array_equal(left[0], right[0])
            np.testing.assert_array_equal(left[1], right[1])
            self.assertEqual(left[2], right[2])


class EASETests(unittest.TestCase):
    def test_dual_scores_match_independent_constrained_ridge_regressions(self):
        feedback = np.array([
            [1, 1, 0, 0, 0],
            [1, 0, 1, 0, 0],
            [0, 1, 1, 1, 0],
            [0, 0, 0, 0, 0],
        ], dtype=float)
        for regularization in (0.1, 2.0, 100.0):
            with self.subTest(regularization=regularization):
                expected = np.zeros_like(feedback)
                # Each target is regressed only on the other columns. This
                # independently enforces EASE's no-self-reconstruction constraint.
                for target in range(feedback.shape[1]):
                    others = np.arange(feedback.shape[1]) != target
                    predictors = feedback[:, others]
                    coefficients = np.linalg.solve(
                        predictors.T @ predictors
                        + regularization * np.eye(predictors.shape[1]),
                        predictors.T @ feedback[:, target],
                    )
                    expected[:, target] = predictors @ coefficients
                actual = FUNCTIONS["ease_training_user_scores"](feedback, regularization)
                np.testing.assert_allclose(actual, expected, atol=2e-13, rtol=1e-11)
                np.testing.assert_allclose(actual[-1], 0.0, atol=1e-13)
                np.testing.assert_allclose(actual[:, -1], 0.0, atol=1e-13)

    def test_regularization_must_be_positive(self):
        for value in (0.0, -1.0):
            with self.assertRaises(ValueError):
                FUNCTIONS["ease_training_user_scores"](np.eye(2), value)


class RankingTests(unittest.TestCase):
    def test_seen_exclusion_signed_scores_and_tie_order(self):
        movie_ids = np.array([60, 40, 30, 20, 10])
        scores = np.array([10.0, -0.2, -0.2, -0.2, -0.5])
        popularity = np.array([99, 5, 7, 7, 100])
        seen = np.array([True, False, False, False, False])
        columns = FUNCTIONS["rank_candidates"](scores, movie_ids, popularity, seen, k=10)
        np.testing.assert_array_equal(movie_ids[columns], [20, 30, 40, 10])

    def test_no_like_history_uses_popularity_fallback(self):
        movie_ids = np.array([40, 30, 20, 10])
        scores = np.array([100.0, -20.0, -30.0, -40.0])
        popularity = np.array([1, 7, 7, 100])
        seen = np.array([False, False, False, True])
        columns = FUNCTIONS["rank_candidates"](
            scores, movie_ids, popularity, seen, has_likes=False, k=2
        )
        np.testing.assert_array_equal(movie_ids[columns], [20, 30])

    def test_recall_and_ndcg_retain_unavailable_heldout_positives(self):
        hits, recall, ndcg = FUNCTIONS["ranking_metrics"]([10, 30, 20], {10, 20, 999}, k=3)
        self.assertEqual(hits, 2)
        self.assertAlmostEqual(recall, 2 / 3)
        expected_dcg = 1.0 + 1.0 / np.log2(4)
        expected_idcg = 1.0 + 1.0 / np.log2(3) + 1.0 / np.log2(4)
        self.assertAlmostEqual(ndcg, expected_dcg / expected_idcg)
        self.assertLess(ndcg, 1.0)

    def test_invalid_scores_and_duplicate_recommendations_are_rejected(self):
        with self.assertRaises(ValueError):
            FUNCTIONS["rank_candidates"](
                np.array([np.nan]), np.array([1]), np.array([1]), np.array([False])
            )
        with self.assertRaises(ValueError):
            FUNCTIONS["ranking_metrics"]([1, 1], {1}, k=2)


if __name__ == "__main__":
    unittest.main()
