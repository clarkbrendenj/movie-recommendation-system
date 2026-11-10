"""Independent numerical checks for training and ranking separate movie/TV shelves."""

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
from scripts import filmaffinity_domain_models as domain
from scripts import filmaffinity_separate_rankers as study
from scripts.filmaffinity_experiment import component_scores, blend_scores, ranked_indices, ranking_metrics


def training_fixture():
    catalog = pd.DataFrame({
        "item_id": ["m0", "m1", "t0", "t1"],
        "title": ["Movie zero", "Movie one", "Series zero", "Series one"],
        "original_title": ["M0", "M1", "T0", "T1"],
        "unit": ["movie", "movie", "whole_series", "whole_series"],
        "synopsis": ["misterio urbano común pista", "misterio urbano común detective",
                     "dragones reino común magia", "dragones reino común trono"],
        "film_genre": ["['Misterio']", "['Misterio']", "['Fantasía']", "['Fantasía']"],
        "film_cast": ["['Movie Actor']", "['Movie Actor']", "['TV Actor']", "['TV Actor']"],
    })
    train = pd.DataFrame([
        ("fa:A", "m0", 10), ("fa:A", "t0", 8), ("fa:A", "m1", 2),
        ("fa:B", "m0", 1), ("fa:B", "t1", 9), ("fa:D", "t0", 4),
    ], columns=["user_id", "item_id", "rating"])
    users = ["fa:D", "fa:C", "fa:A", "fa:B"]
    return train, catalog, users


class TrainingBasisTests(unittest.TestCase):
    def test_type_refit_preserves_user_namespace_and_binary_cf_item_vectors(self):
        train, catalog, users = training_fixture()
        joint = domain.fit_training_basis(train, catalog, users)
        movie_rows = catalog.unit.eq("movie")
        movies = domain.fit_training_basis(train.loc[train.item_id.isin(["m0", "m1"])],
                                            catalog.loc[movie_rows], users)
        self.assertEqual(joint["user_ids"], users)
        self.assertEqual(movies["user_ids"], users)
        self.assertEqual(movies["item_ids"], ["m0", "m1"])
        self.assertEqual(movies["likes"].shape, (4, 2))
        self.assertEqual(movies["features"]["cf"].shape, (2, 4))
        np.testing.assert_array_equal(movies["features"]["cf"].toarray(),
                                      joint["features"]["cf"][:2].toarray())
        # fa:C has no observations; fa:D only has a low TV rating. Both retain rows.
        self.assertEqual(movies["seen"][:2].nnz, 0)
        self.assertEqual(joint["likes"][:2].nnz, 0)
        np.testing.assert_array_equal(joint["popularity"], [1, 0, 1, 1])
        self.assertEqual(joint["seen"][2, 1], 1)
        self.assertEqual(joint["likes"][2, 1], 0)

    def test_type_prior_uses_only_its_training_ratings_with_exact_shrinkage(self):
        train, catalog, users = training_fixture()
        movie_ids = ["m0", "m1"]
        movie_train = train.loc[train.item_id.isin(movie_ids)]
        model = domain.fit_training_basis(movie_train, catalog.iloc[:2], users)
        center = 13 / 3
        expected = (np.array([(11 + 20 * center) / 22,
                              (2 + 20 * center) / 21]) - 1) / 9
        np.testing.assert_allclose(model["quality"], expected)
        joint = domain.fit_training_basis(train, catalog, users)
        self.assertFalse(np.allclose(model["quality"], joint["quality"][:2]))

    def test_type_vocabulary_and_candidates_cannot_include_other_or_heldout_titles(self):
        train, catalog, users = training_fixture()
        model = domain.fit_training_basis(train.loc[train.item_id.isin(["m0", "m1"])],
                                          catalog.iloc[:2], users)
        vocabulary = model["content_encoders"]["synopsis"].vocabulary_
        self.assertIn("misterio", vocabulary)
        self.assertNotIn("dragones", vocabulary)
        self.assertNotIn("extraterrestre", vocabulary)
        self.assertEqual(model["content_encoders"]["cast"].classes_.tolist(), ["movie actor"])
        heldout = catalog.iloc[:1].copy()
        heldout["item_id"] = "heldout_only"
        heldout["synopsis"] = "extraterrestre"
        with self.assertRaises(ValueError):
            domain.fit_training_basis(train, pd.concat([catalog, heldout], ignore_index=True), users)

    def test_fitting_does_not_relabel_feedback_or_mutate_source_metadata(self):
        train, catalog, users = training_fixture()
        before_train, before_catalog = train.copy(deep=True), catalog.copy(deep=True)
        domain.fit_training_basis(train, catalog, users)
        pd.testing.assert_frame_equal(train, before_train)
        pd.testing.assert_frame_equal(catalog, before_catalog)
        self.assertEqual(users, ["fa:D", "fa:C", "fa:A", "fa:B"])


