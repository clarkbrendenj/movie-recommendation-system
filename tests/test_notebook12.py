"""Direct-generation prompt isolation, conservative title grounding, and budget reuse."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import llm_direct_recommendations as direct
from scripts import llm_recommendation_experiment as pilot


def titles():
    return [{"title": f"Generated Movie {number}", "year": 2000} for number in range(10)]


class DirectPromptTests(unittest.TestCase):
    def test_only_ratings_are_sent_and_full_history_is_preserved(self):
        history = [[f"Rated Movie {number} (1999)", 4.0] for number in range(70)]
        request = direct.make_direct_request(history)
        data = json.loads(request["input"])
        self.assertEqual(set(data), {"rated_movies"})
        self.assertEqual(data["rated_movies"], history)
        for forbidden in ["candidate_movies", "movie_ids", "positives", "imdb_average", "userId"]:
            self.assertNotIn(forbidden, request["input"])
        self.assertEqual(request["max_output_tokens"], 1024)
        self.assertNotIn("tools", request)

    def test_bad_format_is_rejected_but_duplicate_movies_are_audited_later(self):
        self.assertEqual(direct.parse_recommendations(json.dumps({"movies": titles()})), titles())
        repeated = [titles()[0]] * 10
        self.assertEqual(len(direct.parse_recommendations(json.dumps({"movies": repeated}))), 10)
        for data in [{"movies": titles()[:9]}, {"movies": [{"title": "A", "year": True}] * 10},
                     {"movies": [{"title": "", "year": 2000}] * 10}, {"ids": list(range(10))}]:
            with self.assertRaises(ValueError):
                direct.parse_recommendations(json.dumps(data))


class GroundingTests(unittest.TestCase):
    def setUp(self):
        self.movies = [{"movieId": 1, "title": "Matrix, The (1999)"},
                       {"movieId": 2, "title": "Twelve Monkeys (a.k.a. 12 Monkeys) (1995)"},
                       {"movieId": 3, "title": "Léon: The Professional (1994)"},
                       {"movieId": 4, "title": "King Kong (1933)"},
                       {"movieId": 5, "title": "King Kong (2005)"},
                       {"movieId": 6, "title": "Shared Title (2000)"},
                       {"movieId": 7, "title": "Shared Title (2000)"}]
        self.index = direct.build_title_index(self.movies)

    def test_articles_punctuation_accents_and_catalog_aliases(self):
        recommendations = [{"title": "The Matrix", "year": 1999},
                           {"title": "12 Monkeys", "year": 1995},
                           {"title": "Leon The Professional", "year": 1994}]
        slots, audit = direct.map_recommendations(recommendations, self.index, {1, 2, 3}, set())
        self.assertEqual(slots, [1, 2, 3])
        self.assertTrue(all(row["status"] == "eligible" for row in audit))

    def test_remake_years_ambiguity_seen_duplicates_and_outside_catalog(self):
        recommendations = [{"title": title, "year": year} for title, year in [
            ("King Kong", 2005), ("King Kong", 1933), ("King Kong", 2005),
            ("Shared Title", 2000), ("The Matrix", 1999), ("Unknown Movie", 1999),
            ("12 Monkeys", 1996)]]
        slots, audit = direct.map_recommendations(recommendations, self.index, {1, 2, 5, 6, 7}, {1})
        self.assertEqual(slots, [5, None, None, None, None, None, None])
        self.assertEqual([row["status"] for row in audit], ["eligible", "outside_training_catalog", "duplicate",
            "ambiguous_title_year", "already_rated", "unmatched_title_year", "unmatched_title_year"])

    def test_unmatched_slots_keep_rank_discounts_and_positive_denominators(self):
        result = direct.slot_metrics([None, 1, None], {1, 999})
        self.assertEqual(result["recall_at_10"], 0.5)
        self.assertAlmostEqual(result["ndcg_at_10"], (1 / __import__('math').log2(3)) / (1 + 1 / __import__('math').log2(3)))
        self.assertEqual(direct.slot_metrics([], {1})["recall_at_10"], 0)
        with self.assertRaises(ValueError):
            direct.slot_metrics([1, 1], {1})


class DirectCacheTests(unittest.TestCase):
    def test_cache_reuse_and_shared_budget_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous, output = root / "previous", root / "direct"
            pilot.reserve_request(previous / "budget_ledger.json", "prior-pilot", 0.669)
            calls = []
            def transport(*_):
                calls.append(1)
                return {"status": "completed", "model": "fixture", "usage": {"input_tokens": 10, "output_tokens": 10},
                        "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps({"movies": titles()})}]}]}
            request = direct.make_direct_request([["Rated (1999)", 5]])
            first = direct.run_direct_one(request, output, previous, "secret-fixture", transport)
            second = direct.run_direct_one(request, output, previous, "secret-fixture", transport)
            self.assertEqual(first["status"], "ok")
            self.assertTrue(second["from_cache"])
            self.assertEqual(len(calls), 1)
            self.assertFalse((output / "budget_ledger.json").exists())
            ledger = json.loads((previous / "budget_ledger.json").read_text())
            self.assertEqual(len(ledger["reservations"]), 2)
            for file in root.rglob("*.json"):
                self.assertNotIn("secret-fixture", file.read_text())

    def test_budget_exhaustion_stops_before_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pilot.reserve_request(root / "budget_ledger.json", "previous", 1)
            with patch.object(pilot, "api_transport") as transport:
                with self.assertRaises(RuntimeError):
                    direct.run_direct_one(direct.make_direct_request([["Rated (1999)", 5]]), root / "new", root, "fixture", transport)
                transport.assert_not_called()

    def test_transport_error_is_redacted_and_reservation_is_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def transport(*_):
                raise TimeoutError("secret-fixture")
            with self.assertRaisesRegex(RuntimeError, "no retry") as caught:
                direct.run_direct_one(direct.make_direct_request([["Rated (1999)", 5]]), root / "new", root, "secret-fixture", transport)
            self.assertNotIn("secret-fixture", str(caught.exception))
            self.assertEqual(len(json.loads((root / "budget_ledger.json").read_text())["reservations"]), 1)


if __name__ == "__main__":
    unittest.main()
