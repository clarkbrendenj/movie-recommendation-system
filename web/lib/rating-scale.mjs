import { isValidRating } from "./recommender.mjs";

export const DISPLAY_RATING_SCALE = 10;

/** @param {unknown} rating */
export function isValidDisplayRating(rating) {
  return typeof rating === "number" && Number.isInteger(rating)
    && rating >= 1 && rating <= DISPLAY_RATING_SCALE;
}

/** Convert the app's 1–10 score to the trained model's half-star scale. @param {number} rating */
export function displayToModel(rating) {
  if (!isValidDisplayRating(rating)) throw new RangeError("Rating must be an integer from 1 to 10.");
  return rating / 2;
}

/** Existing database ratings keep their meaning when shown on the new scale. @param {number} rating */
export function modelToDisplay(rating) {
  if (!isValidRating(rating)) throw new RangeError("Stored rating must use the model's 0.5–5 scale.");
  return rating * 2;
}
