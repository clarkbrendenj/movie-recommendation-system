"""FilmAffinity experiment: date-group splits, ranking denominators, train-only prior."""

import ast
import inspect
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
from scripts import filmaffinity_experiment as experiment
from scripts import filmaffinity_diagnostics as diagnostics


def dated_history(user, counts):
    rows, item = [], 0
    for day, count in enumerate(counts, 1):
        for _ in range(count):
            rows.append({"user_id": user, "item_id": f"fa:film{item}",
                         "rating": 1 + item % 10, "rated_at": f"2024-01-{day:02d}T00:00:00Z"})
            item += 1
    return rows


class ReviewDateSplitTests(unittest.TestCase):
    def setUp(self):
        self.ratings = pd.DataFrame(
            dated_history("fa:uA", [3, 5, 2, 2])
            + dated_history("fa:uB", [7, 2, 1])
            + dated_history("fa:too_few_dates", [5, 5])
            + dated_history("fa:too_few_ratings", [3, 3, 3])
        )

    def test_nearest_count_cuts_preserve_tied_dates_and_nonempty_partitions(self):
        train, validation, heldout, _ = experiment.split_by_review_date(self.ratings)
        expected = {"fa:uA": (8, 2, 2), "fa:uB": (7, 2, 1)}
        for user, counts in expected.items():
            parts = [frame.loc[frame.user_id.eq(user)] for frame in [train, validation, heldout]]
            self.assertEqual(tuple(len(part) for part in parts), counts)
            dates = [pd.to_datetime(part.rated_at, utc=True) for part in parts]
            self.assertLess(dates[0].max(), dates[1].min())
            self.assertLess(dates[1].max(), dates[2].min())
        self.assertEqual(set(train.user_id), set(expected))
        self.assertEqual(set(validation.user_id), set(expected))
        self.assertEqual(set(heldout.user_id), set(expected))

    def test_eligible_events_appear_once_and_holdout_pairs_never_overlap_training(self):
        train, validation, heldout, _ = experiment.split_by_review_date(self.ratings)
        combined = pd.concat([train, validation, heldout], ignore_index=True)
        self.assertEqual(len(combined), 22)
        self.assertFalse(combined.duplicated(["user_id", "item_id"]).any())
        train_pairs = set(zip(train.user_id, train.item_id))
        self.assertTrue(train_pairs.isdisjoint(zip(validation.user_id, validation.item_id)))
        self.assertTrue(train_pairs.isdisjoint(zip(heldout.user_id, heldout.item_id)))
        # Shared titles across different users are legitimate collaborative data.
        self.assertGreater(len(set(train.item_id) & set(validation.item_id)), 0)

    def test_split_identity_is_deterministic_and_does_not_depend_on_rating_values(self):
        original = self.ratings.copy(deep=True)
        first = experiment.split_by_review_date(self.ratings)[:3]
        changed = self.ratings.sample(frac=1, random_state=17).copy()
        changed["rating"] = 10
        second = experiment.split_by_review_date(changed)[:3]
        for left, right in zip(first, second):
            self.assertEqual(set(zip(left.user_id, left.item_id)), set(zip(right.user_id, right.item_id)))
        pd.testing.assert_frame_equal(self.ratings, original)

    def test_duplicate_user_title_events_fail_before_they_can_cross_partitions(self):
        duplicated = pd.concat([self.ratings, self.ratings.iloc[[0]]], ignore_index=True)
        with self.assertRaises(ValueError):
            experiment.split_by_review_date(duplicated)


class RankingMetricTests(unittest.TestCase):
    def test_unavailable_positives_remain_in_recall_and_ideal_dcg_denominators(self):
        result = experiment.ranking_metrics(["unknown", "hitB", "hitA"], {"hitA", "hitB", "unavailable"})
        self.assertEqual(result["hits"], 2)
        self.assertAlmostEqual(result["recall"], 2 / 3)
        expected = (1 / np.log2(3) + 1 / np.log2(4)) / (1 + 1 / np.log2(3) + 1 / np.log2(4))
        self.assertAlmostEqual(result["ndcg"], expected)

    def test_no_recommendations_are_zero_and_unobserved_titles_do_not_change_targets(self):
        empty = experiment.ranking_metrics([], {"known"})
        self.assertEqual(empty, {"recall": 0., "ndcg": 0., "hits": 0})
        miss = experiment.ranking_metrics(["unobserved"], {"known"})
        self.assertEqual(miss["hits"], 0)
        self.assertEqual(miss["recall"], 0)

    def test_duplicate_recommendations_cannot_inflate_hits(self):
        with self.assertRaises(ValueError):
            experiment.ranking_metrics(["known", "known"], {"known"})


