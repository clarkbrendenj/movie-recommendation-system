"""Fixed-budget movie/TV policies: blend normalization, quotas, and ranking targets."""

import ast
from contextlib import redirect_stdout
import inspect
from io import StringIO
import json
from pathlib import Path
import re
import sys
import unittest

import numpy as np
import pandas as pd
from scipy import sparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import filmaffinity_ranking_policy as policy
from scripts.filmaffinity_experiment import fit_model, ranked_indices, ranking_metrics


class TrainingHistoryBinTests(unittest.TestCase):
    def test_training_tv_like_boundaries_are_inclusive(self):
        for count, expected in [(0, "0"), (1, "1-4"), (4, "1-4"), (5, "5+"), (100, "5+")]:
            with self.subTest(count=count):
                self.assertEqual(policy.tv_history_bin(count), expected)

    def test_invalid_counts_cannot_silently_select_a_history_policy(self):
        for count in [-1, 1.5, True, "1"]:
            with self.subTest(count=count), self.assertRaises(ValueError):
                policy.tv_history_bin(count)


class TelevisionBlendTests(unittest.TestCase):
    def setUp(self):
        self.personal = np.array([100., 2, 4, 0])
        self.popularity = np.array([999., 1, 0, 5])
        self.seen = np.array([True, False, False, False])

    def test_unseen_tv_maxima_and_convex_weight_match_numeric_oracles(self):
        result = policy.blended_tv_scores(self.personal, self.popularity, self.seen, alpha=0.25)
        self.assertTrue(np.isneginf(result[0]))
        np.testing.assert_allclose(result[1:], [0.275, 0.25, 0.75])
        np.testing.assert_allclose(
            policy.blended_tv_scores(self.personal, self.popularity, self.seen, alpha=0)[1:],
            [0.2, 0, 1],
        )
        np.testing.assert_allclose(
            policy.blended_tv_scores(self.personal, self.popularity, self.seen, alpha=1)[1:],
            [0.5, 1, 0],
        )
        self.assertTrue(((result[1:] >= 0) & (result[1:] <= 1)).all())

    def test_zero_components_and_no_unseen_tv_have_finite_or_excluded_results(self):
        zero = np.zeros(4)
        result = policy.blended_tv_scores(zero, self.popularity, self.seen, alpha=0.5)
        np.testing.assert_allclose(result[1:], [0.1, 0, 0.5])
        both_zero = policy.blended_tv_scores(zero, zero, self.seen, alpha=0.25)
        np.testing.assert_array_equal(both_zero[1:], [0, 0, 0])
        all_seen = policy.blended_tv_scores(self.personal, self.popularity, np.ones(4, dtype=bool), alpha=0.5)
        self.assertTrue(np.isneginf(all_seen).all())

    def test_blending_preserves_frozen_control_arrays_and_seen_mask(self):
        before = [value.copy() for value in [self.personal, self.popularity, self.seen]]
        policy.blended_tv_scores(self.personal, self.popularity, self.seen, alpha=0.5)
        for actual, expected in zip([self.personal, self.popularity, self.seen], before):
            np.testing.assert_array_equal(actual, expected)

    def test_negative_signals_invalid_weights_and_misaligned_arrays_fail(self):
        invalid = [
            ([-1, 2], [1, 2], [False, False], 0.5),
            ([1, 2], [1, -2], [False, False], 0.5),
            ([float("nan"), 2], [1, 2], [False, False], 0.5),
            ([1, 2], [1], [False, False], 0.5),
            ([1, 2], [1, 2], [False], 0.5),
            ([1, 2], [1, 2], [False, False], -0.1),
            ([1, 2], [1, 2], [False, False], 1.1),
            ([1, 2], [1, 2], [False, False], float("nan")),
        ]
        for personal, popularity, seen, alpha in invalid:
            with self.subTest(alpha=alpha, personal=personal), self.assertRaises(ValueError):
                policy.blended_tv_scores(np.array(personal), np.array(popularity), np.array(seen), alpha)


