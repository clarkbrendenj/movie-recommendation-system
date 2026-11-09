"""Fetch reproducible public inputs for notebook 16's ratings-dataset audit.

FilmAffinity's two Parquet files are downloaded by default (about 450 MB total).
MAL inputs are the curator's small GitHub samples, not its complete ratings dump.
Douban's password-gated full archive is documented, never accessed automatically.
No account credentials, paid APIs, existing IMDb caches, or test feedback are used.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
CACHE_RELATIVE = Path("data/raw/notebook16_dataset_audit")
FILMAFFINITY_REPO = "naim-prog/filmaffinity-reviews-info"
MAL_REPO = "Hernan4444/MyAnimeList-Database"
DOUBAN_REPO = "csuldw/AntSpider"
DOUBAN_SAMPLE = "https://moviedata.csuldw.com/dataset/moviedata_small.tar.gz"
USER_AGENT = "AfterglowRatingsDatasetAudit/1.0 (personal noncommercial research)"


def _now():
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _git_blob_sha1(path):
    path = Path(path)
    digest = hashlib.sha1(f"blob {path.stat().st_size}\0".encode("ascii"))
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _public_redirect(url):
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _identity_expectations(identity):
    identity = identity or {}
    lfs = identity.get("lfs") or {}
    source_hash = lfs.get("sha256") or lfs.get("oid")
    if not isinstance(source_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", source_hash):
        source_hash = None
    blob = None if lfs else identity.get("blobId", identity.get("sha"))
    if not isinstance(blob, str) or not re.fullmatch(r"[0-9a-f]{40}", blob):
        blob = None
    size = identity.get("size", lfs.get("size"))
    return size, source_hash, blob


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    partial.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                       encoding="utf-8")
    partial.replace(path)


def _ssl_context():
    try:
        import truststore
    except ImportError:
        return ssl.create_default_context()
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


def download_file(url, destination, *, max_bytes, expected_size=None, expected_sha256=None,
                  expected_magic=None, expected_git_blob=None):
    """Stream an ordinary public HTTPS response into an atomic, hashed cache file."""
    if not url.startswith("https://"):
        raise ValueError("Audit downloads must use public HTTPS URLs.")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".partial")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                  "Accept-Encoding": "identity"})
    for attempt in range(3):
        try:
            print(f"Fetching {url}", flush=True)
            with urllib.request.urlopen(request, timeout=120, context=_ssl_context()) as response:
                final_url = response.geturl()
                if not final_url.startswith("https://"):
                    raise ValueError("Refusing an HTTPS-to-HTTP download redirect.")
                declared_length = response.headers.get("Content-Length")
                if declared_length and int(declared_length) > max_bytes:
                    raise ValueError(f"Response exceeds the {max_bytes:,}-byte audit limit.")
                digest, received, next_progress = hashlib.sha256(), 0, 32 * 1024 * 1024
                with partial.open("wb") as output:
                    while block := response.read(1024 * 1024):
                        if received == 0 and expected_magic and not block.startswith(expected_magic):
                            raise ValueError("Downloaded content has the wrong file signature.")
                        received += len(block)
                        if received > max_bytes:
                            raise ValueError(f"Response exceeds the {max_bytes:,}-byte audit limit.")
                        output.write(block)
                        digest.update(block)
                        if received >= next_progress:
                            print(f"  {destination.name}: {received / 1048576:.1f} MiB received", flush=True)
                            next_progress += 32 * 1024 * 1024
                if expected_magic and not received:
                    raise ValueError("Downloaded binary file is empty.")
                if declared_length and received != int(declared_length):
                    raise ValueError("Received byte count differs from HTTP Content-Length.")
                if expected_size is not None and received != expected_size:
                    raise ValueError("Received byte count differs from the pinned repository file size.")
                observed_hash = digest.hexdigest()
                if expected_sha256 and observed_hash != expected_sha256:
                    raise ValueError("Downloaded SHA256 differs from the pinned repository identity.")
                if expected_git_blob and _git_blob_sha1(partial) != expected_git_blob:
                    raise ValueError("Downloaded Git blob identity differs from the pinned repository.")
                if expected_magic == b"PAR1":
                    with partial.open("rb") as check:
                        check.seek(-4, 2)
                        if check.read() != b"PAR1":
                            raise ValueError("Downloaded Parquet footer is missing.")
                info = {"sha256": observed_hash, "bytes": received,
                        "retrieved_at": _now(), "final_url": _public_redirect(final_url),
                        "etag": response.headers.get("ETag"),
                        "last_modified": response.headers.get("Last-Modified")}
            partial.replace(destination)
            print(f"  Saved {destination.name}: {received:,} bytes", flush=True)
            return info
        except HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504} or attempt == 2:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("Public download attempts exhausted.")


class _Cache:
    def __init__(self, root, previous):
        self.root = Path(root).resolve()
        self.directory = self.root / CACHE_RELATIVE
        self.previous = {(row["dataset"], row["kind"], row["url"]): row
                         for row in previous.get("assets", [])}
        self.manifest = {"schema_version": 1, "created_at": previous.get("created_at", _now()),
                         "updated_at": _now(), "assets": [], "datasets": {},
                         "fetcher_sha256": sha256_file(Path(__file__)),
                         "policy": {"test_feedback_read": False, "paid_api_calls": False,
                                    "full_mal_downloaded": False, "full_douban_downloaded": False,
                                    "user_names_exported": False,
                                    "purpose": "source audit only; no model training or app changes"}}

    def save(self):
        _write_json(self.directory / "manifest.json", self.manifest)

    def fetch(self, dataset, kind, url, relative_path, *, scope, revision=None,
              max_bytes=8 * 1024 * 1024, expected_size=None, expected_sha256=None,
              expected_magic=None, source_identity=None):
        path = (self.directory / relative_path).resolve()
        if not path.is_relative_to(self.directory.resolve()):
            raise ValueError("Audit asset path escapes its dedicated cache.")
        receipt = {"dataset": dataset, "kind": kind, "local_path": str(path), "url": url,
                   "scope": scope, "revision": revision, "status": "pending",
                   "error": None, "sha256": None, "bytes": 0, "retrieved_at": None}
        if source_identity is not None:
            receipt["source_identity"] = source_identity
        identity_size, identity_hash, identity_blob = _identity_expectations(source_identity)
        expected_size = expected_size if expected_size is not None else identity_size
        expected_sha256 = expected_sha256 or identity_hash
        old = self.previous.get((dataset, kind, url), {})
        valid_cache = (old.get("status") == "ok" and old.get("revision") == revision
                       and path.is_file() and path.stat().st_size == old.get("bytes")
                       and sha256_file(path) == old.get("sha256")
                       and (expected_size is None or old["bytes"] == expected_size)
                       and (expected_sha256 is None or old["sha256"] == expected_sha256)
                       and (identity_blob is None or _git_blob_sha1(path) == identity_blob))
        if valid_cache:
            receipt.update({key: old[key] for key in ("sha256", "bytes", "retrieved_at")})
            for key in ("final_url", "etag", "last_modified"):
                if key in old:
                    receipt[key] = _public_redirect(old[key]) if key == "final_url" else old[key]
            receipt.update({"status": "ok", "cache_hit": True, "verified_at": _now()})
            print(f"Verified cache: {relative_path}", flush=True)
        else:
            try:
                receipt.update(download_file(url, path, max_bytes=max_bytes,
                                             expected_size=expected_size,
                                             expected_sha256=expected_sha256,
                                             expected_magic=expected_magic,
                                             expected_git_blob=identity_blob))
                receipt.update({"status": "ok", "cache_hit": False})
            except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
                receipt.update({"status": "unavailable", "error": f"{type(error).__name__}: {error}",
                                "attempted_at": _now()})
                print(f"  Access error ({dataset}/{kind}): {receipt['error']}", flush=True)
        self.manifest["assets"].append(receipt)
        self.save()
        return receipt

    def note(self, dataset, kind, url, status, error, scope, revision=None):
        receipt = {"dataset": dataset, "kind": kind, "url": url, "status": status,
                   "error": error, "scope": scope, "revision": revision, "local_path": None,
                   "sha256": None, "bytes": 0, "retrieved_at": None, "recorded_at": _now()}
        self.manifest["assets"].append(receipt)
        self.save()
        return receipt


def _json_asset(cache, receipt):
    if receipt["status"] != "ok":
        return None
    try:
        return json.loads(Path(receipt["local_path"]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        receipt.update({"status": "invalid_metadata", "error": str(error)})
        cache.save()
        return None


def _filmaffinity(cache, previous, include_full):
    dataset = "filmaffinity"
    metadata_url = f"https://huggingface.co/api/datasets/{FILMAFFINITY_REPO}?blobs=true"
    metadata_receipt = cache.fetch(dataset, "repository_metadata", metadata_url,
                                   f"{dataset}/repository.json", scope="repository snapshot and file identities")
    metadata = _json_asset(cache, metadata_receipt)
    if metadata is None:
        return
    revision = metadata.get("sha")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        cache.note(dataset, "access_note", metadata_url, "invalid_metadata",
                   "Hugging Face metadata did not include a valid commit SHA.", "no guessed revision")
        return
    identities = {row["rfilename"]: row for row in metadata.get("siblings", [])}
    cache.manifest["datasets"][dataset] = {"revision": revision, "repo": FILMAFFINITY_REPO,
                                         "file_identities": list(identities.values()),
                                         "requested_full_parquet": include_full,
                                         "license": "uploader-declared MIT; source-site rights require review"}
    wanted = [("README.md", "documentation")]
    if include_full:
        wanted += [("film_info.parquet", "information"), ("film_reviews.parquet", "ratings")]
    for name, kind in wanted:
        identity = identities.get(name)
        if identity is None:
            cache.note(dataset, kind, metadata_url, "not_listed",
                       f"Pinned repository does not list {name}.", "no guessed file URL", revision)
            continue
        lfs = identity.get("lfs") or {}
        expected_hash = lfs.get("sha256") or lfs.get("oid")
        if expected_hash and not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            expected_hash = None
        size = identity.get("size") or lfs.get("size")
        url = f"https://huggingface.co/datasets/{FILMAFFINITY_REPO}/resolve/{revision}/{quote(name)}"
        cache.fetch(dataset, kind, url, f"{dataset}/{name}", revision=revision,
                    scope="complete published file" if kind != "documentation" else "dataset card",
                    max_bytes=1024 * 1024 * 1024 if name.endswith(".parquet") else 8 * 1024 * 1024,
                    expected_size=size, expected_sha256=expected_hash,
                    expected_magic=b"PAR1" if name.endswith(".parquet") else None,
                    source_identity=identity)
    if not include_full:
        cache.note(dataset, "access_note", metadata_url, "not_requested", None,
                   "Parquet files deliberately omitted by --no-full-filmaffinity", revision)


def _github_files(cache, dataset, repository):
    commit_url = f"https://api.github.com/repos/{repository}/commits/master"
    commit_receipt = cache.fetch(dataset, "repository_metadata", commit_url,
                                 f"{dataset}/commit.json", scope="pin curator repository revision")
    commit = _json_asset(cache, commit_receipt)
    if commit is None:
        return None, {}
    revision = commit.get("sha")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        cache.note(dataset, "access_note", commit_url, "invalid_metadata", "Invalid GitHub commit SHA.",
                   "no guessed revision")
        return None, {}
    tree_url = f"https://api.github.com/repos/{repository}/git/trees/{revision}?recursive=1"
    tree_receipt = cache.fetch(dataset, "repository_tree", tree_url,
                               f"{dataset}/tree.json", scope="verify source paths and file identities",
                               revision=revision)
    tree = _json_asset(cache, tree_receipt)
    if tree is None or tree.get("truncated"):
        cache.note(dataset, "access_note", tree_url, "invalid_metadata",
                   "Repository tree is unavailable or truncated.", "no guessed source paths", revision)
        return revision, {}
    files = {entry["path"]: entry for entry in tree.get("tree", []) if entry.get("type") == "blob"}
    cache.manifest["datasets"][dataset] = {"repo": repository, "revision": revision,
                                         "discovered_file_count": len(files)}
    return revision, files


def _github_asset(cache, dataset, repository, revision, files, name, kind, scope, max_bytes=20 * 1024 * 1024):
    if name not in files:
        cache.note(dataset, kind, f"https://github.com/{repository}/tree/{revision}", "not_listed",
                   f"Source path not present: {name}", scope, revision)
        return
    identity = files[name]
    cache.fetch(dataset, kind, f"https://raw.githubusercontent.com/{repository}/{revision}/{quote(name)}",
                f"{dataset}/{name}", revision=revision, scope=scope, max_bytes=max_bytes,
                expected_size=identity.get("size"), source_identity=identity)


def _mal(cache):
    dataset = "mal2020"
    revision, files = _github_files(cache, dataset, MAL_REPO)
    if not files:
        return
    for name, kind, scope in [
        ("readme.md", "documentation", "curator README; population counts are claims, not measured samples"),
        ("data/readme.md", "documentation", "curator schema and sample limitations"),
        ("data/anime.csv", "information", "exact curator GitHub metadata file; inspect actual row count"),
        ("data/animelist.csv", "ratings_with_status", "curator's 500-line sample, not 109 million interactions"),
        ("data/rating_complete.csv", "ratings", "curator's 500-line sample, not 57 million ratings"),
        ("data/watching_status.csv", "status_codes", "watching-status definitions"),
    ]:
        _github_asset(cache, dataset, MAL_REPO, revision, files, name, kind, scope)
    licenses = [name for name in files if "/" not in name and name.lower().startswith(("license", "copying"))]
    if licenses:
        for name in licenses:
            _github_asset(cache, dataset, MAL_REPO, revision, files, name, "license", "curator license file")
    else:
        cache.note(dataset, "license", f"https://github.com/{MAL_REPO}/tree/{revision}", "not_listed", None,
                   "No standalone license file listed; no reuse permission inferred.", revision)
    cache.manifest["datasets"][dataset]["population_scope"] = "published GitHub samples only"


def _douban(cache):
    dataset = "douban10m"
    revision, files = _github_files(cache, dataset, DOUBAN_REPO)
    if files:
        for name, kind, scope in [
            ("docs/README.md", "documentation", "dataset schema, access instructions, and research-only terms"),
            ("README.MD", "documentation", "curator collection repository README"),
            ("scrapy/sql/douban.sql", "schema", "collector database schema, not proof of released CSV fields"),
            ("scrapy/douban/spiders/movie_subject.py", "collection_code", "verify hardcoded subject type policy"),
        ]:
            _github_asset(cache, dataset, DOUBAN_REPO, revision, files, name, kind, scope)
        for name in files:
            if "/" not in name and name.lower().startswith(("license", "copying")):
                _github_asset(cache, dataset, DOUBAN_REPO, revision, files, name, "license",
                              "collector code license; does not supersede dataset terms")
    cache.fetch(dataset, "sample_archive", DOUBAN_SAMPLE, f"{dataset}/moviedata_small.tar.gz",
                scope="published sample: documentation claims 1000 rows per file; inspect if accessible",
                max_bytes=20 * 1024 * 1024, expected_magic=b"\x1f\x8b")
    cache.note(dataset, "full_archive", "https://pan.baidu.com/s/1YdCTPOcnowJuP5XZrjOiVA", "restricted",
               "Curator documents a password obtained through WeChat. No login, follow, message, or access bypass attempted.",
               "full archive not downloaded; population counts and TV coverage unverified", revision)


def verify_cached_sources(root=ROOT):
    """Verify every successful asset without making any network requests."""
    manifest_path = Path(root).resolve() / CACHE_RELATIVE / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for receipt in manifest.get("assets", []):
        if receipt.get("final_url"):
            receipt["final_url"] = _public_redirect(receipt["final_url"])
        if receipt.get("status") != "ok":
            continue
        path = Path(receipt["local_path"])
        identity_size, identity_hash, identity_blob = _identity_expectations(receipt.get("source_identity"))
        if not path.is_file():
            receipt.update({"status": "missing_cache", "error": "Cached file is missing."})
        elif path.stat().st_size != receipt["bytes"] or sha256_file(path) != receipt["sha256"]:
            receipt.update({"status": "cache_mismatch", "error": "Cached size or SHA256 differs from receipt."})
        elif ((identity_size is not None and receipt["bytes"] != identity_size)
              or (identity_hash and receipt["sha256"] != identity_hash)
              or (identity_blob and _git_blob_sha1(path) != identity_blob)):
            receipt.update({"status": "source_identity_mismatch",
                            "error": "Cached bytes differ from the pinned repository file identity."})
        else:
            receipt["verified_at"] = _now()
    manifest["verification_fetcher_sha256"] = sha256_file(Path(__file__))
    manifest["last_verified_at"] = _now()
    _write_json(manifest_path, manifest)
    return manifest


def prepare_sources(root=ROOT, include_full_filmaffinity=True, *, offline=False):
    """Return a manifest of successful files and explicit unavailable/restricted sources."""
    if offline:
        return verify_cached_sources(root)
    directory = Path(root).resolve() / CACHE_RELATIVE
    manifest_path = directory / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    cache = _Cache(root, previous)
    _filmaffinity(cache, previous, include_full_filmaffinity)
    _mal(cache)
    _douban(cache)
    cache.manifest["updated_at"] = _now()
    cache.save()
    return cache.manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    parser.add_argument("--no-full-filmaffinity", action="store_true",
                        help="Fetch the FilmAffinity card and source identities without the Parquet files.")
    parser.add_argument("--offline", action="store_true", help="Verify saved files; make no network requests.")
    args = parser.parse_args()
    report = prepare_sources(args.project_root, not args.no_full_filmaffinity, offline=args.offline)
    for asset in report["assets"]:
        print(f"{asset['dataset']:15} {asset['kind']:22} {asset['status']:18} {asset.get('bytes', 0):>12,} bytes")
    if any(asset["status"] in {"missing_cache", "cache_mismatch", "source_identity_mismatch"}
           for asset in report["assets"]):
        raise SystemExit(1)
