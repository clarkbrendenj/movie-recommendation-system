"""No-network checks for LLM pilot fairness, cost bounds, cache, and failures."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import llm_recommendation_experiment as experiment


def candidates():
    return [{"movieId": item, "title": f"Movie {item}", "genres": "Drama"} for item in range(1, 21)]


def request():
    return experiment.make_request([{"movieId": 99, "title": "History", "rating": 4}], candidates(), 42)


def successful_response():
    return {"id": "fixture", "model": "fixture-model", "status": "completed",
            "usage": {"input_tokens": 1000, "output_tokens": 100},
            "output": [{"type": "message", "content": [
                {"type": "output_text", "text": json.dumps({"movie_ids": list(range(1, 11))})}]}]}


class ProtocolTests(unittest.TestCase):
    def test_sampling_is_repeatable_unique_and_does_not_depend_on_user_order(self):
        selected = experiment.select_users(range(594))
        np.testing.assert_array_equal(selected, experiment.select_users(reversed(range(594))))
        self.assertEqual(len(set(selected)), 100)
        with self.assertRaises(ValueError):
            experiment.select_users([1, 2], size=3)

    def test_request_has_only_supplied_history_and_metadata_and_is_repeatable(self):
        first = request()
        self.assertEqual(first, request())
        payload = json.loads(first["input"])
        self.assertEqual(set(payload), {"training_history", "candidate_movies"})
        self.assertNotIn("positives", first["input"])
        self.assertEqual({row["movieId"] for row in payload["candidate_movies"]}, set(range(1, 21)))
        self.assertNotEqual([row["movieId"] for row in payload["candidate_movies"]], list(range(1, 21)))
        self.assertEqual(first["max_output_tokens"], 512)
        self.assertFalse(first["store"])
        self.assertNotIn("tools", first)
        with self.assertRaises(ValueError):
            experiment.make_request([{"movieId": 1}], candidates(), 1)

    def test_invalid_responses_are_rejected_without_silently_repairing(self):
        valid = json.dumps({"movie_ids": list(range(1, 11))})
        self.assertEqual(experiment.validate_recommendations(valid, range(1, 21)), list(range(1, 11)))
        for invalid in ["not json", json.dumps({"movie_ids": [1] * 10}),
                        json.dumps({"movie_ids": list(range(1, 10)) + [999]}),
                        json.dumps({"movie_ids": list(range(1, 10))}),
                        json.dumps({"movie_ids": [True] + list(range(2, 11))}),
                        json.dumps({"movie_ids": list(range(1, 11)), "explanation": "extra"})]:
            with self.assertRaises(ValueError):
                experiment.validate_recommendations(invalid, range(1, 21))

    def test_ranker_excludes_seen_and_keeps_signed_ease_scores(self):
        result = experiment.rank_ids([100, -1, -2, -1], [1, 2, 3, 4], [10, 3, 4, 3], [True, False, False, False])
        self.assertEqual(result, [2, 4, 3])

    def test_metrics_keep_unavailable_positives_and_empty_failure_lists(self):
        values = experiment.metrics([1, 2], {1, 999})
        self.assertEqual(values["recall_at_10"], 0.5)
        self.assertAlmostEqual(values["ndcg_at_10"], 1 / (1 + 1 / np.log2(3)))
        self.assertEqual(experiment.metrics([], {999})["recall_at_10"], 0)
        self.assertEqual(experiment.paired_interval([0, 0, 0]),
                         {"mean_change": 0, "ci95_low": 0, "ci95_high": 0})

    def test_ease_predictions_match_notebook08(self):
        from test_notebook08 import FUNCTIONS
        feedback = np.array([[1., 0, 1, 0], [0, 1, 1, 1], [1, 1, 0, 0]])
        np.testing.assert_allclose(experiment._ease_scores(feedback),
                                   FUNCTIONS["ease_training_user_scores"](feedback, 50))


class BudgetAndCacheTests(unittest.TestCase):
    def test_budget_is_persistent_and_cannot_be_raised_above_ceiling(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / "budget.json"
            experiment.reserve_request(ledger, "first", 0.75)
            for fingerprint, amount, budget in [("second", 0.3, 1), ("first", 0.01, 1),
                                                 ("third", 0.01, 23)]:
                with self.assertRaises((RuntimeError, ValueError)):
                    experiment.reserve_request(ledger, fingerprint, amount, budget)
            self.assertEqual(json.loads(ledger.read_text())["reservations"], {"first": 0.75})

    def test_request_reservation_accounts_for_payload_overhead_and_maximum_output(self):
        upper = ((experiment.MAX_REQUEST_BYTES + 4096) * experiment.RESERVE_INPUT_USD_PER_MILLION
                 + experiment.MAX_OUTPUT_TOKENS * experiment.OUTPUT_USD_PER_MILLION) / 1_000_000
        self.assertLess(experiment.request_reservation(request()), upper)
        # A particular plan must be checked before any call; even the permitted
        # per-request bound cannot authorize $23 of spend.
        self.assertLess(upper, 0.02)

    def test_success_is_cached_with_no_extra_transport_call_or_key_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def transport(body, key):
                calls.append(1)
                return successful_response()
            first = experiment.run_one(request(), range(1, 21), directory, "secret-fixture", transport)
            second = experiment.run_one(request(), range(1, 21), directory, "secret-fixture", transport)
            self.assertEqual(len(calls), 1)
            self.assertEqual(first["movie_ids"], second["movie_ids"])
            self.assertTrue(second["from_cache"])
            for path in Path(directory).rglob("*.json"):
                self.assertNotIn("secret-fixture", path.read_text())

    def test_transport_failure_is_reserved_cached_and_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            def transport(body, key):
                raise TimeoutError("secret-fixture must never appear")
            with self.assertRaisesRegex(RuntimeError, "no automatic retry") as caught:
                experiment.run_one(request(), range(1, 21), directory, "secret-fixture", transport)
            self.assertNotIn("secret-fixture", str(caught.exception))
            record = experiment.run_one(request(), range(1, 21), directory, "secret-fixture", transport)
            self.assertEqual(record["status"], "transport_error")
            self.assertTrue(record["from_cache"])
            for path in Path(directory).rglob("*.json"):
                self.assertNotIn("secret-fixture", path.read_text())

    def test_invalid_or_incomplete_response_does_not_retry(self):
        for response in [{"status": "incomplete"}, {"status": "completed", "output": []}]:
            with self.subTest(response=response), tempfile.TemporaryDirectory() as directory:
                with patch.object(experiment, "api_transport") as unused:
                    record = experiment.run_one(request(), range(1, 21), directory, "fixture", lambda *_: response)
                self.assertEqual(record["movie_ids"], [])
                self.assertNotEqual(record["status"], "ok")
                unused.assert_not_called()

    def test_auth_retry_requires_explicit_flag_and_preserves_original_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            def rejected(*_):
                raise urllib.error.HTTPError("https://api.openai.com", 401, "Unauthorized", {}, None)
            with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                experiment.run_one(request(), range(1, 21), directory, "fixture", rejected)
            with self.assertRaisesRegex(RuntimeError, "replace the local key"):
                experiment.run_one(request(), range(1, 21), directory, "fixture", lambda *_: successful_response())
            record = experiment.run_one(request(), range(1, 21), directory, "fixture",
                                        lambda *_: successful_response(), retry_auth_failure=True)
            self.assertEqual(record["status"], "ok")
            self.assertEqual(record["attempt"], 2)
            ledger = json.loads((Path(directory) / "budget_ledger.json").read_text())
            self.assertEqual(len(ledger["reservations"]), 2)
            self.assertEqual(len(list((Path(directory) / "failed_attempts").glob("*.json"))), 1)

    def test_concurrent_live_run_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with experiment.exclusive_run(directory):
                with self.assertRaises(FileExistsError):
                    with experiment.exclusive_run(directory):
                        pass
            self.assertFalse((Path(directory) / "live_run.lock").exists())

    def test_local_env_overrides_inherited_key_without_logging(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / ".env").write_text('OPENAI_API_KEY="replacement-fixture"\n')
            with patch.dict("os.environ", {"OPENAI_API_KEY": "inherited-fixture"}):
                self.assertEqual(experiment.load_api_key(directory), "replacement-fixture")


class SummaryTests(unittest.TestCase):
    def test_partial_runs_are_not_scored_and_failed_users_are_kept_when_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            entries, baselines, coverage = [], [], []
            for user, positives in [(1, [1, 999]), (2, [2])]:
                req = experiment.make_request([{"movieId": 99, "rating": 4}], candidates(), user)
                entries.append({"userId": user, "request": req, "candidates": list(range(1, 21)),
                                "positives": positives, "fallback_ids": list(range(1, 11))})
                baselines.append({"model": "EASE shared shortlist", "userId": user,
                                  **experiment.metrics(list(range(1, 11)), positives)})
                coverage.append({"userId": user, "shortlist_recall": 0.5 if user == 1 else 1})
            for name, data in [("requests.json", entries), ("baseline_results.json", baselines),
                               ("shortlist_coverage.json", coverage)]:
                experiment.write_json(directory / name, data)
            experiment.write_json(directory / "plan.json", {
                "request_set_sha256": experiment.digest(entries),
                "baseline_results_sha256": experiment.digest(baselines),
                "coverage_sha256": experiment.digest(coverage), "split_fingerprint": "fixture"})
            experiment.run_one(entries[0]["request"], range(1, 21), directory, "fixture",
                               lambda *_: successful_response())
            summary, report = experiment.summarize_experiment(directory)
            self.assertFalse(report["complete"])
            self.assertNotIn("LLM shared shortlist", set(summary["model"]))
            experiment.run_one(entries[1]["request"], range(1, 21), directory, "fixture",
                               lambda *_: {"status": "incomplete"})
            summary, report = experiment.summarize_experiment(directory)
            self.assertTrue(report["complete"])
            self.assertEqual(report["valid_users"], 1)
            llm = summary.set_index("model").loc["LLM shared shortlist"]
            self.assertEqual(llm["users"], 2)
            self.assertEqual(llm["mean_recall_at_10"], 0.25)
            self.assertEqual(summary.set_index("model").loc[
                "LLM with EASE failure fallback", "mean_recall_at_10"], 0.75)


if __name__ == "__main__":
    unittest.main()