class FixedBudgetInterleavingTests(unittest.TestCase):
    def setUp(self):
        self.movies = [f"m{i}" for i in range(1, 16)]
        self.series = [f"t{i}" for i in range(1, 16)]

    def test_proportional_positions_and_two_four_six_budgets_preserve_domain_ranks(self):
        expected_four = ["m1", "m2", "t1", "m3", "t2", "m4", "m5", "t3", "m6", "t4"]
        self.assertEqual(policy.interleave_rankings(self.movies, self.series, tv_slots=4), expected_four)
        for slots in [2, 4, 6]:
            result = policy.interleave_rankings(self.movies, self.series, tv_slots=slots)
            self.assertEqual(len(result), 10)
            self.assertEqual(len(set(result)), 10)
            self.assertEqual([item for item in result if item.startswith("t")], self.series[:slots])
            self.assertEqual([item for item in result if item.startswith("m")], self.movies[:10 - slots])
            for position, item in enumerate(result):
                planned_tv = ((position + 1) * slots) // 10 > (position * slots) // 10
                self.assertEqual(item.startswith("t"), planned_tv)

    def test_shortages_are_backfilled_without_duplicate_titles_or_empty_slots(self):
        sparse_tv = policy.interleave_rankings(self.movies, ["t1"], tv_slots=4)
        self.assertEqual(len(sparse_tv), 10)
        self.assertEqual([item for item in sparse_tv if item.startswith("m")], self.movies[:9])
        sparse_movies = policy.interleave_rankings(["m1"], self.series, tv_slots=2)
        self.assertEqual(len(sparse_movies), 10)
        self.assertEqual([item for item in sparse_movies if item.startswith("t")], self.series[:9])
        short = policy.interleave_rankings(["m1", "m2"], ["t1"], tv_slots=6)
        self.assertEqual(len(short), 3)
        self.assertEqual(set(short), {"m1", "m2", "t1"})
        self.assertEqual(policy.interleave_rankings([], [], tv_slots=4), [])

    def test_duplicate_or_overlapping_identity_and_invalid_budgets_are_rejected(self):
        invalid = [(["a", "a"], ["b"], 2, 10), (["a"], ["a"], 2, 10),
                   (["a"], ["b", "b"], 2, 10), (["a"], ["b"], -1, 10),
                   (["a"], ["b"], 11, 10), (["a"], ["b"], 2.5, 10),
                   (["a"], ["b"], 2, 0)]
        for movies, series, slots, k in invalid:
            with self.subTest(slots=slots, k=k), self.assertRaises(ValueError):
                policy.interleave_rankings(movies, series, tv_slots=slots, k=k)

    def test_interleaving_is_repeatable_and_does_not_consume_source_rankings(self):
        movies_before, series_before = self.movies.copy(), self.series.copy()
        first = policy.interleave_rankings(self.movies, self.series, tv_slots=4)
        second = policy.interleave_rankings(self.movies, self.series, tv_slots=4)
        self.assertEqual(first, second)
        self.assertEqual(self.movies, movies_before)
        self.assertEqual(self.series, series_before)


class ActualMixedRankingTests(unittest.TestCase):
    def test_masked_rated_tv_is_excluded_before_slot_filling_and_ties_are_stable(self):
        ids = np.array(["watched_tv", "tv_b", "tv_a"])
        popularity = np.array([100., 2, 2])
        scores = policy.blended_tv_scores(np.array([100., 1, 1]), popularity,
                                          np.array([True, False, False]), alpha=0.5)
        columns = ranked_indices(scores, np.ones(3, dtype=bool), popularity, ids)
        self.assertEqual(ids[columns].tolist(), ["tv_a", "tv_b"])
        result = policy.interleave_rankings([f"m{i}" for i in range(1, 11)], ids[columns].tolist(), tv_slots=2)
        self.assertNotIn("watched_tv", result)
        self.assertEqual(len(result), 10)

    def test_same_actual_ten_positions_keep_unavailable_targets_and_domain_rank_discounts(self):
        ranked = policy.interleave_rankings([f"m{i}" for i in range(1, 11)],
                                            [f"t{i}" for i in range(1, 11)], tv_slots=2)
        mixed = ranking_metrics(ranked, {"m1", "t1", "missing_tv"})
        tv = ranking_metrics(ranked, {"t1", "missing_tv"})
        movie = ranking_metrics(ranked, {"m1"})
        self.assertEqual(mixed["hits"], 2)
        self.assertAlmostEqual(mixed["recall"], 2 / 3)
        self.assertEqual(tv["recall"], 0.5)
        self.assertEqual(movie["recall"], 1)
        # t1 occupies position5 in the mixed list, not position1 in a TV shelf.
        self.assertAlmostEqual(tv["ndcg"], (1 / np.log2(6)) / (1 + 1 / np.log2(3)))


