import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Legacy platform-owned rows remain intact. New users have app-owned identities.
export const ratings = sqliteTable("ratings", {
  userId: text("user_id").notNull(),
  movieId: integer("movie_id").notNull(),
  rating: real("rating").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.movieId] }),
  check("ratings_valid_movie", sql`${table.movieId} > 0`),
  check("ratings_valid_value", sql`${table.rating} >= 0.5 AND ${table.rating} <= 5 AND ABS(${table.rating} * 20 - ROUND(${table.rating} * 20)) < 0.00000001`),
]);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  passwordDigest: text("password_digest").notNull(),
  friendCode: text("friend_code").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, table => [uniqueIndex("users_username_unique").on(table.username), uniqueIndex("users_friend_code_unique").on(table.friendCode)]);

export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, table => [index("auth_sessions_user").on(table.userId), index("auth_sessions_expiry").on(table.expiresAt)]);

export const authRateLimits = sqliteTable("auth_rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStartedAt: integer("window_started_at").notNull(),
});

export const friends = sqliteTable("friendships", {
  id: text("id").primaryKey(),
  requesterId: text("requester_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  recipientId: text("recipient_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  pairKey: text("pair_key").notNull(),
  status: text("status", { enum: ["pending", "accepted"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [uniqueIndex("friendships_pair_unique").on(table.pairKey),
  check("friendships_distinct_users", sql`${table.requesterId} <> ${table.recipientId}`),
  check("friendships_valid_status", sql`${table.status} IN ('pending','accepted')`)]);

export const lists = sqliteTable("lists", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["watchlist", "recommendation"] }).notNull(),
  mediaType: text("media_type", { enum: ["movies", "series", "both"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [index("lists_owner").on(table.ownerId),
  check("lists_valid_kind", sql`${table.kind} IN ('watchlist','recommendation')`),
  check("lists_valid_media_type", sql`${table.mediaType} IN ('movies','series','both')`)]);

export const listMembers = sqliteTable("list_members", {
  listId: text("list_id").notNull().references(() => lists.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull(),
}, table => [primaryKey({ columns: [table.listId, table.userId] }), index("list_members_user").on(table.userId),
  check("list_members_valid_role", sql`${table.role} IN ('owner','member')`)]);

export const listItems = sqliteTable("list_items", {
  listId: text("list_id").notNull().references(() => lists.id, { onDelete: "cascade" }),
  movieId: integer("movie_id").notNull(),
  addedBy: text("added_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, table => [primaryKey({ columns: [table.listId, table.movieId] }), check("list_items_valid_title", sql`${table.movieId} > 0`)]);

export const ratingQueueStatuses = sqliteTable("rating_queue_statuses", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  movieId: integer("movie_id").notNull(),
  status: text("status", { enum: ["skip", "unseen"] }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [primaryKey({ columns: [table.userId, table.movieId] }),
  check("rating_queue_valid_title", sql`${table.movieId} > 0`),
  check("rating_queue_valid_status", sql`${table.status} IN ('skip','unseen')`)]);

// Expressive likes are independent of numeric scores and model thresholds.
export const titleStates = sqliteTable("title_states", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  movieId: integer("movie_id").notNull(),
  liked: integer("liked", { mode: "boolean" }).notNull().default(false),
  watched: integer("watched", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [primaryKey({ columns: [table.userId, table.movieId] }),
  check("title_states_valid_title", sql`${table.movieId} > 0`),
  check("title_states_valid_liked", sql`${table.liked} IN (0,1)`),
  check("title_states_valid_watched", sql`${table.watched} IN (0,1)`)]);
