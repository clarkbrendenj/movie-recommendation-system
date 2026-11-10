import { isValidRating } from "./recommender.mjs";

export const DISPLAY_RATING_SCALE = 10;

/** @param {unknown} rating */
export function isValidDisplayRating(rating) {
  return typeof rating === "number" && Number.isFinite(rating)
    && Math.abs(rating * 10 - Math.round(rating * 10)) < 1e-8
    && rating >= 1 && rating <= DISPLAY_RATING_SCALE;
}

/** Convert a 1–10 score in tenths to the model scale without rounding. @param {number} rating */
export function displayToModel(rating) {
  if (!isValidDisplayRating(rating)) throw new RangeError("Rating must be from 1 to 10 in steps of 0.1.");
  return Math.round(rating * 10) / 20;
}

/** Existing database ratings keep their meaning when shown on the new scale. @param {number} rating */
export function modelToDisplay(rating) {
  if (!isValidRating(rating)) throw new RangeError("Stored rating must use the model's 0.5–5 scale in steps of 0.05.");
  return Math.round(rating * 20) / 10;
}
