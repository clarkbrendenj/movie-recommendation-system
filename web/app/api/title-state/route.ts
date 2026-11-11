import { getAppUser } from '../../../lib/auth';
import { getUserTitleStates, updateTitleState, validateActivityTitle } from '../../../lib/server-title-state';
import { validateTitleStatePatch } from '../../../lib/title-state-policy.mjs';
import { api, ApiError, json, jsonBody, positiveInteger, requireUser, sameOrigin } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return api(async () => {
    const user = await getAppUser(request);
    if (!user) throw new ApiError(401, 'Sign in to view your activity.');
    return json({ titleStates: await getUserTitleStates(user.userId) });
  }, request);
}

export async function PUT(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const user = await requireUser(request), body = await jsonBody(request);
    const movieId = positiveInteger(body.movieId, 'title ID');
    let patch: {liked?: boolean; watched?: boolean};
    try { patch = validateTitleStatePatch(body); }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Invalid activity.'); }
    await validateActivityTitle(movieId);
    const state = await updateTitleState(user.userId, movieId, patch);
    return json({ ok: true, state, ...(patch.watched === false ? { ratingRemoved: true } : {}) });
  }, request);
}
