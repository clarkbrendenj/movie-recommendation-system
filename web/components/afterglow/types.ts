import { formatTitle } from '../../lib/title-format.mjs';

export type MediaType = "movies" | "series" | "both";
export type Tab = "movies" | "series" | "rate-movies" | "rate-series" | "watchlists" | "together" | "history";
export type TitleDetails = { displayTitle?: string; alternateTitle?: string; posterUrl?: string; cast?: string[]; directors?: string[]; creators?: string[]; seasonCount?: number; seasonCountAsOf?: string; endYear?: number; metadataSource?: { name: string; url: string }; creditsSource?: { name: string; url: string } };
export type Movie = TitleDetails & { movieId: number; title: string; genres: string[]; year: number | null; mediaType?: "movie" | "series" | "other"; legacyUnit?: "tvSeries" | "tvMiniSeries" | "tvEpisode"; reason?: string; popularity?: number };
export type Rating = { movieId: number; rating: number };
export type User = { id: string; userId?: string; username: string; displayName: string; friendCode: string };
export type Account = { user: User | null; ratings: Rating[]; ratingScale: 10; models?: { movies: { candidateCount: number }; series: { candidateCount: number } } };
export type Section = { movies: Movie[]; mode?: "starter" | "personalized" | "group"; likes?: number; ratingsCount?: number };
export type Recommendations = Section & { series?: Movie[]; sections?: { movies?: Section; series?: Section }; policy?: Record<string, unknown> };
export type MoviePage = { movies: Movie[]; total: number; page: number; pageSize: number; genres?: string[] };
export type Friend = { requestId: string; userId: string; username: string; displayName: string };
export type FriendRequest = { requestId: string; user: { userId: string; username: string; displayName: string } };
export type Friends = { friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[] };
export type ListMember = { userId: string; username: string; displayName: string; role: string };
export type SavedList = { id: string; name: string; kind: "watchlist" | "together"; mediaType: MediaType; ownerId: string; isOwner: boolean; itemCount: number; members: ListMember[]; createdAt?: string; updatedAt?: string };
export const EMPTY_FRIENDS: Friends = { friends: [], incoming: [], outgoing: [] };

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error(`The picture house could not complete this request (${response.status}). Please try again.`); }
  if (!response.ok) throw new Error(typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : `Request failed (${response.status}). Please try again.`);
  return data as T;
}
export function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
export function titleOf(movie: Movie) { return formatTitle(movie); }
export function mediaLabel(movie: Movie) { return movie.mediaType === "series" ? "Whole TV series" : movie.mediaType === "other" ? movie.legacyUnit === "tvEpisode" ? "TV episode · archive" : "TV title · archive" : "Movie"; }
export function mediaKind(movie: Movie): MediaType { return movie.mediaType === "series" ? "series" : "movies"; }
export function initials(name: string) { return name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase() || "A"; }
