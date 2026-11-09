"""Ratings-source audit: conservative title units, clean events, and shared users."""

import ast
import inspect
import json
from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import ratings_dataset_audit as audit


class TitleUnitTests(unittest.TestCase):
    def classify(self, title, types, description):
        result = audit.classify_title(title, types, description)
        self.assertIn(result["confidence"], {"high", "medium", "low"})
        self.assertIsInstance(result["evidence"], str)
        self.assertTrue(result["evidence"].strip())
        return result["unit"]

    def test_multi_season_series_with_episode_counts_is_not_an_episode(self):
        self.assertEqual(self.classify(
            "Dark", ["Serie de TV"], "Serie de TV (2017-2020). 3 temporadas. 26 episodios."
        ), "whole_series")

    def test_explicit_season_overrides_a_generic_series_or_miniseries_label(self):
        for title, description in [
            ("Black Mirror: Sexta temporada", "Miniserie de TV. 5 episodios."),
            ("The Bear - Temporada 2", "Serie de TV."),
            ("Sherlock Season 1", "Miniserie de TV."),
            ("The Bear", "Segunda temporada de la serie de TV."),
        ]:
            with self.subTest(title=title):
                self.assertEqual(self.classify(title, ["Miniserie de TV"], description), "season")

    def test_explicit_episode_type_is_kept_separate_from_whole_series(self):
        self.assertEqual(self.classify("Una aventura", ["Episodio"], "Un detective investiga un crimen."),
                         "episode")

    def test_plot_language_about_a_series_of_events_does_not_establish_a_tv_unit(self):
        self.assertEqual(self.classify(
            "El misterio", [], "Una serie de asesinatos transforma la vida de un detective."
        ), "uncertain")

    def test_explicit_film_is_not_reclassified_from_story_chapters(self):
        self.assertEqual(self.classify(
            "La peor persona del mundo", ["Película"],
            "La historia se divide en doce capítulos, un prólogo y un epílogo."
        ), "movie")

    def test_missing_metadata_does_not_imply_a_whole_series(self):
        self.assertEqual(self.classify("Un título ambiguo", [], ""), "uncertain")

    def test_anime_tv_type_alone_does_not_prove_whole_multiseason_granularity(self):
        self.assertEqual(self.classify("Shingeki no Kyojin", "TV", "Episodes: 25"), "uncertain")

    def test_whole_run_metadata_is_not_overridden_by_a_first_season_plot_reference(self):
        self.assertEqual(self.classify(
            "Bajo sospecha", ["Serie"],
            "Serie de TV (2015-2016). 2 temporadas. 18 episodios. "
            "En su 1a temporada, narra la investigación de dos policías."
        ), "whole_series")

    def test_sports_calendar_seasons_do_not_establish_a_tv_season_item(self):
        for description in [
            "Esta docuserie sigue al Arsenal durante la temporada 2021-22.",
            "Un documental sobre el equipo durante la temporada 2017/18.",
        ]:
            with self.subTest(description=description):
                self.assertEqual(self.classify("All or Nothing", ["Miniserie", "Documental"], description),
                                 "whole_series")

    def test_listing_first_season_episodes_does_not_certify_a_season_specific_catalog_entry(self):
        unit = self.classify(
            "Modern Love", ["Serie"],
            "Historias independientes sobre relaciones. Episodios de la Temporada 1: "
            "1. When the Doorman Is Your Main Man. 2. When Cupid Is a Prying Journalist."
        )
        self.assertNotEqual(unit, "season")


