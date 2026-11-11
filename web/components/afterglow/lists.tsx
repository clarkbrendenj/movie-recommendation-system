"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Bookmark, Check, Copy, LoaderCircle, Plus, RefreshCw, Trash2, Users, X } from "lucide-react";
import { api, EMPTY_FRIENDS, initials, mediaKind, message, titleOf, type Friend, type Friends, type MediaType, type Movie, type Recommendations, type SavedList, type Tab, type User } from "./types";
import { AuthGate, Busy, Empty, ErrorNotice, Modal, MovieGrid } from "./ui";
import { useCollectionView } from "./collection-view";
import { useTitleActivity } from "./activity";
import { SortControls, type SortField, type SortDirection } from "./collection-sort";
import { sortCollection } from "../../lib/collection-sort.mjs";
import "./list-view.css";

type ScreenProps = { kind: "watchlist" | "together"; user: User | null; ratings: Map<number, number>; onAuth: () => void; onRate: (movie: Movie) => void; onAdd: (movie: Movie) => void; onToast: (text: string) => void; onNavigate: (tab: Tab) => void; revision: number };

function TypeSelect({ value, onChange, disabled = false }: { value: MediaType; onChange: (value: MediaType) => void; disabled?: boolean }) {
  return <label className="form-field">Titles<select value={value} disabled={disabled} onChange={event => onChange(event.target.value as MediaType)}><option value="movies">Movies</option><option value="series">Whole TV series</option><option value="both">Movies and TV series</option></select></label>;
}

function ListFormDialog({ kind, user, existing, friends, onClose, onComplete }: { kind: "watchlist" | "together"; user: User; existing?: SavedList; friends: Friend[]; onClose: () => void; onComplete: (list: SavedList) => void }) {
  const [name, setName] = useState(existing?.name || ""), [mediaType, setMediaType] = useState<MediaType>(existing?.mediaType || "both"), [selected, setSelected] = useState(new Set(existing?.members.filter(member => member.userId !== user.id).map(member => member.userId) || [])), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const options = new Map(friends.map(friend => [friend.userId, { userId: friend.userId, displayName: friend.displayName, username: friend.username }]));
  for (const member of existing?.members || []) if (member.userId !== user.id && !options.has(member.userId)) options.set(member.userId, member);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      const data = await api<{ list: SavedList }>(existing ? `/api/lists/${existing.id}` : "/api/lists", { method: existing ? "PATCH" : "POST", body: JSON.stringify({ name,
        ...(existing ? {} : { kind, mediaType }), ...(kind === "together" ? { memberIds: [...selected] } : {}) }) });
      if (alive.current) onComplete(data.list);
    } catch (failure) { if (alive.current) setError(message(failure)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Modal title={existing ? "Edit this list" : kind === "together" ? "Create a Together list" : "Create a watchlist"} onClose={onClose} busy={busy}><span className="eyebrow">{kind === "together" ? "A SHARED NIGHT AT THE PICTURES" : "SOMETHING TO LOOK FORWARD TO"}</span><h2>{existing ? "Make it yours." : "Give your next watch a home."}</h2><form className="form-stack form-stack-list" onSubmit={submit}><label className="form-field">List name<input autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={80} placeholder={kind === "together" ? "Our Friday night" : "For a rainy Sunday"} disabled={busy} /></label><TypeSelect value={mediaType} onChange={setMediaType} disabled={busy || Boolean(existing)} />{existing && <p className="list-description">Title type stays fixed. Make another list for a different selection.</p>}{kind === "together" ? <fieldset className="member-picker"><legend>Choose your confirmed friends</legend><p className="list-description">Everyone keeps their own ratings. Only list members can see these shared picks.</p>{options.size ? [...options.values()].map(friend => <label className="member-row" key={friend.userId}><input type="checkbox" checked={selected.has(friend.userId)} disabled={busy || (!selected.has(friend.userId) && selected.size >= 7)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(friend.userId); else next.delete(friend.userId); return next; })} /><span className="member-avatar">{initials(friend.displayName)}</span><span><strong>{friend.displayName}</strong><small>@{friend.username}</small></span></label>) : <p>No confirmed friends yet. Send a friend request and wait for them to accept.</p>}<small>{selected.size} of 7 friends selected. You are included automatically.</small></fieldset> : <p className="list-description">This watchlist belongs to you. Saving a title does not rate it or tell the model you like it.</p>}{error && <ErrorNotice text={error} />}<button className="button burgundy-button primary-button" disabled={busy || (!existing && kind === "together" && !selected.size)} type="submit">{busy ? <LoaderCircle size={16} className="spinning" /> : <Check size={16} />}{existing ? "Save changes" : "Create list"}</button></form></Modal>;
}