class ProfileHistoryTests(unittest.TestCase):
    def setUp(self):
        self.likes = sparse.csr_matrix([[1., 1, 0, 1], [0, 0, 0, 0]])
        self.units = np.array(["movie", "whole_series", "movie", "whole_series"])

    def test_shared_and_same_type_histories_are_distinct_copied_profiles(self):
        original = self.likes.copy()
        all_types = study.profile_for_kind(self.likes, self.units, "movie", "all")
        movies = study.profile_for_kind(self.likes, self.units, "movie", "same_type")
        series = study.profile_for_kind(self.likes, self.units, "whole_series", "same_type")
        self.assertIsNot(all_types, self.likes)
        self.assertTrue(sparse.isspmatrix_csr(all_types))
        np.testing.assert_array_equal(all_types.toarray(), [[1, 1, 0, 1], [0, 0, 0, 0]])
        np.testing.assert_array_equal(movies.toarray(), [[1, 0, 0, 0], [0, 0, 0, 0]])
        np.testing.assert_array_equal(series.toarray(), [[0, 1, 0, 1], [0, 0, 0, 0]])
        self.assertEqual((original != self.likes).nnz, 0)

    def test_unknown_kind_mode_and_misaligned_units_are_not_silent_ablations(self):
        for units, kind, mode in [(self.units, "episode", "all"),
                                  (self.units, "movie", "invalid"),
                                  (self.units[:2], "movie", "same_type")]:
            with self.subTest(kind=kind, mode=mode), self.assertRaises(ValueError):
                study.profile_for_kind(self.likes, units, kind, mode)


class DomainComponentTests(unittest.TestCase):
    def setUp(self):
        content = sparse.csr_matrix([[1., 0], [1, 0],
                                     [.2, np.sqrt(.96)], [.4, np.sqrt(.84)]])
        self.model = {
            "item_ids": ["liked_other_type", "seen_target", "target_a", "target_b"],
            "features": {"cf": sparse.csr_matrix([[1.], [1000.], [2.], [4.]]),
                         "synopsis": content.copy(), "genres": content.copy(),
                         "cast": sparse.csr_matrix((4, 2))},
        }
        self.profile = sparse.csr_matrix([[1., 0, 0, 0], [0, 0, 0, 0]])
        self.columns = np.array([1, 2, 3])
        self.seen = np.array([[True, False, False], [False, False, False]])

    def test_target_only_unseen_scaling_and_missing_cast_match_numeric_oracles(self):
        scores = domain.domain_components(self.model, self.profile, self.columns, self.seen)
        self.assertEqual(set(scores), {"cf", "synopsis", "metadata"})
        np.testing.assert_allclose(scores["cf"], [[0, .5, 1], [0, 0, 0]])
        np.testing.assert_allclose(scores["synopsis"], [[0, .5, 1], [0, 0, 0]], rtol=1e-6)
        # Separate genre/cast max scaling preserves the missing cast channel as zero.
        np.testing.assert_allclose(scores["metadata"], [[0, .25, .5], [0, 0, 0]], rtol=1e-6)
        for values in scores.values():
            self.assertTrue(np.isfinite(values).all())

    def test_scoring_preserves_profiles_seen_and_frozen_feature_arrays(self):
        profile_before, seen_before = self.profile.copy(), self.seen.copy()
        features_before = {key: value.copy() for key, value in self.model["features"].items()}
        domain.domain_components(self.model, self.profile, self.columns, self.seen)
        self.assertEqual((self.profile != profile_before).nnz, 0)
        np.testing.assert_array_equal(self.seen, seen_before)
        for name, value in self.model["features"].items():
            self.assertEqual((value != features_before[name]).nnz, 0)

    def test_empty_candidates_are_valid_but_duplicate_or_misaligned_columns_are_rejected(self):
        empty = domain.domain_components(self.model, self.profile, np.array([], dtype=int),
                                          np.zeros((2, 0), dtype=bool))
        for values in empty.values():
            self.assertEqual(values.shape, (2, 0))
        for columns, seen in [(np.array([1, 1]), np.zeros((2, 2), dtype=bool)),
                              (np.array([4]), np.zeros((2, 1), dtype=bool)),
                              (np.array([1, 2]), np.zeros((1, 2), dtype=bool))]:
            with self.subTest(columns=columns), self.assertRaises(ValueError):
                domain.domain_components(self.model, self.profile, columns, seen)


