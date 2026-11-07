"""Credit linkage, sparse similarity, fallback, and ranking contract checks."""

import json
from pathlib import Path
import sys
import unittest

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.preprocessing import MultiLabelBinarizer, normalize

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.prepare_imdb_credits import build_catalog


def notebook_functions():
    notebook = json.loads((ROOT / "notebooks/09_credits_based_recommendations.ipynb").read_text(encoding="utf-8"))
    namespace = {"np": np, "csr_matrix": csr_matrix, "MultiLabelBinarizer": MultiLabelBinarizer, "normalize": normalize}
    required = {"credit-feature-functions", "credit-evaluation-functions"}
    found = set()
    for cell in notebook["cells"]:
        if cell.get("id") in required:
            exec(compile("".join(cell["source"]), cell["id"], "exec"), namespace)
            found.add(cell["id"])
    if found != required:
        raise AssertionError(f"Missing definition cells: {required - found}")
    return namespace


F = notebook_functions()


class CreditLinkageTests(unittest.TestCase):
    def test_exact_ids_missing_values_cast_order_and_deduplication(self):
        links = [{"movieId": "1", "imdbId": "114709"}, {"movieId": "2", "imdbId": ""}]
        crew = [{"tconst": "tt0114709", "directors": "nm10,nm10", "writers": "\\N"}]
        principals = [
            {"tconst": "tt0114709", "nconst": "nm02", "category": "actress", "ordering": "2"},
            {"tconst": "tt0114709", "nconst": "nm01", "category": "actor", "ordering": "1"},
            {"tconst": "tt0114709", "nconst": "nm01", "category": "actor", "ordering": "3"},
            {"tconst": "tt0114709", "nconst": "nm10", "category": "director", "ordering": "4"},
        ]
        result = build_catalog(links, crew, principals, [{"nconst": "nm01", "primaryName": "A Person"}])
        first, missing = result["movies"]
        self.assertEqual(first["imdbId"], "tt0114709")
        self.assertEqual(first["cast"], ["nm01", "nm02"])
        self.assertEqual(first["directors"], ["nm10"])
        self.assertEqual(first["writers"], [])
        self.assertEqual(missing["cast"], [])
        self.assertIsNone(missing["imdbId"])

    def test_cast_limit_is_five(self):
        principals = [{"tconst": "tt0000001", "nconst": f"nm{i}", "category": "actor", "ordering": str(i)}
                      for i in range(10, 0, -1)]
        result = build_catalog([{"movieId": "1", "imdbId": "1"}], [], principals, [])
        self.assertEqual(result["movies"][0]["cast"], ["nm1", "nm2", "nm3", "nm4", "nm5"])


class FeatureTests(unittest.TestCase):
    def test_fit_excludes_non_candidates_and_preserves_missing_movies(self):
        records = [
            {"movieId": 1, "directors": ["shared", "rare"], "cast": ["actor"]},
            {"movieId": 2, "directors": ["shared"], "cast": []},
            {"movieId": 3, "directors": ["only_outside"]},
            {"movieId": 4, "directors": ["only_outside"]},
        ]
        matrix, names = F["build_role_features"](records, [1, 2, 99], "directors")
        self.assertEqual(list(names), ["shared"])
        np.testing.assert_array_equal(matrix.toarray(), [[1], [1], [0]])
        actors, actor_names = F["build_role_features"](records, [1, 2, 99], "cast")
        self.assertEqual(actors.shape, (3, 0))

    def test_idf_and_cosine_scores_match_independent_dense_calculation(self):
        records = [{"movieId": 1, "directors": ["a", "b"]},
                   {"movieId": 2, "directors": ["a"]},
                   {"movieId": 3, "directors": ["a", "b"]}, {"movieId": 4, "directors": []}]
        features, _ = F["build_role_features"](records, [1, 2, 3, 4], "directors")
        expected = np.array([[1, 1], [1, 0], [1, 1], [0, 0]], dtype=float)
        expected *= np.log(5 / np.array([4, 3])) + 1
        expected /= np.where(np.linalg.norm(expected, axis=1) > 0, np.linalg.norm(expected, axis=1), 1)[:, None]
        np.testing.assert_allclose(features.toarray(), expected)
        feedback = np.array([[1, 0, 0, 1], [0, 0, 0, 1], [0, 1, 1, 0]])
        scores, counts = F["score_features"](feedback, features)
        np.testing.assert_allclose(scores[0], expected[0] @ expected.T)
        np.testing.assert_allclose(scores[1], 0)
        np.testing.assert_allclose(scores[2], (expected[1] + expected[2]) @ expected.T / 2)
        np.testing.assert_array_equal(counts, [1, 0, 2])

    def test_empty_features_produce_zero_scores(self):
        scores, counts = F["score_features"]([[1, 0], [0, 1]], csr_matrix((2, 0)))
        np.testing.assert_array_equal(scores, np.zeros((2, 2)))
        np.testing.assert_array_equal(counts, [0, 0])


class RankingTests(unittest.TestCase):
    def test_seen_movies_do_not_affect_scaling_and_missing_content_uses_base(self):
        seen = np.array([[True, False, False], [False, False, True]])
        base = np.array([[100, 2, 1], [2, 1, 100]])
        content = np.array([[50, 0, 0], [1, 2, 100]])
        result = F["blend_with_fallback"](base, content, 1.0, seen)
        np.testing.assert_allclose(result[0], [50, 1, 0.5])
        np.testing.assert_allclose(result[1, :2], [0.5, 1])
        np.testing.assert_allclose(F["blend_with_fallback"](base, content, 0, seen), F["scale_unseen"](base, seen))

    def test_exclude_seen_then_break_ties_by_popularity_and_movie_id(self):
        result = F["rank_unseen"](
            np.array([9, 1, 1, 1]), np.array([True, False, False, False]),
            np.array([100, 2, 3, 3]), np.array([1, 9, 7, 6]), 10,
        )
        np.testing.assert_array_equal(result, [6, 7, 9])

    def test_unavailable_positives_remain_in_both_metric_denominators(self):
        hits, recall, ndcg = F["ranking_metrics"]([1, 2], {1, 99}, 10)
        self.assertEqual(hits, 1)
        self.assertEqual(recall, 0.5)
        self.assertAlmostEqual(ndcg, 1 / (1 + 1 / np.log2(3)))

    def test_invalid_ranking_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            F["rank_unseen"](np.array([np.nan]), np.array([False]), np.array([1]), np.array([1]))
        with self.assertRaises(ValueError):
            F["ranking_metrics"]([1, 1], {1})
        with self.assertRaises(ValueError):
            F["blend_with_fallback"](np.ones((1, 1)), np.ones((1, 1)), -0.1, np.zeros((1, 1), dtype=bool))


if __name__ == "__main__":
    unittest.main()
