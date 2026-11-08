import { sql } from "drizzle-orm";
import { check, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Identity comes from ChatGPT sign-in. Ratings are always queried with userId.
export const ratings = sqliteTable("ratings", {
  userId: text("user_id").notNull(),
  movieId: integer("movie_id").notNull(),
  rating: real("rating").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.movieId] }),
  check("ratings_valid_movie", sql`${table.movieId} > 0`),
  check("ratings_valid_value", sql`${table.rating} >= 0.5 AND ${table.rating} <= 5 AND ${table.rating} * 2 = CAST(${table.rating} * 2 AS INTEGER)`),
]);