function FriendManager({ user, data, loading, error, onRefresh, onToast }: { user: User; data: Friends; loading: boolean; error: string; onRefresh: () => void; onToast: (text: string) => void }) {
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function invite(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setFailure("");
    try { await api("/api/friends", { method: "POST", body: JSON.stringify({ friendCode: code }) }); if (alive.current) { setCode(""); onRefresh(); onToast("Friend request sent. They need to accept before you can make a list together."); } }
    catch (problem) { if (alive.current) setFailure(message(problem)); } finally { if (alive.current) setBusy(false); }
  }
  async function act(requestId: string, action: "accept" | "decline" | "cancel" | "remove") {
    if (busy) return; setBusy(true); setFailure("");
    try { await api("/api/friends", { method: "PATCH", body: JSON.stringify({ requestId, action }) }); if (alive.current) { onRefresh(); onToast(action === "accept" ? "Friend accepted. Your personal ratings stay private." : "Friend request updated."); } }
    catch (problem) { if (alive.current) setFailure(message(problem)); } finally { if (alive.current) setBusy(false); }
  }
  async function copy() { try { await navigator.clipboard.writeText(user.friendCode); if (alive.current) onToast("Friend code copied."); } catch { if (alive.current) setFailure("Select your friend code below and copy it to share."); } }
  return <section className="friend-panel" aria-label="Your friends"><div className="list-toolbar"><h3>Your picture club</h3><Users size={20} /></div><p className="list-description">Exchange codes, then accept a request. Shared picks use each person’s private profile; your scores are never shown to friends.</p><div className="friend-code"><span>Your friend code</span><code>{user.friendCode}</code><button className="icon-button" aria-label="Copy your friend code" onClick={() => void copy()}><Copy size={16} /></button></div><form className="form-stack" onSubmit={invite}><label className="form-field">A friend’s code<input value={code} onChange={event => setCode(event.target.value)} maxLength={64} placeholder="AG-…" disabled={busy} /></label><button className="button outline-button secondary-button" disabled={busy || !code.trim()}><Plus size={15} />Send request</button></form>{(failure || error) && <ErrorNotice text={failure || error} retry={onRefresh} />}{loading ? <Busy text="Opening your picture club…" /> : <>{data.incoming.length > 0 && <div className="friend-requests"><h4>Requests for you</h4>{data.incoming.map(request => <div className="member-row" key={request.requestId}><span className="member-avatar">{initials(request.user.displayName)}</span><span><strong>{request.user.displayName}</strong><small>@{request.user.username}</small></span><button className="icon-button" disabled={busy} aria-label={`Accept ${request.user.displayName}`} onClick={() => void act(request.requestId, "accept")}><Check size={16} /></button><button className="icon-button" disabled={busy} aria-label={`Decline ${request.user.displayName}`} onClick={() => void act(request.requestId, "decline")}><X size={16} /></button></div>)}</div>}{data.outgoing.length > 0 && <div className="friend-requests"><h4>Waiting for acceptance</h4>{data.outgoing.map(request => <div className="member-row" key={request.requestId}><span>{request.user.displayName}<small>@{request.user.username}</small></span><button className="text-button" disabled={busy} onClick={() => void act(request.requestId, "cancel")}>Cancel</button></div>)}</div>}<h4>Confirmed friends · {data.friends.length}</h4>{data.friends.length ? data.friends.map(friend => <div className="member-row" key={friend.userId}><span className="member-avatar">{initials(friend.displayName)}</span><span><strong>{friend.displayName}</strong><small>@{friend.username}</small></span></div>) : <p className="list-description">Your first shared watch night starts with a friend.</p>}</>}</section>;
}

export function ListsScreen(props: ScreenProps) {
  if (!props.user) return <AuthGate onSignIn={props.onAuth} title={props.kind === "together" ? "A good watch is better together." : "Save a story for later."} />;
  return <ListsSession key={`${props.user.id}:${props.kind}`} {...props} user={props.user} />;
}

