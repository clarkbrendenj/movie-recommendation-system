import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../db";
import { friends, listItems, listMembers, lists, users } from "../db/schema";
import { ApiError } from "../app/api/_shared";
import { getModelMetadata, getMovieUnitOverlay, getTvModelMetadata } from "./server-model";
import { movieCandidateIds, movieCard } from "./media-catalog.mjs";
import { listPermission } from "./collaboration-policy.mjs";

export type StoredList = typeof lists.$inferSelect;
export const MAX_MEMBERS = 8;

export function listId(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ApiError(404, "List not found.");
  return value;
}

export function listName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f]/.test(value)) {
    throw new ApiError(400, "Give the list a name from 1 to 80 characters.");
  }
  return value.trim();
}

export function memberIds(value: unknown, ownerId: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length >= MAX_MEMBERS || value.some((id) => typeof id !== "string" || !id || id.length > 100 || id === ownerId)
    || new Set(value).size !== value.length) throw new ApiError(400, "Choose up to seven different friends.");
  return value as string[];
}

export async function assertConfirmedFriends(ownerId: string, selected: string[]) {
  if (!selected.length) return;
  const rows = await getDb().select().from(friends).where(and(eq(friends.status, "accepted"),
    or(eq(friends.requesterId, ownerId), eq(friends.recipientId, ownerId))));
  const confirmed = new Set(rows.map((row) => row.requesterId === ownerId ? row.recipientId : row.requesterId));
  if (selected.some((id) => !confirmed.has(id))) throw new ApiError(403, "Only confirmed friends can join your list.");
}

export async function accessibleList(id: string, userId: string) {
  const [row] = await getDb().select({ list: lists }).from(lists).innerJoin(listMembers,
    and(eq(listMembers.listId, lists.id), eq(listMembers.userId, userId))).where(eq(lists.id, id)).limit(1);
  if (!row) throw new ApiError(404, "List not found.");
  return row.list;
}

export async function describeLists(rows: StoredList[], userId: string) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [members, totals] = await Promise.all([
    getDb().select({ listId: listMembers.listId, userId: users.id, username: users.username,
      displayName: users.displayName, role: listMembers.role }).from(listMembers)
      .innerJoin(users, eq(users.id, listMembers.userId)).where(inArray(listMembers.listId, ids)).orderBy(asc(listMembers.joinedAt), asc(users.id)),
    getDb().select({ listId: listItems.listId, total: count() }).from(listItems).where(inArray(listItems.listId, ids)).groupBy(listItems.listId),
  ]);
  const counts = new Map(totals.map((row) => [row.listId, row.total]));
  return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind === "recommendation" ? "together" : "watchlist",
    mediaType: row.mediaType, ownerId: row.ownerId, isOwner: row.ownerId === userId,
    createdAt: row.createdAt, updatedAt: row.updatedAt, itemCount: counts.get(row.id) || 0,
    members: members.filter((member) => member.listId === row.id).map(({ listId: _listId, ...member }) => member) }));
}

export async function describeList(row: StoredList, userId: string) {
  return (await describeLists([row], userId))[0];
}

export async function requireListManager(row: StoredList, userId: string) {
  const descriptor = await describeList(row, userId);
  if (!listPermission(descriptor, userId, "manage")) throw new ApiError(403, "Only the list owner can change its settings.");
  return descriptor;
}

export async function currentCatalog() {
  const [movieMetadata, tvMetadata, overlay] = await Promise.all([getModelMetadata(), getTvModelMetadata(), getMovieUnitOverlay()]);
  const eligible = movieCandidateIds(movieMetadata, overlay);
  const movies = movieMetadata.movies.filter((item) => eligible.has(item.movieId)).map((item) => movieCard(item, overlay));
  const series = tvMetadata.items.filter((item) => item.mediaType === "series" && item.eligible && item.candidate);
  const byId = new Map<number, { movieId: number; mediaType: string; [key: string]: unknown }>([...movies, ...series].map((item) => [item.movieId, item]));
  return { movies, series, byId, movieMetadata, tvMetadata, overlay };
}

export async function getSavedItems(id: string) {
  const [entries, catalog] = await Promise.all([
    getDb().select().from(listItems).where(eq(listItems.listId, id)).orderBy(asc(listItems.createdAt), asc(listItems.movieId)),
    currentCatalog(),
  ]);
  return entries.map((entry) => {
    const visible = catalog.byId.get(entry.movieId);
    const legacy = catalog.movieMetadata.movies.find((item) => item.movieId === entry.movieId);
    const item = visible || (legacy ? movieCard(legacy, catalog.overlay) : {
      movieId: entry.movieId, title: "Unavailable saved title", genres: [], year: null, mediaType: "other", source: "saved", sourceId: String(entry.movieId),
    });
    return { ...item, addedBy: entry.addedBy, addedAt: entry.createdAt };
  });
}

export function itemFitsList(item: { mediaType: string }, row: StoredList) {
  return row.mediaType === "both" || (row.mediaType === "movies" && item.mediaType === "movie")
    || (row.mediaType === "series" && item.mediaType === "series");
}
