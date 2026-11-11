"use client";

import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter, X } from "lucide-react";
import { sortCollection } from "../../lib/collection-sort.mjs";
import { EMPTY_FILTERS, filterCollection, getFilterError, getGenreOptions, hasActiveFilters } from "../../lib/collection-filter.mjs";
import { DEFAULT_SORT_DIRECTIONS, SortControls, type SortDirection, type SortField } from "./collection-sort";
import type { Movie, TitleState } from "./types";
import "./collection-filters.css";

export type ColumnField = Exclude<SortField, "original">;
type Choice = "all" | "yes" | "no";
export type CollectionFilters = {
  ratingStatus: "all" | "rated" | "unrated";
  ratingMin: string; ratingMax: string; genres: string[];
  yearMin: string; yearMax: string; favorite: Choice; watched: Choice;
};
export type CollectionQuery = {
  items: Movie[]; field: SortField; direction: SortDirection; filters: CollectionFilters;
  genreOptions: string[]; totalCount: number; visibleCount: number; error: string; active: boolean;
  setSort: (field: SortField, direction: SortDirection) => void;
  toggleSort: (field: ColumnField) => void;
  setFilters: Dispatch<SetStateAction<CollectionFilters>>;
  clearFilters: () => void; reset: () => void;
};
const FIELDS: readonly { field: ColumnField; label: string }[] = [
  { field: "rating", label: "Your rating" }, { field: "genre", label: "Genre" },
  { field: "year", label: "Year" }, { field: "favorite", label: "Favorite" }, { field: "watched", label: "Watched" },
];
function emptyFilters(): CollectionFilters { return { ...EMPTY_FILTERS, genres: [] } as CollectionFilters; }

/** Only browser display state; saved account data and model order remain intact. */
export function useCollectionQuery(items: Movie[], ratings: ReadonlyMap<number, number>, states: ReadonlyMap<number, TitleState>): CollectionQuery {
  const [field, setField] = useState<SortField>("original"), [direction, setDirection] = useState<SortDirection>("desc");
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters);
  const genreOptions = useMemo(() => getGenreOptions(items), [items]);
  const error = getFilterError(filters) || "";
  const visible = useMemo(() => sortCollection(filterCollection(items, { filters, ratings, states }),
    { field, direction, ratings, states }), [items, filters, field, direction, ratings, states]);
  function setSort(next: SortField, order: SortDirection) { setField(next); setDirection(order); }
  function toggleSort(next: ColumnField) { setSort(next, field === next ? direction === "asc" ? "desc" : "asc" : DEFAULT_SORT_DIRECTIONS[next]); }
  function clearFilters() { setFilters(emptyFilters()); }
  function reset() { clearFilters(); setSort("original", "desc"); }
  return { items: visible, field, direction, filters, genreOptions, totalCount: items.length, visibleCount: visible.length,
    error, active: hasActiveFilters(filters), setSort, toggleSort, setFilters, clearFilters, reset };
}

function fieldIsActive(field: ColumnField, filters: CollectionFilters) {
  if (field === "rating") return filters.ratingStatus !== "all" || filters.ratingMin !== "" || filters.ratingMax !== "";
  if (field === "genre") return filters.genres.length > 0;
  if (field === "year") return filters.yearMin !== "" || filters.yearMax !== "";
  return filters[field] !== "all";
}

function FilterFields({ field, query }: { field: ColumnField; query: CollectionQuery }) {
  const f = query.filters;
  function patch(value: Partial<CollectionFilters>) { query.setFilters(previous => ({ ...previous, ...value })); }
  if (field === "rating") return <div className="collection-filter-fields">
    <label>Rated status<select value={f.ratingStatus} onChange={event => { const ratingStatus = event.target.value as CollectionFilters["ratingStatus"]; patch({ ratingStatus, ...(ratingStatus === "unrated" ? { ratingMin: "", ratingMax: "" } : {}) }); }}><option value="all">All titles</option><option value="rated">Rated only</option><option value="unrated">Unrated only</option></select></label>
    <div className="collection-filter-range"><label>Minimum score<input type="number" min="1" max="10" step="0.1" inputMode="decimal" value={f.ratingMin} disabled={f.ratingStatus === "unrated"} onChange={event => patch({ ratingMin: event.target.value })} placeholder="Any" /></label><label>Maximum score<input type="number" min="1" max="10" step="0.1" inputMode="decimal" value={f.ratingMax} disabled={f.ratingStatus === "unrated"} onChange={event => patch({ ratingMax: event.target.value })} placeholder="Any" /></label></div>
    <p>Your saved 1–10 scores. Unrated titles are excluded when a score range is set.</p>
  </div>;
  if (field === "year") return <div className="collection-filter-fields"><div className="collection-filter-range"><label>From year<input type="number" min="1" max="9999" step="1" inputMode="numeric" value={f.yearMin} onChange={event => patch({ yearMin: event.target.value })} placeholder="Any" /></label><label>Through year<input type="number" min="1" max="9999" step="1" inputMode="numeric" value={f.yearMax} onChange={event => patch({ yearMax: event.target.value })} placeholder="Any" /></label></div><p>Includes both years. TV titles use their premiere year.</p></div>;
  if (field === "genre") return <div className="collection-filter-fields"><p>Match any selected genre, including secondary genres.</p><div className="collection-filter-checklist">{query.genreOptions.length ? query.genreOptions.map(genre => <label className="collection-filter-choice" key={genre}><input type="checkbox" checked={f.genres.includes(genre)} onChange={event => patch({ genres: event.target.checked ? [...f.genres, genre] : f.genres.filter(value => value !== genre) })} /><span>{genre}</span></label>) : <p>No genres available.</p>}</div></div>;
  const label = field === "favorite" ? "Favorite status" : "Watch status";
  return <label className="collection-filter-fields">{label}<select value={f[field]} onChange={event => patch({ [field]: event.target.value as Choice })}><option value="all">All titles</option><option value="yes">{field === "favorite" ? "Favorites only" : "Watched only"}</option><option value="no">{field === "favorite" ? "Non-favorites only" : "Unwatched only"}</option></select></label>;
}