class PopularityBlendTests(unittest.TestCase):
    def setUp(self):
        self.personal = np.array([[100., 2, 4, 0], [9., 8, 7, 6]])
        self.popularity = np.array([999., 1, 0, 5])
        self.seen = np.array([[True, False, False, False], [True, False, False, False]])
        self.no_profile = np.array([False, True])

    def test_convex_scores_and_no_profile_fallback_match_numeric_oracles(self):
        scores = study.blend_personal_popularity(self.personal, self.popularity,
                                                  self.seen, .25, self.no_profile)
        self.assertTrue(np.isneginf(scores[:, 0]).all())
        np.testing.assert_allclose(scores[0, 1:], [.275, .25, .75])
        np.testing.assert_allclose(scores[1, 1:], [.2, 0, 1])
        for alpha in [0, .25, .5, 1]:
            result = study.blend_personal_popularity(self.personal, self.popularity,
                                                      self.seen, alpha, self.no_profile)
            np.testing.assert_allclose(result[1, 1:], [.2, 0, 1])
            self.assertTrue(np.isfinite(result[~self.seen]).all())

    def test_alpha_zero_ignores_family_scores_and_all_seen_or_zero_support_is_safe(self):
        first = study.blend_personal_popularity(self.personal, self.popularity,
                                                 self.seen, 0, self.no_profile)
        second = study.blend_personal_popularity(self.personal * 3, self.popularity,
                                                  self.seen, 0, self.no_profile)
        np.testing.assert_array_equal(first, second)
        blocked = study.blend_personal_popularity(np.zeros((2, 4)), np.zeros(4),
                                                   np.ones((2, 4), dtype=bool), 1,
                                                   np.array([False, True]))
        self.assertTrue(np.isneginf(blocked).all())
        zero = study.blend_personal_popularity(np.zeros((2, 4)), np.zeros(4),
                                                self.seen, .5, self.no_profile)
        np.testing.assert_array_equal(zero[~self.seen], np.zeros(6))

    def test_blending_does_not_mutate_model_components_or_masks(self):
        arrays = [self.personal, self.popularity, self.seen, self.no_profile]
        before = [value.copy() for value in arrays]
        study.blend_personal_popularity(*arrays[:3], .5, arrays[3])
        for actual, expected in zip(arrays, before):
            np.testing.assert_array_equal(actual, expected)

    def test_invalid_signal_or_alignment_cannot_change_policy_silently(self):
        cases = [
            (np.array([[1., -1]]), np.array([1., 2]), np.zeros((1, 2), bool), .5, np.array([False])),
            (np.array([[1., np.nan]]), np.array([1., 2]), np.zeros((1, 2), bool), .5, np.array([False])),
            (np.array([[1., 2]]), np.array([1., -2]), np.zeros((1, 2), bool), .5, np.array([False])),
            (self.personal, self.popularity[:2], self.seen, .5, self.no_profile),
            (self.personal, self.popularity, self.seen[:1], .5, self.no_profile),
            (self.personal, self.popularity, self.seen, 1.01, self.no_profile),
            (self.personal, self.popularity, self.seen, np.nan, self.no_profile),
            (self.personal, self.popularity, self.seen, .5, self.no_profile[:1]),
        ]
        for values in cases:
            with self.subTest(alpha=values[3]), self.assertRaises(ValueError):
                study.blend_personal_popularity(*values)