class TrainingQualityPriorTests(unittest.TestCase):
    def setUp(self):
        self.train = pd.DataFrame([
            ("u1", "a", 10), ("u2", "a", 8), ("u1", "b", 1), ("u2", "b", 5),
        ], columns=["user_id", "item_id", "rating"])

    def test_training_only_bayesian_means_use_requested_candidate_order(self):
        before = self.train.copy(deep=True)
        actual = experiment.quality_prior(self.train, ["b", "unknown", "a"], strength=2)
        # Training center is 6; posteriors b=4.5, missing=6, a=7.5.
        np.testing.assert_allclose(actual, np.array([3.5, 5, 6.5]) / 9)
        self.assertTrue(np.isfinite(actual).all())
        self.assertTrue(((actual >= 0) & (actual <= 1)).all())
        pd.testing.assert_frame_equal(self.train, before)

    def test_global_center_includes_training_rows_outside_requested_candidates(self):
        train = pd.concat([self.train, pd.DataFrame([("u3", "other", 10)], columns=self.train.columns)])
        actual = experiment.quality_prior(train, ["a", "unknown"], strength=2)
        # Global center is 6.8, so a shrinks to (18 + 2*6.8)/4 = 7.9.
        np.testing.assert_allclose(actual, np.array([6.9, 5.8]) / 9)

    def test_weaker_supported_quality_is_shrunk_more_toward_the_training_mean(self):
        weak = experiment.quality_prior(self.train, ["a"], strength=2)[0]
        stronger = experiment.quality_prior(self.train, ["a"], strength=20)[0]
        self.assertGreater(weak, stronger)
        self.assertGreater(stronger, (6 - 1) / 9)


def tiny_catalog():
    return pd.DataFrame({
        "item_id": ["a", "b", "c", "d"], "title": ["A", "B", "C", "D"],
        "original_title": ["A", "B", "C", "D"], "year": [2000, 2001, 2002, 2003],
        "unit": ["movie", "movie", "whole_series", "whole_series"], "confidence": ["medium"] * 4,
        "synopsis": ["Una médica trabaja en un hospital de Madrid.",
                     "La médica dirige un hospital de Madrid.", None, "Una expedición galáctica."],
        "film_genre": ["['Drama']", "['Drama', 'Misterio']", "[]", "['Ciencia ficción']"],
        "film_cast": ["[' Actor One ', 'Actor Two', 'Actor Three', 'Actor Four', 'Actor Five', 'Ignored Sixth']",
                      "['actor one', 'ACTOR TWO', 'actor three', 'actor four', 'actor five']", "[]", None],
    })


class ContentAndCollaborativeFeatureTests(unittest.TestCase):
    def test_content_features_preserve_missing_rows_and_first_five_cast_identity(self):
        catalog = tiny_catalog()
        before = catalog.copy(deep=True)
        content = experiment.build_content_features(catalog)
        for name in ["synopsis", "genres", "cast"]:
            self.assertTrue(sparse.issparse(content[name]))
            self.assertEqual(content[name].shape[0], len(catalog))
            self.assertTrue(np.isfinite(content[name].data).all())
            self.assertEqual(content[name][2].nnz, 0)
        self.assertGreater(float((content["synopsis"][0] @ content["synopsis"][1].T).toarray()[0, 0]), 0)
        np.testing.assert_allclose(content["cast"][0].toarray(), content["cast"][1].toarray())
        self.assertNotIn("ignored sixth", set(content["encoders"]["cast"].classes_))
        pd.testing.assert_frame_equal(catalog, before)

    def test_empty_content_is_zero_instead_of_failing_vocabulary_fitting(self):
        catalog = tiny_catalog()
        catalog["synopsis"] = None
        catalog["film_genre"] = "[]"
        catalog["film_cast"] = None
        content = experiment.build_content_features(catalog)
        for name in ["synopsis", "genres", "cast"]:
            self.assertEqual(content[name].shape[0], len(catalog))
            self.assertEqual(content[name].nnz, 0)

    def test_fitted_cf_uses_binary_training_likes_and_marks_low_ratings_seen(self):
        train = pd.DataFrame([
            ("uA", "a", 8), ("uA", "b", 2), ("uB", "a", 10),
            ("uB", "b", 7), ("uB", "c", 9), ("uB", "d", 1),
        ], columns=["user_id", "item_id", "rating"])
        model = experiment.fit_model(train, tiny_catalog())
        np.testing.assert_array_equal(model["likes"].toarray(), [[1, 0, 0, 0], [1, 0, 1, 0]])
        np.testing.assert_array_equal(model["seen"].toarray(), [[1, 1, 0, 0], [1, 1, 1, 1]])
        np.testing.assert_allclose(model["features"]["cf"].toarray(),
                                   [[1 / np.sqrt(2), 1 / np.sqrt(2)], [0, 0], [0, 1], [0, 0]], atol=1e-7)
        np.testing.assert_array_equal(model["popularity"], [2, 0, 1, 0])


