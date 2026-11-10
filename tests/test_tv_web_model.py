"""Portable TV inference and independent source-identity/export checks."""

import json
from pathlib import Path
import sys
import unittest

import numpy as np
from scipy.sparse import csr_matrix

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.export_tv_web_model import ID_NAMESPACE, app_id, file_hash, portable_profile, recommend
from scripts.export_web_model import read_features


class TelevisionPortableTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {"itemCount": 5, "weights": {"plot": .25, "metadata": 0., "quality": 0., "personal": .25},
                         "items": [{"movieId": ID_NAMESPACE + index, "sourceId": f"film{index}", "quality": 0.,
                                    "eligible": index != 4, "candidate": index in (1, 2, 3), "popularity": popularity}
                                   for index, popularity in ((1, 50), (2, 2), (3, 10), (4, 999), (5, 1000))]}
        self.features = {
            "cf": csr_matrix([[1., 0], [.8, .6], [.6, .8], [1, 0], [1, 0]]),
            "synopsis": csr_matrix([[1., 0], [1, 0], [0, 1], [1, 0], [0, 1]]),
            "genres": csr_matrix((5, 2)), "cast": csr_matrix((5, 2)),
        }

    def test_numeric_source_namespaces_are_explicit_and_disjoint(self):
        self.assertEqual(app_id("film489970"), 1_000_489_970)
        self.assertNotEqual(app_id("film296"), 296)
        for value in ["tt123", "film-2", "film", "film0", "film1000000000", 296]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                app_id(value)

    def test_full_catalog_scaling_and_convex_tv_scores_have_independent_oracle(self):
        actual = recommend(self.metadata, self.features, [{"movieId": ID_NAMESPACE + 1, "rating": 4}])
        self.assertEqual([row["movieId"] for row in actual], [ID_NAMESPACE + 3, ID_NAMESPACE + 2])
        np.testing.assert_allclose([row["score"] for row in actual], [.25 * (4 / 7) + .75, .4], atol=1e-14, rtol=0)

    def test_unlinked_ids_and_vetoes_cannot_enter_the_profile(self):
        known, seen, liked = portable_profile(self.metadata, [
            {"movieId": 1, "rating": 5}, {"movieId": ID_NAMESPACE + 4, "rating": 5},
            {"movieId": ID_NAMESPACE + 1, "rating": 5}, {"movieId": ID_NAMESPACE + 1, "rating": 2},
        ])
        self.assertEqual(known, {0: 2})
        self.assertEqual(liked, [])
        self.assertEqual(np.flatnonzero(seen).tolist(), [0, 3])
        cold = recommend(self.metadata, self.features, [{"movieId": ID_NAMESPACE + 1, "rating": 2}])
        self.assertEqual([row["movieId"] for row in cold], [ID_NAMESPACE + 3, ID_NAMESPACE + 2])


@unittest.skipUnless((ROOT / "data/tv_web_model/metadata.json").is_file(), "Export the TV model first.")
class TelevisionExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = ROOT / "data/tv_web_model"
        cls.metadata = json.loads((cls.directory / "metadata.json").read_text(encoding="utf-8"))
        cls.features = read_features(cls.directory, cls.metadata)

    def test_benchmark_candidate_veto_and_memory_receipts(self):
        metadata = self.metadata
        self.assertEqual(metadata["candidateCount"], 1715)
        self.assertEqual(metadata["itemCount"], 10722)
        self.assertEqual(metadata["benchmark"]["dataset"], "FilmAffinity")
        self.assertAlmostEqual(metadata["benchmark"]["recallAt10"], .15649843983177317)
        self.assertEqual(metadata["verification"]["validationUsersCompared"], 972)
        self.assertTrue(metadata["verification"]["allTop10Identical"])
        self.assertLess(metadata["verification"]["maxAbsoluteScoreDifference"], 2e-6)
        self.assertLess(metadata["sparseBytes"], 10 * 1024 * 1024)
        self.assertEqual(sum(not item["eligible"] for item in metadata["items"]), 12)
        self.assertTrue(all(item["eligible"] and item["mediaType"] == "series" for item in metadata["items"] if item["candidate"]))

    def test_reference_cases_and_public_assets_are_reproducible(self):
        references = json.loads((self.directory / "reference.json").read_text(encoding="utf-8"))
        for fixture in references["cases"]:
            with self.subTest(name=fixture["name"]):
                actual = recommend(self.metadata, self.features, fixture["ratings"])
                self.assertEqual([row["movieId"] for row in actual], fixture["top10"])
                np.testing.assert_allclose([row["score"] for row in actual], [row["score"] for row in fixture["scores"]], rtol=0, atol=1e-12)
        for path in self.directory.iterdir():
            if path.is_file():
                self.assertEqual(file_hash(path), file_hash(ROOT / "web/public/tv-model" / path.name))

    def test_original_movie_assets_are_unchanged_and_ids_do_not_overlap(self):
        original = ROOT / "data/web_model"
        for path in original.iterdir():
            if path.is_file():
                self.assertEqual(file_hash(path), file_hash(ROOT / "web/public/model" / path.name), path.name)
        movie = json.loads((original / "metadata.json").read_text(encoding="utf-8"))
        movie_ids = {item["movieId"] for item in movie["movies"]}
        self.assertTrue(movie_ids.isdisjoint(item["movieId"] for item in self.metadata["items"]))


if __name__ == "__main__":
    unittest.main()