class SeparateShelfIntegrationTests(unittest.TestCase):
    def test_fixed_cohorts_fallbacks_inference_and_equal_twenty_title_budgets_agree(self):
        ids = [f"m{i:02d}" for i in range(12)] + [f"t{i:02d}" for i in range(12)]
        catalog = pd.DataFrame({
            "item_id": ids, "title": ids, "original_title": ids, "year": [2000] * 24,
            "unit": ["movie"] * 12 + ["whole_series"] * 12, "confidence": ["medium"] * 24,
            "synopsis": ["misterio urbano detectives ciudad"] * 12 + ["dragones reino magia aventura"] * 12,
            "film_genre": ["['Misterio']"] * 12 + ["['Fantasía']"] * 12,
            "film_cast": ["['Movie Actor']"] * 12 + ["['TV Actor']"] * 12,
        })
        events = [("fa:A", "m00", 9), ("fa:A", "t00", 8), ("fa:A", "t01", 2),
                  ("fa:B", "m01", 8), ("fa:B", "t00", 1),
                  ("fa:C", "t01", 10), ("fa:C", "m00", 3),
                  ("fa:D", "m00", 4), ("fa:D", "t00", 2)]
        events += [("fa:catalog_seed", item, 5) for item in ids]
        train = pd.DataFrame(events, columns=["user_id", "item_id", "rating"])
        train_before, catalog_before = train.copy(deep=True), catalog.copy(deep=True)
        frozen = domain.fit_training_basis(train, catalog, sorted(train.user_id.unique()))
        frozen["eligible_mask"] = np.ones(len(ids), dtype=bool)
        frozen["best_personalized_variant"] = {"kind": "hybrid", "plot": .25, "metadata": .25, "quality": .1}
        bank, invariants = study.fit_models(frozen, train, catalog)
        self.assertEqual(len(invariants), 2)
        self.assertTrue(all(row["same_cf_rows"] and row["same_train_popularity"] for row in invariants))
        validation = pd.DataFrame([
            ("fa:A", "m02", 8, "movie"), ("fa:A", "t02", 9, "whole_series"),
            ("fa:A", "missing_tv", 10, "whole_series"),
            ("fa:B", "m00", 8, "movie"), ("fa:B", "missing_movie", 9, "movie"),
            ("fa:C", "t00", 8, "whole_series"),
            ("fa:D", "m03", 9, "movie"), ("fa:D", "t03", 8, "whole_series"),
        ], columns=["user_id", "item_id", "rating", "unit"])
        positives = {"movie": {"fa:A": {"m02"}, "fa:B": {"m00", "missing_movie"}, "fa:D": {"m03"}},
                     "whole_series": {"fa:A": {"t02", "missing_tv"}, "fa:C": {"t00"}, "fa:D": {"t03"}}}
        grids = {kind: study.ranker_grid(kind) for kind in study.KINDS}
        self.assertEqual([len(grids[kind]) for kind in study.KINDS], [13, 14])
        per_users, predictions = {}, {}
        for kind in study.KINDS:
            with redirect_stdout(StringIO()):
                board, per_users[kind], predictions[kind], _ = study.evaluate_kind(bank, validation, kind, grids[kind])
            frame = per_users[kind]
            self.assertTrue(board.users.eq(3).all())
            self.assertEqual(len(frame), 3 * len(grids[kind]))
            self.assertEqual(set(frame.user_id), set(positives[kind]))
            self.assertTrue(frame.loc[frame.user_id.eq("fa:D"), "empty_profile"].all())
            zero_names = [entry["ranker"] for entry in grids[kind] if entry["alpha"] == 0]
            for name in zero_names[1:]:
                self.assertEqual(predictions[kind][name], predictions[kind][zero_names[0]])
            for entry in grids[kind]:
                for user, relevant in positives[kind].items():
                    past = train.loc[train.user_id.eq(user)].set_index("item_id").rating.to_dict()
                    bundle = {"models": bank, "selections": {kind: entry},
                              "global_eligible_ids": ids, "excluded_item_ids": []}
                    result = study.recommend(bundle, past, kind)
                    ranked = result.item_id.tolist()
                    self.assertEqual(ranked, predictions[kind][entry["ranker"]][user])
                    self.assertEqual(len(ranked), 10)
                    self.assertEqual(len(set(ranked)), 10)
                    self.assertTrue(result.unit.eq(kind).all())
                    self.assertTrue(set(ranked).isdisjoint(past))
                    row = frame.loc[frame.ranker.eq(entry["ranker"]) & frame.user_id.eq(user)].iloc[0]
                    self.assertEqual(row.positives, len(relevant))
                    self.assertAlmostEqual(row.recall_at_10, len(set(ranked) & relevant) / len(relevant))
        tv = per_users["whole_series"]
        movie_only_profile = tv.loc[tv.user_id.eq("fa:B")]
        self.assertFalse(movie_only_profile.loc[movie_only_profile.family.eq("shared_all"), "empty_profile"].any())
        self.assertTrue(movie_only_profile.loc[movie_only_profile.family.isin(["shared_same", "independent"]), "empty_profile"].all())
        self.assertTrue(movie_only_profile.target_training_likes.eq(0).all())
        selections = {"movie": next(entry for entry in grids["movie"] if entry["family"] == "shared_same" and entry["alpha"] == .5),
                      "whole_series": next(entry for entry in grids["whole_series"] if entry["family"] == "independent" and entry["alpha"] == .25)}
        bundle = {"models": bank, "selections": selections, "global_eligible_ids": ids, "excluded_item_ids": []}
        old_records, mixed_lists = [], {}
        for user in ["fa:A", "fa:B", "fa:C", "fa:D"]:
            ui = frozen["user_ids"].index(user)
            profile = frozen["likes"][[ui]]
            seen = frozen["seen"][[ui]].toarray().astype(bool)
            components = component_scores(frozen, profile, seen)
            scores = blend_scores(frozen, components, frozen["best_personalized_variant"], seen,
                                  np.asarray(profile.sum(axis=1)).ravel() == 0)
            selected_columns = ranked_indices(scores[0], frozen["eligible_mask"], frozen["popularity"], np.asarray(ids), k=20)
            mixed_lists[user] = np.asarray(ids)[selected_columns].tolist()
            relevant = positives["movie"].get(user, set()) | positives["whole_series"].get(user, set())
            metrics = ranking_metrics(mixed_lists[user][:10], relevant)
            old_records.append({"user_id": user, "mixed_recall_at_10": metrics["recall"], "mixed_ndcg_at_10": metrics["ndcg"]})
        budget, budget_users, parity = study.equal_budget_comparison(
            bank, validation, per_users, selections, pd.DataFrame(old_records).set_index("user_id")
        )
        self.assertTrue(parity["passed"])
        self.assertEqual(len(budget), 4)
        self.assertTrue(budget.total_budget.eq(20).all())
        self.assertTrue(budget.mixed_users.eq(4).all())
        self.assertTrue(budget.movie_users.eq(3).all())
        self.assertTrue(budget.tv_users.eq(3).all())
        self.assertFalse(any("ndcg" in name for name in budget_users.columns))
        selected_rows = budget_users.loc[budget_users.view.eq("Selected19 shelves 10+10")].set_index("user_id")
        mixed_rows = budget_users.loc[budget_users.view.eq("Frozen shared mixed20")].set_index("user_id")
        for user in ["fa:A", "fa:B", "fa:C", "fa:D"]:
            past = train.loc[train.user_id.eq(user)].set_index("item_id").rating.to_dict()
            both = study.recommend(bundle, past, "both")
            self.assertEqual(set(both), {"movies", "series"})
            self.assertEqual([len(both[key]) for key in ["movies", "series"]], [10, 10])
            self.assertTrue(both["movies"].unit.eq("movie").all())
            self.assertTrue(both["series"].unit.eq("whole_series").all())
            union = set(both["movies"].item_id) | set(both["series"].item_id)
            self.assertEqual(len(union), 20)
            self.assertTrue(union.isdisjoint(past))
            relevant = positives["movie"].get(user, set()) | positives["whole_series"].get(user, set())
            self.assertAlmostEqual(selected_rows.loc[user, "mixed_recall"], len(union & relevant) / len(relevant))
            self.assertAlmostEqual(mixed_rows.loc[user, "mixed_recall"], len(set(mixed_lists[user]) & relevant) / len(relevant))
            for kind, column in [("movie", "movie_recall"), ("whole_series", "tv_recall")]:
                if user in positives[kind]:
                    self.assertAlmostEqual(selected_rows.loc[user, column], len(union & positives[kind][user]) / len(positives[kind][user]))
                else:
                    self.assertTrue(pd.isna(selected_rows.loc[user, column]))
        pd.testing.assert_frame_equal(train, train_before)
        pd.testing.assert_frame_equal(catalog, catalog_before)


class NotebookBoundaryTests(unittest.TestCase):
    def test_notebook_and_new_helpers_do_not_load_reserved_feedback_or_paid_apis(self):
        notebooks = list((ROOT / "notebooks").glob("19_*.ipynb"))
        self.assertEqual(len(notebooks), 1)
        notebook = json.loads(notebooks[0].read_text(encoding="utf-8"))
        code = "\n".join("".join(cell["source"]) for cell in notebook["cells"]
                         if cell["cell_type"] == "code")
        for source in [code, inspect.getsource(study), inspect.getsource(domain)]:
            tree = ast.parse(source)
            self.assertNotIn("OPENAI_API_KEY", source)
            self.assertNotIn("OpenAI(", source)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    if node.func.attr in {"read_csv", "read_parquet"}:
                        strings = [value.value for arg in node.args for value in ast.walk(arg)
                                   if isinstance(value, ast.Constant) and isinstance(value.value, str)]
                        self.assertFalse(any(re.search(r"(?:^|[/_\\])(?:reserved_)?test(?:[_.\\]|$)", value)
                                             for value in strings), strings)


if __name__ == "__main__":
    unittest.main()