function ListsSession({ kind, user, ratings, onRate, onAdd, onToast, onNavigate, revision }: ScreenProps & { user: User }) {
  const { view } = useCollectionView();
  const activity = useTitleActivity();
  const [sortField, setSortField] = useState<SortField>('original'), [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [lists, setLists] = useState<SavedList[]>([]), [selected, setSelected] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [detail, setDetail] = useState<{ list: SavedList; items: Movie[] } | null>(null), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState(""), [detailRevision, setDetailRevision] = useState(0);
  const [recommendations, setRecommendations] = useState<Recommendations | null>(null), [recLoading, setRecLoading] = useState(false), [recError, setRecError] = useState("");
  const [friends, setFriends] = useState<Friends>(EMPTY_FRIENDS), [friendsLoading, setFriendsLoading] = useState(false), [friendsError, setFriendsError] = useState(""), [friendsRevision, setFriendsRevision] = useState(0);
  const [form, setForm] = useState<"create" | "edit" | null>(null), [editing, setEditing] = useState<SavedList | undefined>(undefined), [confirm, setConfirm] = useState(false), [mutating, setMutating] = useState(false);
  const alive = useRef(true), loadTurn = useRef(0), viewHeading = useRef<HTMLHeadingElement>(null), overviewHeading = useRef<HTMLHeadingElement>(null), overviewScroll = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadTurn.current++; }; }, []);
  const refreshLists = useCallback(async (preferred?: string, signal?: AbortSignal) => {
    const turn = ++loadTurn.current; setLoading(true); setError("");
    try { const data = await api<{ lists: SavedList[] }>(`/api/lists?kind=${kind}`, { signal }); if (!alive.current || signal?.aborted || turn !== loadTurn.current) return; setLists(data.lists); setSelected(previous => preferred && data.lists.some(list => list.id === preferred) ? preferred : previous && data.lists.some(list => list.id === previous) ? previous : null); }
    catch (failure) { if (alive.current && !signal?.aborted && turn === loadTurn.current) setError(message(failure)); }
    finally { if (alive.current && !signal?.aborted && turn === loadTurn.current) setLoading(false); }
  }, [kind]);
  useEffect(() => { const controller = new AbortController(); void refreshLists(undefined, controller.signal); return () => controller.abort(); }, [refreshLists, revision]);
  useEffect(() => {
    if (kind !== "together") return;
    const controller = new AbortController(); setFriendsLoading(true); setFriendsError("");
    api<Friends>("/api/friends", { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setFriends(data); }).catch(failure => { if (!controller.signal.aborted) setFriendsError(message(failure)); }).finally(() => { if (!controller.signal.aborted) setFriendsLoading(false); });
    return () => controller.abort();
  }, [kind, friendsRevision]);
  useEffect(() => {
    if (!selected) { setDetail(null); setRecommendations(null); return; }
    const controller = new AbortController(); setDetail(null); setRecommendations(null); setDetailLoading(true); setDetailError(""); setRecError("");
    api<{ list: SavedList; items: Movie[] }>(`/api/lists/${selected}`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setDetail(data); }).catch(failure => { if (!controller.signal.aborted) setDetailError(message(failure)); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    if (kind === "together") { setRecLoading(true); api<Recommendations>(`/api/lists/${selected}/recommendations?limit=12`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setRecommendations(data); }).catch(failure => { if (!controller.signal.aborted) setRecError(message(failure)); }).finally(() => { if (!controller.signal.aborted) setRecLoading(false); }); }
    return () => controller.abort();
  }, [selected, kind, detailRevision, revision]);
  useEffect(() => {
    if (!selected) return;
    window.scrollTo({ top: 0, behavior: "instant" });
    const frame = requestAnimationFrame(() => viewHeading.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  function choose(id: string) { overviewScroll.current = window.scrollY; setDetail(null); setRecommendations(null); setSelected(id); setConfirm(false); }
  function backToLists() {
    const previous = selected;
    setSelected(null); setDetail(null); setRecommendations(null); setConfirm(false);
    requestAnimationFrame(() => {
      const opener = previous ? document.getElementById("list-card-" + previous) : null;
      (opener || overviewHeading.current)?.focus({ preventScroll: true });
      window.scrollTo({ top: overviewScroll.current, behavior: "instant" });
    });
  }
  async function removeItem(movie: Movie) {
    if (!selected || mutating) return; setMutating(true);
    try { await api(`/api/lists/${selected}/items?movieId=${movie.movieId}`, { method: "DELETE" }); if (alive.current) { setDetailRevision(value => value + 1); void refreshLists(); onToast("Title removed from this list."); } }
    catch (failure) { if (alive.current) onToast(message(failure)); } finally { if (alive.current) setMutating(false); }
  }
  async function saveTogether(movie: Movie) {
    if (!selected || mutating) return; setMutating(true);
    try { await api(`/api/lists/${selected}/items`, { method: "POST", body: JSON.stringify({ movieId: movie.movieId }) }); if (alive.current) { setDetailRevision(value => value + 1); void refreshLists(); onToast("Saved for everyone on this list. Your ratings stay separate."); } }
    catch (failure) { if (alive.current) onToast(message(failure)); } finally { if (alive.current) setMutating(false); }
  }
  async function deleteOrLeave() {
    if (!selected || mutating) return; setMutating(true);
    try { await api(`/api/lists/${selected}`, { method: "DELETE" }); if (alive.current) { backToLists(); void refreshLists(); onToast(detail?.list.isOwner ? "List deleted. Your ratings are unchanged." : "You left the list. Your ratings are unchanged."); } }
    catch (failure) { if (alive.current) onToast(message(failure)); } finally { if (alive.current) setMutating(false); }
  }
  const shown = detail?.list;
  const sortedSavedItems = useMemo(() => sortCollection(detail?.items || [],
    { field: sortField, direction: sortDirection, ratings, states: activity.states }), [detail?.items, sortField, sortDirection, ratings, activity.states]);
  const preview = lists.find(list => list.id === selected);
  return <>
    {selected ? <section className="list-focused-view list-detail" aria-labelledby="list-view-title" data-list-view="focused">
      <div className="list-focus-topbar">
        <button className="list-back-button" onClick={backToLists}><ArrowLeft size={19} />Back to {kind === "together" ? "Together lists" : "watchlists"}</button>
        <span className="list-view-badge">{kind === "together" ? "TOGETHER LIST" : "PRIVATE WATCHLIST"}</span>
      </div>
      <header className="list-focus-heading">
        <div><span className="eyebrow">{kind === "together" ? "YOUR SHARED SELECTION" : "SAVED FOR A GOOD NIGHT"}</span>
          <h1 id="list-view-title" ref={viewHeading} tabIndex={-1}>{shown?.name || preview?.name || "Opening your list…"}</h1>
          <p>{kind === "together" ? "Recommendations and saved plans for the people on this list." : "Your own collection of movies and whole series to watch later."}</p>
        </div>
        {shown && <div className="list-controls">
          {kind === "together" && <button className="button outline-button secondary-button" onClick={() => setDetailRevision(value => value + 1)} disabled={recLoading}><RefreshCw size={17} />Refresh picks</button>}
          {shown.isOwner && <button className="button outline-button secondary-button" onClick={() => { setEditing(shown); setForm("edit"); }}>Edit list</button>}
          <button className="button outline-button secondary-button" onClick={() => setConfirm(true)}><Trash2 size={16} />{shown.isOwner ? "Delete list" : "Leave list"}</button>
        </div>}
      </header>
      {detailError ? <ErrorNotice text={detailError} retry={() => setDetailRevision(value => value + 1)} /> : detailLoading ? <Busy text="Opening this list…" /> : shown && <>
        {kind === "together" && <>
          <div className="list-members">{shown.members.map(member => <span className="member-row" key={member.userId}><span className="member-avatar">{initials(member.displayName)}</span><span>{member.displayName}{member.userId === user.id ? " (you)" : ""}</span></span>)}</div>
          <p className="list-description">Picks balance everyone’s ranked preferences and leave out titles anyone has rated, watched, or favorited. Movies and series each have their own section.</p>
          {recError ? <ErrorNotice text={recError} retry={() => setDetailRevision(value => value + 1)} /> : recLoading ? <Busy text="Finding common ground…" /> : <>
            {recommendations?.sections?.movies && <section className="group-shelf"><h2>Movie recommendations for everyone</h2>
              {recommendations.sections.movies.movies.length ? <MovieGrid movies={recommendations.sections.movies.movies} ratings={ratings} onRate={onRate} onAdd={movie => void saveTogether(movie)} /> : <p className="list-description">No unseen movie candidates are available for this group.</p>}
            </section>}
            {recommendations?.sections?.series && <section className="group-shelf"><h2>TV recommendations for everyone</h2>
              {recommendations.sections.series.movies.length ? <MovieGrid movies={recommendations.sections.series.movies} ratings={ratings} onRate={onRate} onAdd={movie => void saveTogether(movie)} /> : <p className="list-description">No unseen series candidates are available for this group.</p>}
            </section>}
          </>}
        </>}
        <section className="list-saved-section" aria-label={kind === "together" ? "Saved for this group" : "Saved for later"}>
          <div className="list-toolbar"><h2>{kind === "together" ? "Saved for this group" : "Saved for later"}</h2><span>{detail.items.length} titles</span></div>
          {detail.items.length > 0 && <SortControls field={sortField} direction={sortDirection} onChange={(field, direction) => { setSortField(field); setSortDirection(direction); }} label="Sort saved titles" />}
          {detail.items.length ? <MovieGrid movies={sortedSavedItems} ratings={ratings} onRate={onRate} onAdd={onAdd} onRemove={movie => void removeItem(movie)} /> :
            <Empty title={kind === "together" ? "Make a plan from your shared picks." : "A good story deserves a spot."} action={kind === "watchlist" ? <button className="button outline-button secondary-button" onClick={() => onNavigate(shown.mediaType === "series" ? "series" : "movies")}>Find something to save <ArrowRight size={16} /></button> : undefined}>
              {kind === "together" ? "Save a recommendation above to keep it here for everyone. Refreshing your picks never removes saved titles." : "Choose Save on any movie or series to keep it here. A watchlist is a plan, not a rating."}
            </Empty>}
        </section>
      </>}
    </section> : <>
      <div className="page-intro"><div><span className="eyebrow">{kind === "together" ? "MORE THAN ONE GOOD TASTE" : "FOR A NIGHT YET TO COME"}</span>
        <h1 ref={overviewHeading} tabIndex={-1}>{kind === "together" ? "Your Together lists." : "Your private watchlists."}</h1>
        <p>{kind === "together" ? "Open a list to see a dedicated selection for everyone watching. Individual ratings stay private." : "Open a list to see the movies and whole series you saved for later."}</p>
      </div><button className="button burgundy-button primary-button" onClick={() => setForm("create")}><Plus size={17} />{kind === "together" ? "New Together list" : "New watchlist"}</button></div>
      <div className={"list-overview-layout" + (kind === "watchlist" ? " is-private" : "")}>
        <section className="list-overview" aria-label="Your saved lists">
          <div className="list-toolbar"><h2>Your lists</h2><span>{lists.length}</span></div>
          {error ? <ErrorNotice text={error} retry={() => void refreshLists()} /> : loading ? <Busy text="Opening your lists…" /> : lists.length ? view === 'compact' ? <div className="collection-table-scroll" role="region" aria-label="Your saved lists" tabIndex={0}><table className="collection-table list-overview-table"><caption className="sr-only">{kind === 'together' ? 'Together recommendation lists' : 'Private watchlists'}</caption><thead><tr><th scope="col">List</th><th scope="col">Titles</th><th scope="col">Type</th><th scope="col">Members</th><th scope="col">Open</th></tr></thead><tbody>{lists.map(list => <tr key={list.id}><th scope="row"><button type="button" id={'list-card-' + list.id} className="list-overview-name" onClick={() => choose(list.id)}>{list.name}</button></th><td>{list.itemCount}</td><td>{list.mediaType === 'both' ? 'Movies & series' : list.mediaType === 'series' ? 'Whole TV series' : 'Movies'}</td><td>{kind === 'together' ? list.members.length : 'Only you'}</td><td><button type="button" className="text-button" aria-label={'Open ' + list.name} onClick={() => choose(list.id)}>Open list <ArrowRight size={16} /></button></td></tr>)}</tbody></table></div> : <div className="list-grid">
            {lists.map(list => <button key={list.id} id={"list-card-" + list.id} className="list-card list-open-card" aria-label={"Open " + list.name} onClick={() => choose(list.id)}>
              <span className="list-card-icon">{kind === "together" ? <Users size={22} /> : <Bookmark size={22} />}</span>
              <strong>{list.name}</strong>
              <span>{list.mediaType === "both" ? "Movies & series" : list.mediaType === "series" ? "Whole TV series" : "Movies"} · {list.itemCount} saved{kind === "together" ? " · " + list.members.length + " members" : ""}</span>
              <span className="list-open-label">Open list <ArrowRight size={17} /></span>
            </button>)}
          </div> : <Empty title={kind === "together" ? "Your next shared night starts here." : "A place for your next great watch."}>
            {kind === "together" ? "Exchange friend codes, accept a request, and give your first shared list a name." : "Create a private watchlist, then save titles as you find them."}
          </Empty>}
        </section>
        {kind === "together" && <aside className="list-overview-friends"><FriendManager user={user} data={friends} loading={friendsLoading} error={friendsError} onRefresh={() => setFriendsRevision(value => value + 1)} onToast={onToast} /></aside>}
      </div>
    </>}
    {form && <ListFormDialog kind={kind} user={user} existing={form === "edit" ? editing : undefined} friends={friends.friends} onClose={() => setForm(null)} onComplete={list => { setForm(null); setDetailRevision(value => value + 1); void refreshLists(list.id); onToast("List saved."); }} />}
    {confirm && shown && <Modal title={shown.isOwner ? "Delete this list?" : "Leave this list?"} onClose={() => setConfirm(false)} busy={mutating}>
      <h2>{shown.isOwner ? "Close this chapter?" : "Leave this shared selection?"}</h2>
      <p>{shown.isOwner ? "This removes the list and its saved titles for all members. Everyone keeps their own ratings." : "You will lose access to this list. Your personal ratings stay with your account."}</p>
      <div className="dialog-actions"><button className="button outline-button secondary-button" onClick={() => setConfirm(false)} disabled={mutating}>Keep it</button>
        <button className="button burgundy-button primary-button" onClick={() => void deleteOrLeave()} disabled={mutating}>{mutating ? <LoaderCircle className="spinning" size={16} /> : <Trash2 size={16} />}{shown.isOwner ? "Delete list" : "Leave list"}</button>
      </div>
    </Modal>}
  </>;
}

export function AddToListDialog({ movie, onClose, onAdded }: { movie: Movie; onClose: () => void; onAdded: () => void }) {
  const [lists, setLists] = useState<SavedList[]>([]), [selected, setSelected] = useState(""), [create, setCreate] = useState(false), [name, setName] = useState(""), [mediaType, setMediaType] = useState<MediaType>(mediaKind(movie)), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; const controller = new AbortController(); api<{ lists: SavedList[] }>("/api/lists?kind=watchlist", { signal: controller.signal }).then(data => { if (controller.signal.aborted) return; const compatible = data.lists.filter(list => list.mediaType === "both" || list.mediaType === mediaKind(movie)); setLists(compatible); setSelected(compatible[0]?.id || ""); setCreate(!compatible.length); }).catch(failure => { if (!controller.signal.aborted) setError(message(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => { alive.current = false; controller.abort(); }; }, [movie.movieId]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      let id = selected;
      if (create) { const data = await api<{ list: SavedList }>("/api/lists", { method: "POST", body: JSON.stringify({ kind: "watchlist", name, mediaType }) }); id = data.list.id; if (!alive.current) return; setLists(previous => [...previous, data.list]); setSelected(id); setCreate(false); }
      if (!id) throw new Error("Choose a watchlist or create one.");
      await api(`/api/lists/${id}/items`, { method: "POST", body: JSON.stringify({ movieId: movie.movieId }) });
      if (alive.current) { onAdded(); onClose(); }
    } catch (failure) { if (alive.current) setError(message(failure)); } finally { if (alive.current) setBusy(false); }
  }
  return <Modal title={`Save ${titleOf(movie)}`} onClose={onClose} busy={busy}><span className="eyebrow">KEEP A LITTLE ANTICIPATION</span><h2>Save it for a good night.</h2><p>{titleOf(movie)}</p>{movie.mediaType === "other" ? <ErrorNotice text="This archive title can keep its rating, but it is not eligible for a new watchlist." /> : loading ? <Busy text="Opening your watchlists…" /> : <form className="form-stack" onSubmit={save}>{lists.length > 0 && <label className="form-field">Watchlist<select value={create ? "new" : selected} onChange={event => { setCreate(event.target.value === "new"); if (event.target.value !== "new") setSelected(event.target.value); }} disabled={busy}>{lists.map(list => <option value={list.id} key={list.id}>{list.name}</option>)}<option value="new">Create a new watchlist…</option></select></label>}{create && <><label className="form-field">New list name<input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Something for later" disabled={busy} /></label><label className="form-field">Titles<select value={mediaType} disabled={busy} onChange={event => setMediaType(event.target.value as MediaType)}><option value={mediaKind(movie)}>{movie.mediaType === "series" ? "Whole TV series" : "Movies"}</option><option value="both">Movies and TV series</option></select></label></>}{error && <ErrorNotice text={error} />}<button className="button burgundy-button primary-button" disabled={busy || (!create && !selected)}>{busy ? <LoaderCircle size={16} className="spinning" /> : <Bookmark size={16} />}Save to watchlist</button><p className="list-description">Only you can see this watchlist. Saving does not change your rating or recommendations.</p></form>}</Modal>;
}
