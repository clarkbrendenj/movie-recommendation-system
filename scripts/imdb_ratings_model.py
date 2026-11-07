"""Vote-aware IMDb quality prior and a neutral-missing personalized reranker."""

import numpy as np


def rating_prior(records, item_ids, prior_votes=1000.0):
    """Fit C on rated training candidates; shrink each rating toward C.

    This is our smoothing rule, not a reproduction of IMDb's internal weighting.
    Missing observations receive C and hence exactly zero centered adjustment.
    """
    if not np.isfinite(prior_votes) or prior_votes <= 0:
        raise ValueError("prior_votes must be finite and positive.")
    item_ids = np.asarray(item_ids)
    if item_ids.ndim != 1 or not len(item_ids) or len(set(item_ids)) != len(item_ids):
        raise ValueError("Require a nonempty, unique candidate vector.")
    lookup = {int(row["movieId"]): row for row in records}
    averages = np.array([lookup.get(int(item), {}).get("averageRating") or np.nan for item in item_ids], dtype=float)
    votes = np.array([lookup.get(int(item), {}).get("numVotes") or 0 for item in item_ids], dtype=float)
    covered = (np.isfinite(averages) & (averages >= 1) & (averages <= 10)
               & np.isfinite(votes) & (votes > 0) & (votes == np.floor(votes)))
    if not covered.any():
        raise ValueError("No usable IMDb ratings among training candidates.")
    center = float(averages[covered].mean())
    smoothed = np.full(len(item_ids), center)
    reliability = votes[covered] / (votes[covered] + prior_votes)
    smoothed[covered] = center + reliability * (averages[covered] - center)
    adjustment = (smoothed - center) / 9.0
    return {"center": center, "smoothed": smoothed, "adjustment": adjustment, "covered": covered}


def rerank_with_ratings(base_scores, adjustment, weight, seen_mask):
    """Scale base by its unseen maximum, then add a bounded quality adjustment.

    Seen items are excluded by the final ranker. A zero weight reproduces base
    rankings, including the popularity/movie-ID tiebreaks used by notebook 09.
    """
    base = np.asarray(base_scores, dtype=float)
    adjustment = np.asarray(adjustment, dtype=float)
    seen = np.asarray(seen_mask, dtype=bool)
    if (base.ndim != 2 or base.shape != seen.shape or adjustment.shape != (base.shape[1],)
            or not np.isfinite(base).all() or (base < 0).any()
            or not np.isfinite(adjustment).all() or (np.abs(adjustment) > 1).any()
            or not np.isfinite(weight) or not 0 <= weight <= 1):
        raise ValueError("Require aligned finite scores, bounded adjustments, and weight in [0, 1].")
    maximum = np.where(seen, 0.0, base).max(axis=1, keepdims=True)
    scaled = np.divide(base, maximum, out=np.zeros_like(base), where=maximum > 0)
    return scaled + weight * adjustment[None, :]