class ReviewNormalizationTests(unittest.TestCase):
    def reviews(self, rows):
        return pd.DataFrame(rows, columns=["film_id", "author_id", "author_rating", "author_review_date"])

    def test_latest_valid_dated_score_wins_without_changing_source_rows(self):
        source = self.reviews([(11, "u1", 7, "2024-01-01"), (11, "u1", 9, "2024-02-01")])
        before = source.copy(deep=True)
        clean, quality = audit.normalize_reviews(source)
        self.assertEqual(len(clean), 1)
        self.assertEqual(float(clean.iloc[0]["rating"]), 9)
        self.assertEqual(pd.Timestamp(clean.iloc[0]["rated_at"]), pd.Timestamp("2024-02-01", tz="UTC"))
        self.assertTrue({"item_id", "user_id", "rating", "rated_at", "raw_rating"}.issubset(clean.columns))
        self.assertIsInstance(quality, dict)
        self.assertEqual(quality["raw_rows"], 2)
        self.assertEqual(quality["rows_cleaned"], 1)
        pd.testing.assert_frame_equal(source, before)

    def test_invalid_ratings_and_missing_ids_are_removed_but_bad_dates_keep_valid_scores(self):
        source = self.reviews([
            (11, "u1", 1, "2024-01-01"), (12, "u1", 10, "not-a-date"),
            (13, "u2", 0, "2024-01-01"), (14, "u3", 11, "2024-01-01"),
            (15, "u4", np.nan, "2024-01-01"), (16, None, 8, "2024-01-01"),
            (None, "u5", 8, "2024-01-01"), (17, "   ", 8, "2024-01-01"),
            (18, "u6", float("inf"), "2024-01-01"),
        ])
        clean, quality = audit.normalize_reviews(source)
        self.assertEqual(len(clean), 2)
        self.assertEqual(set(clean["rating"]), {1, 10})
        self.assertEqual(int(clean["rated_at"].isna().sum()), 1)
        self.assertIsInstance(quality, dict)
        self.assertEqual(quality["missing_identity_rows"], 3)
        self.assertEqual(quality["invalid_rating_rows"], 4)
        self.assertEqual(quality["invalid_date_rows"], 1)
        self.assertTrue(np.isfinite(clean["rating"].to_numpy(dtype=float)).all())

    def test_conflicting_latest_date_drops_pair_instead_of_resurrecting_an_older_score(self):
        source = self.reviews([
            (11, "u1", 7, "2023-01-01"), (11, "u1", 8, "2024-01-01"),
            (11, "u1", 9, "2024-01-01"), (12, "u2", 6, "2024-01-01"),
        ])
        clean, quality = audit.normalize_reviews(source)
        self.assertEqual(len(clean), 1)
        self.assertEqual(clean.iloc[0]["user_id"], "u2")
        self.assertEqual(clean.iloc[0]["rating"], 6)
        self.assertEqual(quality["ambiguous_latest_pairs"], 1)

    def test_equal_score_duplicates_are_safe_but_conflicting_undated_scores_are_ambiguous(self):
        source = self.reviews([
            (11, "u1", 8, "2024-01-01"), (11, "u1", 8, "2024-01-01"),
            (12, "u2", 7, None), (12, "u2", 9, "bad-date"),
        ])
        clean, _ = audit.normalize_reviews(source)
        self.assertEqual(len(clean), 1)
        self.assertEqual(clean.iloc[0]["user_id"], "u1")
        self.assertEqual(clean.iloc[0]["rating"], 8)

    def test_equal_instants_are_compared_in_utc_and_dates_are_not_invented(self):
        source = self.reviews([
            (11, "u1", 8, "2024-01-01T12:00:00Z"),
            (11, "u1", 9, "2024-01-01T07:00:00-05:00"),
            (12, "u2", 6, None),
        ])
        clean, _ = audit.normalize_reviews(source)
        self.assertEqual(len(clean), 1)
        self.assertEqual(clean.iloc[0]["user_id"], "u2")
        self.assertTrue(pd.isna(clean.iloc[0]["rated_at"]))

    def test_spanish_date_text_and_available_date_parts_are_parsed_as_review_dates(self):
        source = self.reviews([
            (11, "u1", 8, "20 de marzo de 2024"), (12, "u2", 9, "unparseable"),
        ])
        source["author_review_day"] = [None, 21]
        source["author_review_month"] = [None, 3]
        source["author_review_year"] = [None, 2024]
        clean, _ = audit.normalize_reviews(source)
        rows = clean.set_index("user_id")
        self.assertEqual(pd.Timestamp(rows.loc["u1", "rated_at"]), pd.Timestamp("2024-03-20", tz="UTC"))
        self.assertEqual(pd.Timestamp(rows.loc["u2", "rated_at"]), pd.Timestamp("2024-03-21", tz="UTC"))


class SharedUserCoverageTests(unittest.TestCase):
    def test_only_verified_whole_series_count_as_tv_and_orphans_do_not_inflate_coverage(self):
        ratings = pd.DataFrame([
            ("uA", "11", 9), ("uA", "12", 8), ("uB", "12", 4),
            ("uC", "13", 10), ("uD", "99", 9), ("uE", "15", 7), ("uF", "14", 9),
        ], columns=["user_id", "item_id", "rating"])
        catalog = pd.DataFrame([
            ("11", "movie"), ("12", "whole_series"), ("13", "season"),
            ("14", "episode"), ("15", "uncertain"), ("16", "movie"),
        ], columns=["item_id", "unit"])
        before_ratings, before_catalog = ratings.copy(deep=True), catalog.copy(deep=True)
        result = audit.audit_rating_overlap(ratings, catalog)
        expected = {"n_ratings": 7, "n_users": 6, "n_items": 6,
                    "n_whole_series_ratings": 2, "n_whole_series_users": 2,
                    "n_users_movies_and_series": 1}
        for key, value in expected.items():
            self.assertEqual(result[key], value, key)
        pd.testing.assert_frame_equal(ratings, before_ratings)
        pd.testing.assert_frame_equal(catalog, before_catalog)

    def test_namespaced_users_from_different_sources_never_become_a_shared_profile(self):
        ratings = pd.DataFrame([("fa:u1", "11", 9), ("mal:u1", "12", 8)],
                               columns=["user_id", "item_id", "rating"])
        catalog = pd.DataFrame([("11", "movie"), ("12", "whole_series")], columns=["item_id", "unit"])
        result = audit.audit_rating_overlap(ratings, catalog)
        self.assertEqual(result["n_users"], 2)
        self.assertEqual(result["n_users_movies_and_series"], 0)


class NotebookBoundaryTests(unittest.TestCase):
    def test_notebook_and_helper_do_not_open_test_feedback_or_paid_api_credentials(self):
        notebooks = list((ROOT / "notebooks").glob("16_*.ipynb"))
        self.assertEqual(len(notebooks), 1)
        notebook = json.loads(notebooks[0].read_text(encoding="utf-8"))
        code = "\n".join("".join(cell["source"]) for cell in notebook["cells"]
                         if cell["cell_type"] == "code")
        ast.parse(code)
        for source in [code, inspect.getsource(audit)]:
            self.assertNotIn("test_ratings.csv", source)
            self.assertNotIn("OPENAI_API_KEY", source)
            self.assertNotIn("OpenAI(", source)


if __name__ == "__main__":
    unittest.main()