export function ColumnFilterButton({ field, label, query, toolbar = false }: { field: ColumnField; label: string; query: CollectionQuery; toolbar?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const active = fieldIsActive(field, query.filters);
  function close(restore = false) { setPosition(null); if (restore) trigger.current?.focus(); }
  function open() {
    if (position) { close(); return; }
    const rect = trigger.current!.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - 312));
    const top = Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - 450));
    setPosition({ left, top });
  }
  useEffect(() => {
    if (!position) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("input,select,button")?.focus());
    function outside(event: PointerEvent) { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close(); }
    function key(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }
    function scroll(event: Event) { if (!panel.current?.contains(event.target as Node)) close(); }
    function resize() { close(); }
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true); window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); };
  }, [Boolean(position)]);
  function clearField() {
    query.setFilters(previous => field === "rating" ? { ...previous, ratingStatus: "all", ratingMin: "", ratingMax: "" }
      : field === "year" ? { ...previous, yearMin: "", yearMax: "" }
      : field === "genre" ? { ...previous, genres: [] } : { ...previous, [field]: "all" });
  }
  return <>
    <button ref={trigger} type="button" className={`collection-heading-filter ${active ? "is-active" : ""}`} aria-label={`Filter ${label}`} aria-expanded={Boolean(position)} aria-controls={position ? id : undefined} onClick={open}><Filter size={15} />{toolbar && <span>{label}</span>}</button>
    {position && createPortal(<div ref={panel} id={id} role="dialog" aria-label={`Filter ${label}`} aria-modal="false" className="collection-filter-popover" style={position}><div className="collection-filter-head"><strong>Filter {label}</strong><button type="button" aria-label={`Close ${label} filter`} onClick={() => close(true)}><X size={18} /></button></div><div className="collection-filter-body"><FilterFields field={field} query={query} />{query.error && <p className="collection-filter-error" role="alert">{query.error}</p>}</div><div className="collection-filter-footer"><button type="button" className="collection-filter-clear" onClick={clearField}>Clear this filter</button><button type="button" onClick={() => close(true)}>Done</button></div></div>, document.body)}
  </>;
}

export function CollectionColumnHeading({ field, label, query }: { field: ColumnField; label: string; query: CollectionQuery }) {
  const selected = query.field === field;
  const Icon = selected ? query.direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
  return <th scope="col" aria-sort={selected ? query.direction === "asc" ? "ascending" : "descending" : "none"}><div className="collection-column-heading"><button type="button" className="collection-heading-sort" onClick={() => query.toggleSort(field)} aria-label={`Sort by ${label}${selected ? `, currently ${query.direction === "asc" ? "ascending" : "descending"}` : ""}`}><span>{label}</span><Icon size={14} /></button><ColumnFilterButton field={field} label={label} query={query} /></div></th>;
}

export function CollectionQuerySummary({ query }: { query: CollectionQuery }) {
  return <div className="collection-query-summary" role="status"><span>{query.visibleCount} of {query.totalCount} titles{query.active ? " · filtered" : ""}</span>{query.active && <button type="button" className="collection-query-reset" onClick={query.clearFilters}>Clear all filters</button>}{query.field !== "original" && <button type="button" className="collection-query-reset" onClick={query.reset}>Reset view</button>}{query.error && <p className="collection-filter-error" role="alert">{query.error}</p>}</div>;
}

export function CollectionQueryControls({ query, label = "Sort and filter titles" }: { query: CollectionQuery; label?: string }) {
  return <section className="collection-query-toolbar" aria-label={label}><SortControls field={query.field} direction={query.direction} onChange={query.setSort} /><div className="collection-query-filter-buttons" role="group" aria-label="Column filters">{FIELDS.map(item => <ColumnFilterButton key={item.field} {...item} query={query} toolbar />)}</div><CollectionQuerySummary query={query} /></section>;
}