class ConfirmedUnitExclusionTests(unittest.TestCase):
    def setUp(self):
        self.model = {
            "user_ids": ["fa:author-A", "fa:author-B"],
            "item_ids": ["movieA", "seriesGood", "seasonBad", "movieB"],
            "catalog": pd.DataFrame({
                "item_id": ["movieA", "seriesGood", "seasonBad", "movieB"],
                "unit": ["movie", "whole_series", "whole_series", "movie"],
                "title": ["A", "A verified series", "An independently rated season", "B"],
            }),
            "likes": sparse.csr_matrix([[1., 0, 1, 0], [0, 1, 0, 0]]),
            "seen": sparse.csr_matrix([[1., 0, 1, 1], [0, 1, 0, 0]]),
            "popularity": np.array([1., 1, 999, 0]),
            "quality": np.array([0.2, 0.3, 0.99, 0.1]),
            "features": {"cf": sparse.csr_matrix([[1., 0], [0, 1], [1, 1], [0, 0]])},
        }
        self.validation = pd.DataFrame([
            ("fa:author-A", "seriesGood", 7, "whole_series"),
            ("fa:author-A", "seasonBad", 8, "whole_series"),
            ("fa:author-B", "seasonBad", 2, "whole_series"),
            ("fa:author-B", "movieB", 9, "movie"),
        ], columns=["user_id", "item_id", "rating", "unit"])

    def test_confirmed_wrong_units_are_removed_from_profiles_candidates_and_validation(self):
        cleaned, validation, summary = policy.apply_unit_exclusions(self.model, self.validation, ["seasonBad"])
        self.assertIsInstance(summary, dict)
        np.testing.assert_array_equal(cleaned["likes"].toarray(), [[1, 0, 0, 0], [0, 1, 0, 0]])
        self.assertTrue(cleaned["seen"].toarray()[:, 2].astype(bool).all())
        np.testing.assert_array_equal(cleaned["eligible_mask"], [True, True, False, True])
        self.assertEqual(cleaned["item_ids"], self.model["item_ids"])
        self.assertEqual(cleaned["catalog"].item_id.tolist(), self.model["item_ids"])
        self.assertEqual(cleaned["features"]["cf"].shape, self.model["features"]["cf"].shape)
        self.assertEqual(validation.item_id.tolist(), ["seriesGood", "movieB"])
        self.assertEqual(validation.rating.tolist(), [7, 9])
        tv_mask = cleaned["catalog"].unit.eq("whole_series").to_numpy()
        self.assertEqual(policy.tv_history_bin(int(cleaned["likes"][0, tv_mask].sum())), "0")
        # Even a huge old popularity count cannot restore the excluded season.
        tv_scores = policy.blended_tv_scores(np.array([1., 100]), cleaned["popularity"][tv_mask],
                                             cleaned["seen"].toarray()[0, tv_mask].astype(bool), alpha=0)
        self.assertTrue(np.isneginf(tv_scores[1]))

    def test_cleanup_preserves_original_frozen_model_and_validation_data(self):
        likes_before, seen_before = self.model["likes"].copy(), self.model["seen"].copy()
        catalog_before, validation_before = self.model["catalog"].copy(deep=True), self.validation.copy(deep=True)
        popularity_before, quality_before = self.model["popularity"].copy(), self.model["quality"].copy()
        feature_before = self.model["features"]["cf"].copy()
        cleaned, _, _ = policy.apply_unit_exclusions(self.model, self.validation, ["seasonBad"])
        self.assertIsNot(cleaned, self.model)
        self.assertNotIn("eligible_mask", self.model)
        self.assertEqual((likes_before != self.model["likes"]).nnz, 0)
        self.assertEqual((seen_before != self.model["seen"]).nnz, 0)
        self.assertEqual((feature_before != self.model["features"]["cf"]).nnz, 0)
        np.testing.assert_array_equal(popularity_before, self.model["popularity"])
        np.testing.assert_array_equal(quality_before, self.model["quality"])
        pd.testing.assert_frame_equal(catalog_before, self.model["catalog"])
        pd.testing.assert_frame_equal(validation_before, self.validation)