class ScoringAndInferenceTests(unittest.TestCase):
    def setUp(self):
        catalog = pd.DataFrame({
            "item_id": ["a", "b", "c", "d", "e"], "title": list("ABCDE"),
            "original_title": list("ABCDE"), "year": [2000] * 5,
            "unit": ["movie", "movie", "whole_series", "whole_series", "whole_series"],
            "confidence": ["medium"] * 5,
        })
        self.model = {
            "item_ids": catalog.item_id.tolist(), "catalog": catalog,
            "features": {
                "cf": sparse.csr_matrix([[1., 0], [0.8, 0.6], [0.6, 0.8], [0, 1], [0, 0]], dtype=np.float32),
                "synopsis": sparse.csr_matrix([[1., 0], [0.6, 0.8], [0.8, 0.6], [0, 1], [1, 0]], dtype=np.float32),
                "genres": sparse.csr_matrix([[1., 0], [1, 0], [0, 1], [0, 1], [0, 0]], dtype=np.float32),
                "cast": sparse.csr_matrix([[1., 0], [0, 1], [1, 0], [0, 1], [0, 0]], dtype=np.float32),
            },
            "popularity": np.array([100., 3, 2, 50, 1]), "quality": np.array([0., 0.2, 0.1, 0.3, 0.9]),
            "like_threshold": 8, "top_k": 10,
            "selected_variant": {"kind": "hybrid", "plot": 0.25, "metadata": 0.25, "quality": 0.1},
        }
        self.profile = sparse.csr_matrix([[1., 0, 0, 0, 0]], dtype=np.float32)
        self.seen = np.array([[True, False, False, True, False]])

    def test_components_and_additive_hybrid_match_independent_numeric_oracles(self):
        components = experiment.component_scores(self.model, self.profile, self.seen)
        np.testing.assert_allclose(components["cf"], [[0, 1, 0.75, 0, 0]], atol=1e-7)
        np.testing.assert_allclose(components["synopsis"], [[0, 0.6, 0.8, 0, 1]], atol=1e-7)
        np.testing.assert_allclose(components["metadata"], [[0, 0.5, 0.5, 0, 0]], atol=1e-7)
        scores = experiment.blend_scores(self.model, components, self.model["selected_variant"], self.seen,
                                         np.array([False]))
        np.testing.assert_allclose(scores[0, [1, 2, 4]], [1.295, 1.085, 0.34], atol=2e-7)
        self.assertTrue(np.isneginf(scores[0, [0, 3]]).all())

    def test_no_like_profile_falls_back_to_training_popularity_and_retains_exclusions(self):
        empty = sparse.csr_matrix((1, 5), dtype=np.float32)
        components = experiment.component_scores(self.model, empty, self.seen)
        scores = experiment.blend_scores(self.model, components, self.model["selected_variant"], self.seen,
                                         np.array([True]))
        np.testing.assert_array_equal(scores[0, [1, 2, 4]], [3, 2, 1])
        self.assertTrue(np.isneginf(scores[0, [0, 3]]).all())

    def test_topk_boundary_ties_use_popularity_then_id_and_respect_the_task_mask(self):
        scores = np.array([-np.inf, 0.8, 0.9, 0.9, 0.9, 0.7])
        ids = np.array(["seen", "b", "d", "c", "z", "low"])
        popularity = np.array([100, 5, 5, 5, 6, 99])
        actual = experiment.ranked_indices(scores, np.ones(6, dtype=bool), popularity, ids, k=2)
        np.testing.assert_array_equal(actual, [4, 3])
        restricted = experiment.ranked_indices(scores, np.array([True, False, True, False, True, False]),
                                               popularity, ids, k=10)
        np.testing.assert_array_equal(restricted, [4, 2])

    def test_real_inference_uses_eight_cutoff_seen_exclusion_and_whole_series_filter(self):
        result = experiment.recommend(self.model, {"a": 8, "d": 1}, k=3)
        self.assertEqual(result.item_id.tolist(), ["b", "c", "e"])
        np.testing.assert_allclose(result.score.to_numpy(), [1.295, 1.085, 0.34], atol=2e-7)
        tv = experiment.recommend(self.model, {"a": 8, "d": 1}, kind="whole_series")
        self.assertEqual(tv.item_id.tolist(), ["c", "e"])
        self.assertTrue(tv.unit.eq("whole_series").all())
        below_cutoff = experiment.recommend(self.model, {"a": 7.99, "d": 1})
        self.assertEqual(below_cutoff.item_id.tolist(), ["b", "c", "e"])
        np.testing.assert_array_equal(below_cutoff.score.to_numpy(), [3, 2, 1])

    def test_unknown_or_invalid_personal_ratings_fail_instead_of_becoming_empty_profiles(self):
        for ratings in [{"unknown": 8}, {"a": 0}, {"a": 11}, {"a": float("nan")}]:
            with self.subTest(ratings=ratings), self.assertRaises(ValueError):
                experiment.recommend(self.model, ratings)


