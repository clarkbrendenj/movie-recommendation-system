"use client";

import "./collection-sort.css";

export type SortField = "original" | "rating" | "genre" | "favorite" | "year" | "watched";
export type SortDirection = "asc" | "desc";

export const DEFAULT_SORT_DIRECTIONS: Record<SortField, SortDirection> = {
  original: "asc", rating: "desc", genre: "asc", favorite: "desc", year: "desc", watched: "desc",
};
const ORDER_LABELS: Record<Exclude<SortField, "original">, Record<SortDirection, string>> = {
  rating: { asc: "Lowest rated first", desc: "Highest rated first" },
  genre: { asc: "A–Z", desc: "Z–A" },
  favorite: { asc: "Non-favorites first", desc: "Favorites first" },
  year: { asc: "Oldest first", desc: "Newest first" },
  watched: { asc: "Unwatched first", desc: "Watched first" },
};

export function SortControls({ field, direction, onChange, label = "Sort titles" }: {
  field: SortField;
  direction: SortDirection;
  onChange: (field: SortField, direction: SortDirection) => void;
  label?: string;
}) {
  return <div className="collection-sort" role="group" aria-label={label}>
    <label className="collection-sort-field">
      <span className="collection-sort-label">Sort by</span>
      <select className="collection-sort-select" value={field} onChange={event => {
        const next = event.target.value as SortField;
        onChange(next, DEFAULT_SORT_DIRECTIONS[next]);
      }}>
        <option value="original">Original order</option>
        <option value="rating">Your rating</option>
        <option value="genre">Genre</option>
        <option value="favorite">Favorite</option>
        <option value="year">Year</option>
        <option value="watched">Watched</option>
      </select>
    </label>
    {field !== "original" && <label className="collection-sort-field">
      <span className="collection-sort-label">Order</span>
      <select className="collection-sort-select" value={direction} onChange={event => onChange(field, event.target.value as SortDirection)}>
        <option value="asc">{ORDER_LABELS[field].asc}</option>
        <option value="desc">{ORDER_LABELS[field].desc}</option>
      </select>
    </label>}
    {field === "rating" && <span className="collection-sort-hint">Your saved scores; unrated titles last.</span>}
  </div>;
}
