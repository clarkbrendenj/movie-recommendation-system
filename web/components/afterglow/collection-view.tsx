"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LayoutGrid, List } from "lucide-react";
import "./collection-view.css";

type CollectionView = "posters" | "compact";
const STORAGE_KEY = "afterglow.collection-view.v1";
const CollectionViewContext = createContext<{ view: CollectionView; setView: (view: CollectionView) => void }>({ view: "posters", setView: () => {} });

/** This browser-only presentation preference contains no account or title data. */
export function CollectionViewProvider({ children }: { children: ReactNode }) {
  const [view, updateView] = useState<CollectionView>("posters");
  useEffect(() => {
    try { if (localStorage.getItem(STORAGE_KEY) === "compact") updateView("compact"); } catch { /* Browsing still works when storage is unavailable. */ }
  }, []);
  function setView(next: CollectionView) {
    updateView(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the preference for this visit. */ }
  }
  return <CollectionViewContext.Provider value={{ view, setView }}>{children}</CollectionViewContext.Provider>;
}

export function useCollectionView() { return useContext(CollectionViewContext); }

export function CollectionViewToggle() {
  const { view, setView } = useCollectionView();
  return <div className="collection-view-toolbar"><span>View</span><div className="collection-view-toggle" role="group" aria-label="Title listing view">
    <button type="button" aria-pressed={view === "posters"} onClick={() => setView("posters")}><LayoutGrid size={16} /><span>Posters</span></button>
    <button type="button" aria-pressed={view === "compact"} onClick={() => setView("compact")}><List size={17} /><span>Compact</span></button>
  </div></div>;
}
