"""Offline tests for public-source integrity, atomic caches, and provenance."""

import hashlib
import io
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
from urllib.error import URLError
from uuid import uuid4

from scripts import prepare_ratings_dataset_audit as sources


class _Response(io.BytesIO):
    def __init__(self, content, final_url="https://cdn.example.org/file?signature=private#fragment"):
        super().__init__(content)
        self.headers = {"Content-Length": str(len(content)), "ETag": "fixture"}
        self.final_url = final_url

    def geturl(self):
        return self.final_url


class AuditSourceTests(unittest.TestCase):
    def setUp(self):
        self.allowed = (sources.ROOT / "data").resolve()
        self.root = self.allowed / ("test_dataset_audit_sources_" + uuid4().hex)
        self.root.mkdir(parents=True)
        self.binary = b"PAR1DATAPAR1"

    def tearDown(self):
        target = self.root.resolve()
        if target.parent != self.allowed or not target.name.startswith("test_dataset_audit_sources_"):
            raise ValueError("Unsafe audit-source test cleanup path.")
        shutil.rmtree(target)

    def _download(self, content, destination, **kwargs):
        with patch.object(sources.urllib.request, "urlopen", return_value=_Response(content)):
            with patch.object(sources, "_ssl_context", return_value=None):
                return sources.download_file("https://example.org/file", destination,
                                             max_bytes=kwargs.pop("max_bytes", 1024), **kwargs)

    def _cached_fixture(self, *, source_identity=None):
        directory = self.root / sources.CACHE_RELATIVE
        path = directory / "fixture/file.parquet"
        path.parent.mkdir(parents=True)
        path.write_bytes(self.binary)
        receipt = {"dataset": "fixture", "kind": "ratings", "url": "https://example.org/file",
                   "revision": "a" * 40, "status": "ok", "bytes": len(self.binary),
                   "sha256": hashlib.sha256(self.binary).hexdigest(), "retrieved_at": "original-time",
                   "local_path": str(path), "scope": "fixture", "error": None,
                   "final_url": "https://cdn.example.org/file?signature=private#fragment"}
        if source_identity is not None:
            receipt["source_identity"] = source_identity
        manifest = {"assets": [receipt], "fetcher_sha256": "original-fetcher"}
        sources._write_json(directory / "manifest.json", manifest)
        return path, receipt, manifest

    def test_valid_binary_has_hash_size_and_public_redirect_receipt(self):
        target = self.root / "file.parquet"
        digest = hashlib.sha256(self.binary).hexdigest()
        receipt = self._download(self.binary, target, expected_size=len(self.binary),
                                 expected_sha256=digest, expected_magic=b"PAR1")
        self.assertEqual(target.read_bytes(), self.binary)
        self.assertEqual(receipt["sha256"], digest)
        self.assertEqual(receipt["bytes"], len(self.binary))
        self.assertEqual(receipt["final_url"], "https://cdn.example.org/file")
        self.assertFalse(target.with_suffix(".parquet.partial").exists())

    def test_wrong_hash_never_replaces_existing_file(self):
        target = self.root / "existing.parquet"
        target.write_bytes(b"previous accepted data")
        with self.assertRaisesRegex(ValueError, "SHA256"):
            self._download(self.binary, target, expected_sha256="0" * 64)
        self.assertEqual(target.read_bytes(), b"previous accepted data")

    def test_size_and_download_limit_are_enforced(self):
        target = self.root / "size.parquet"
        with self.assertRaisesRegex(ValueError, "repository file size"):
            self._download(self.binary, target, expected_size=len(self.binary) + 1)
        self.assertFalse(target.exists())
        with self.assertRaisesRegex(ValueError, "audit limit"):
            self._download(self.binary, target, max_bytes=3)
        self.assertFalse(target.exists())

    def test_wrong_binary_signature_or_footer_is_rejected(self):
        target = self.root / "signature.parquet"
        for payload, message in [(b"<html>login</html>", "signature"),
                                 (b"PAR1contentbroken", "footer")]:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, message):
                    self._download(payload, target, expected_magic=b"PAR1")
                self.assertFalse(target.exists())

    def test_git_blob_identity_is_checked_before_replacement(self):
        target = self.root / "readme.md"
        payload = b"source documentation\n"
        blob = hashlib.sha1(f"blob {len(payload)}\0".encode() + payload).hexdigest()
        self._download(payload, target, expected_git_blob=blob)
        with self.assertRaisesRegex(ValueError, "Git blob"):
            self._download(payload + b"changed", target, expected_git_blob=blob)
        self.assertEqual(target.read_bytes(), payload)

    def test_verified_cache_reuses_bytes_and_sanitizes_old_redirect(self):
        _, receipt, previous = self._cached_fixture()
        cache = sources._Cache(self.root, previous)
        with patch.object(sources, "download_file", side_effect=AssertionError("network attempted")):
            result = cache.fetch("fixture", "ratings", receipt["url"], "fixture/file.parquet",
                                 scope="fixture", revision=receipt["revision"])
        self.assertTrue(result["cache_hit"])
        self.assertEqual(result["retrieved_at"], "original-time")
        self.assertEqual(result["final_url"], "https://cdn.example.org/file")

    def test_cache_also_checks_new_source_identity_expectations(self):
        _, receipt, previous = self._cached_fixture()
        cache = sources._Cache(self.root, previous)
        with patch.object(sources, "download_file", side_effect=URLError("offline fixture")) as download:
            result = cache.fetch("fixture", "ratings", receipt["url"], "fixture/file.parquet",
                                 scope="fixture", revision=receipt["revision"],
                                 source_identity={"size": len(self.binary), "lfs": {"sha256": "0" * 64}})
        download.assert_called_once()
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result.get("cache_hit", False))

    def test_offline_verification_persists_sanitized_receipts_and_verifier_hash(self):
        _, _, _ = self._cached_fixture()
        with patch.object(sources, "download_file", side_effect=AssertionError("network attempted")):
            manifest = sources.verify_cached_sources(self.root)
        saved = json.loads((self.root / sources.CACHE_RELATIVE / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["assets"][0]["status"], "ok")
        self.assertEqual(saved["assets"][0]["final_url"], "https://cdn.example.org/file")
        self.assertEqual(saved["fetcher_sha256"], "original-fetcher")
        self.assertEqual(saved["verification_fetcher_sha256"], sources.sha256_file(Path(sources.__file__)))
        self.assertIn("last_verified_at", saved)

    def test_offline_verification_detects_tampered_bytes(self):
        path, _, _ = self._cached_fixture()
        path.write_bytes(b"tampered")
        manifest = sources.prepare_sources(self.root, offline=True)
        self.assertEqual(manifest["assets"][0]["status"], "cache_mismatch")

    def test_offline_verification_checks_pinned_identity_even_when_receipt_matches(self):
        self._cached_fixture(source_identity={"size": len(self.binary), "lfs": {"sha256": "0" * 64}})
        manifest = sources.verify_cached_sources(self.root)
        self.assertEqual(manifest["assets"][0]["status"], "source_identity_mismatch")

    def test_asset_cannot_escape_dedicated_cache(self):
        cache = sources._Cache(self.root, {})
        with patch.object(sources, "download_file", side_effect=AssertionError("network attempted")):
            with self.assertRaisesRegex(ValueError, "escapes"):
                cache.fetch("fixture", "ratings", "https://example.org/file", "../outside.csv", scope="fixture")


if __name__ == "__main__":
    unittest.main()
