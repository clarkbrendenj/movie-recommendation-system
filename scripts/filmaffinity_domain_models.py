"""Pure training and target-domain scoring helpers for notebook 19.

The caller supplies training feedback and the matching training-only catalog.
These helpers do no I/O and do not know about validation or test feedback.
"""

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.preprocessing import normalize

from scripts.filmaffinity_experiment import (
    LIKE_THRESHOLD,
    TOP_K,
    build_content_features,
    quality_prior,
)


def fit_training_basis(train, catalog, user_ids):
    """Fit one shared or one type-specific basis in a fixed user namespace.

    All supplied users retain their row, including users without feedback in a
    type-specific frame. Catalog IDs must be exactly the frame's training IDs:
    held-out-only titles cannot enter feature fitting or candidates. Catalog
    order and user order are preserved rather than silently sorted.

    The Bayesian prior uses only this frame's ratings and global mean. For an
    independently fitted movie/TV model that means its own domain's center.
    """
    required_feedback = {"user_id", "item_id", "rating"}
    required_catalog = {"item_id", "synopsis", "film_genre", "film_cast"}
    if not required_feedback.issubset(train.columns):
        raise ValueError("Training feedback requires user_id, item_id and rating.")
    if not required_catalog.issubset(catalog.columns):
        raise ValueError("Training catalog requires item_id, synopsis, film_genre and film_cast.")
    if train.empty or catalog.empty:
        raise ValueError("A nonempty training frame and matching catalog are required.")
    users = list(user_ids)
    if not users or any(pd.isna(user) for user in users) or len(set(users)) != len(users):
        raise ValueError("The fixed user namespace must be nonempty, unique and nonmissing.")
    if train[["user_id", "item_id"]].isna().any().any():
        raise ValueError("Training identities must not be missing.")
    if train.duplicated(["user_id", "item_id"]).any():
        raise ValueError("Training feedback must contain unique user/item pairs.")
    if catalog.item_id.isna().any() or catalog.item_id.duplicated().any():
        raise ValueError("Training catalog IDs must be unique and nonmissing.")
    if not set(train.user_id).issubset(set(users)):
        raise ValueError("Training feedback contains users outside the fixed namespace.")
    ids = catalog.item_id.tolist()
    if set(ids) != set(train.item_id):
        raise ValueError("Catalog IDs must exactly match training feedback item IDs.")
    ratings = pd.to_numeric(train.rating, errors="coerce")
    if not ratings.between(1, 10).all():
        raise ValueError("Training ratings must be finite scores in [1,10].")
    feedback = train.copy()
    feedback["rating"] = ratings
    training_catalog = catalog.copy(deep=True).reset_index(drop=True)
    user_index = {user: row for row, user in enumerate(users)}
    item_index = {item: col for col, item in enumerate(ids)}
    rows = feedback.user_id.map(user_index).to_numpy(dtype=np.int64)
    cols = feedback.item_id.map(item_index).to_numpy(dtype=np.int64)
    shape = (len(users), len(ids))
    seen = sparse.csr_matrix(
        (np.ones(len(feedback), dtype=np.float32), (rows, cols)), shape=shape
    )
    positive = ratings.to_numpy() >= LIKE_THRESHOLD
    likes = sparse.csr_matrix(
        (np.ones(int(positive.sum()), dtype=np.float32), (rows[positive], cols[positive])),
        shape=shape,
    )
    content = build_content_features(training_catalog)
    cf = normalize(likes.T.tocsr()).astype(np.float32)
    return {
        "user_ids": users,
        "item_ids": ids,
        "catalog": training_catalog,
        "seen": seen,
        "likes": likes,
        "features": {
            "cf": cf,
            **{name: content[name] for name in ("synopsis", "genres", "cast")},
        },
        "content_encoders": content["encoders"],
        "content_idf": content["idf"],
        "popularity": np.asarray(likes.sum(axis=0)).ravel(),
        "quality": quality_prior(feedback, ids, strength=20),
        "like_threshold": LIKE_THRESHOLD,
        "top_k": TOP_K,
    }


def domain_components(model, profile, candidate_columns, seen):
    """Score a target catalog while allowing a profile from the full model.

    Profile columns align with model.item_ids. Candidate indices select target
    rows from the same feature basis. Every component is max-scaled over unseen
    target items only; seen items and an all-zero component return zero. Genre
    and cast are scaled separately and averaged equally for metadata. This
    keeps the scoring convention fixed across shared-history, restricted-
    history and independently fitted basis comparisons.
    """
    if not sparse.issparse(profile) or profile.ndim != 2:
        raise ValueError("Profiles must be a sparse batch-by-model-item matrix.")
    if profile.shape[1] != len(model["item_ids"]):
        raise ValueError("Profile columns do not align with the model's item IDs.")
    if not np.isfinite(profile.data).all() or (profile.data < 0).any():
        raise ValueError("Profile values must be finite and nonnegative.")
    columns = np.asarray(candidate_columns)
    if columns.ndim != 1 or columns.dtype.kind not in "iu":
        raise ValueError("Candidate columns must be a one-dimensional integer array.")
    if len(np.unique(columns)) != len(columns):
        raise ValueError("Candidate columns must be unique.")
    if (columns < 0).any() or (columns >= len(model["item_ids"])).any():
        raise ValueError("A candidate column falls outside the model catalog.")
    blocked = np.asarray(seen, dtype=bool)
    if blocked.shape != (profile.shape[0], len(columns)):
        raise ValueError("Seen mask must align with the batch and target candidates.")
    result = {}
    for name in ("cf", "synopsis", "genres", "cast"):
        features = model["features"][name]
        if features.shape[0] != len(model["item_ids"]):
            raise ValueError("Item feature rows do not align with the model catalog.")
        preference = (profile @ features).tocsr()
        if name != "cf":
            preference = normalize(preference)
        scores = (preference @ features[columns].T).toarray().astype(np.float32, copy=False)
        scores[blocked] = 0
        maximum = scores.max(axis=1, keepdims=True, initial=0)
        result[name] = np.divide(
            scores, maximum, out=np.zeros_like(scores), where=maximum > 0
        )
    result["metadata"] = (result.pop("genres") + result.pop("cast")) / 2
    return result