class EndToEndPolicyTests(unittest.TestCase):
    def test_all_policies_keep_fixed_cohorts_and_match_persistable_personal_inference(self):
        ids = [f"m{i:02d}" for i in range(10)] + [f"t{i:02d}" for i in range(10)]
        catalog = pd.DataFrame({
            "item_id": ids, "title": ids, "original_title": ids, "year": [2000] * 20,
            "unit": ["movie"] * 10 + ["whole_series"] * 10, "confidence": ["medium"] * 20,
            "synopsis": ["Una historia de misterio en la ciudad."] * 10
                        + ["Una serie de misterio en la ciudad."] * 10,
            "film_genre": ["['Misterio']"] * 20, "film_cast": ["['Actor One']"] * 20,
        })
        events = [("fa:A", "m00", 9), ("fa:A", "t00", 8), ("fa:A", "t01", 2),
                  ("fa:B", "m01", 8), ("fa:B", "t00", 1),
                  ("fa:C", "t01", 10), ("fa:C", "m00", 3)]
        # Neutral observed feedback keeps every fixture title in the train catalog.
        events += [("fa:catalog_seed", item, 5) for item in ids]
        train = pd.DataFrame(events, columns=["user_id", "item_id", "rating"])
        model = fit_model(train, catalog)
        model["best_personalized_variant"] = {
            "model": "Synthetic frozen hybrid", "kind": "hybrid", "plot": 0.25,
            "metadata": 0.25, "quality": 0.1,
        }
        validation = pd.DataFrame([
            ("fa:A", "m02", 8, "movie"), ("fa:A", "t02", 9, "whole_series"),
            ("fa:A", "missing_tv", 10, "whole_series"), ("fa:A", "t09", 8, "whole_series"),
            ("fa:B", "m00", 8, "movie"), ("fa:B", "missing_movie", 9, "movie"),
            ("fa:C", "t00", 8, "whole_series"),
        ], columns=["user_id", "item_id", "rating", "unit"])
        model, validation, _ = policy.apply_unit_exclusions(model, validation, ["t09"])
        policies = policy.policy_grid()
        with redirect_stdout(StringIO()):
            board, shelf_board, per_user, shelves, _, coverage, examples = policy.evaluate_policies(
                model, validation, policies
            )
        self.assertEqual(len(policies), 17)
        self.assertEqual(len(board), 17)
        self.assertEqual(len(per_user), 17 * 3)
        self.assertTrue(board.mixed_users.eq(3).all())
        self.assertTrue(board.movie_users.eq(2).all())
        self.assertTrue(board.tv_users.eq(2).all())
        self.assertTrue(shelf_board.tv_users.eq(2).all())
        self.assertTrue(shelf_board.movie_users.eq(2).all())
        self.assertEqual(len(shelves), 5 * 3)
        self.assertTrue(per_user.loc[per_user.user_id.eq("fa:B"), "tv_recall_at_10"].isna().all())
        self.assertTrue(per_user.loc[per_user.user_id.eq("fa:C"), "movie_recall_at_10"].isna().all())
        self.assertTrue(per_user.loc[per_user.user_id.eq("fa:B"), "history_bin"].eq("0").all())
        tv_coverage = coverage.loc[coverage.task.eq("whole_series")].set_index("user_id")
        self.assertEqual(tv_coverage.loc["fa:A", "positives"], 2)
        self.assertEqual(tv_coverage.loc["fa:A", "available"], 1)
        positives = {"fa:A": {"m02", "t02", "missing_tv"},
                     "fa:B": {"m00", "missing_movie"}, "fa:C": {"t00"}}
        for chosen in policies:
            for user, relevant in positives.items():
                history = train.loc[train.user_id.eq(user) & train.item_id.ne("t09")]
                ratings = history.set_index("item_id").rating.to_dict()
                result = policy.recommend_policy({"model": model, "policy": chosen}, ratings)
                ranked = result.item_id.tolist()
                self.assertEqual(len(ranked), 10)
                self.assertEqual(len(set(ranked)), 10)
                self.assertNotIn("t09", ranked)
                self.assertTrue(set(ranked).isdisjoint(ratings))
                saved = examples.loc[examples.policy.eq(chosen["policy"]) & examples.user_id.eq(user)]
                self.assertEqual(ranked, saved.sort_values("rank").item_id.tolist())
                metrics = per_user.loc[per_user.policy.eq(chosen["policy"]) & per_user.user_id.eq(user)].iloc[0]
                self.assertAlmostEqual(metrics.mixed_recall_at_10, len(set(ranked) & relevant) / len(relevant))
                if chosen["kind"] == "allocated":
                    self.assertEqual(int(result.unit.eq("whole_series").sum()), chosen["tv_slots"])


class NotebookBoundaryTests(unittest.TestCase):
    def test_notebook_and_helper_do_not_read_test_feedback_or_paid_api_credentials(self):
        notebooks = list((ROOT / "notebooks").glob("18_*.ipynb"))
        self.assertEqual(len(notebooks), 1)
        notebook = json.loads(notebooks[0].read_text(encoding="utf-8"))
        code = "\n".join("".join(cell["source"]) for cell in notebook["cells"]
                         if cell["cell_type"] == "code")
        for source in [code, inspect.getsource(policy)]:
            tree = ast.parse(source)
            self.assertNotIn("OPENAI_API_KEY", source)
            self.assertNotIn("OpenAI(", source)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    if node.func.attr in {"read_csv", "read_parquet"}:
                        strings = [value.value for arg in node.args for value in ast.walk(arg)
                                   if isinstance(value, ast.Constant) and isinstance(value.value, str)]
                        self.assertFalse(any(re.search(r"(?:^|[/_\\])test(?:[_.\\]|$)", value)
                                             for value in strings), strings)


if __name__ == "__main__":
    unittest.main()