class PostSelectionDiagnosticTests(unittest.TestCase):
    def setUp(self):
        ScoringAndInferenceTests.setUp(self)
        self.targets = {
            "mixed": {"fa:author-A": {"b", "c", "missing"}, "fa:author-B": {"b"},
                      "fa:author-C": {"c"}},
            "movie": {"fa:author-A": {"b"}, "fa:author-B": {"b"}},
            "whole_series": {"fa:author-A": {"c", "missing"}, "fa:author-C": {"c"}},
        }

    def row(self, user, empty=False, seen=None):
        profile = sparse.csr_matrix((1, 5), dtype=np.float32) if empty else self.profile
        seen = self.seen[0] if seen is None else seen
        components = experiment.component_scores(self.model, profile, seen[None, :])
        scores = experiment.blend_scores(self.model, components, self.model["selected_variant"],
                                         seen[None, :], np.array([empty]))
        return diagnostics._user_row(
            self.model, user, profile, seen, scores[0], np.array(self.model["item_ids"]),
            self.model["catalog"].unit.eq("whole_series").to_numpy(), self.targets,
        )

    def test_one_actual_mixed_list_preserves_source_user_ids_and_full_domain_targets(self):
        row = self.row("fa:author-A")
        self.assertEqual(row["user_id"], "fa:author-A")
        self.assertEqual(row["mixed_list_length"], 3)  # Seen a/d are excluded.
        self.assertEqual(row["mixed_hits"], 2)
        self.assertAlmostEqual(row["mixed_recall_at_10"], 2 / 3)
        self.assertEqual(row["tv_from_mixed_hits_at_10"], 1)
        self.assertEqual(row["tv_from_mixed_recall_at_10"], 0.5)
        self.assertEqual(row["movie_from_mixed_recall_at_10"], 1)
        self.assertEqual(row["available_validation_tv_likes"], 1)
        self.assertEqual(row["mixed_top10_tv_count"], 2)
        self.assertAlmostEqual(row["mixed_top10_tv_share"], 2 / 3)
        # c is second in the actual mixed list, but first in a separate TV list.
        self.assertAlmostEqual(row["tv_from_mixed_ndcg_at_10"],
                               (1 / np.log2(3)) / (1 + 1 / np.log2(3)))
        self.assertAlmostEqual(row["tv_only_ndcg_at_10"], 1 / (1 + 1 / np.log2(3)))

    def test_domain_cohorts_omit_users_without_targets_and_count_no_like_profiles(self):
        rows = [self.row("fa:author-A"),
                self.row("fa:author-B", empty=True, seen=np.zeros(5, dtype=bool)),
                self.row("fa:author-C", empty=True)]
        self.assertTrue(np.isnan(rows[1]["tv_from_mixed_recall_at_10"]))
        summary = diagnostics._summarize(pd.DataFrame(rows), {"model": "Synthetic fixed model"}, ["test"])
        exposure = summary["mixed_exposure"]["all_validation_positive_users"]
        self.assertEqual(exposure["users"], 3)
        self.assertAlmostEqual(exposure["pooled_tv_share_at_10"], 7 / 11)
        domain = summary["domain_recall_from_actual_mixed_top10"]
        self.assertEqual(domain["whole_series"]["users"], 2)
        self.assertEqual(domain["whole_series"]["recall_at_10"], 0.75)
        self.assertEqual(domain["movie"]["users"], 2)
        self.assertEqual(domain["movie"]["recall_at_10"], 1)
        groups = {row["cohort"]: row for row in summary["tv_only_by_training_tv_profile"]}
        zero_tv = groups["zero_training_tv_likes"]
        self.assertEqual(zero_tv["users"], 2)
        self.assertEqual(zero_tv["users_without_any_training_likes"], 1)
        self.assertEqual(zero_tv["users_with_training_movie_likes"], 1)
        self.assertEqual(groups["zero_training_tv_likes_with_movie_likes"]["users"], 1)
        empty = groups["at_least_one_training_tv_like"]
        self.assertEqual(empty["users"], 0)
        self.assertIsNone(empty["tv_only_recall_at_10"])


class NotebookBoundaryTests(unittest.TestCase):
    def test_notebook_and_helper_do_not_read_heldout_files_or_paid_api_credentials(self):
        notebooks = list((ROOT / "notebooks").glob("17_*.ipynb"))
        self.assertEqual(len(notebooks), 1)
        notebook = json.loads(notebooks[0].read_text(encoding="utf-8"))
        code = "\n".join("".join(cell["source"]) for cell in notebook["cells"]
                         if cell["cell_type"] == "code")
        for source in [code, inspect.getsource(experiment)]:
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
