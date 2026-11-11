/** The legacy liked field stores Favorites; score and watched state stay separate. */
export function validateTitleStatePatch(body) {
  const patch = {};
  for (const field of ['liked', 'watched']) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== 'boolean') throw new TypeError('Favorite and Watched must be true or false.');
    patch[field] = body[field];
  }
  if (!Object.keys(patch).length) throw new TypeError('Choose Favorite or Watched to update.');
  return patch;
}

/** Output filtering preserves every remaining frozen-model score and order.
 * @template {{movieId:number}} T
 * @param {{movies:T[],[key:string]:any}} result
 * @param {Array<{movieId:number,watched:boolean}>} states
 * @param {number} limit
 */
export function excludeWatched(result, states, limit) {
  const watched = new Set(states.filter(state => state.watched).map(state => state.movieId));
  return { ...result, movies: result.movies.filter(item => !watched.has(item.movieId)).slice(0, limit) };
}
