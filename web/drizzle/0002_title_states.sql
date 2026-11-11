CREATE TABLE `title_states` (
  `user_id` text NOT NULL,
  `movie_id` integer NOT NULL,
  `liked` integer DEFAULT 0 NOT NULL,
  `watched` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`user_id`, `movie_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT "title_states_valid_title" CHECK("title_states"."movie_id" > 0),
  CONSTRAINT "title_states_valid_liked" CHECK("title_states"."liked" IN (0,1)),
  CONSTRAINT "title_states_valid_watched" CHECK("title_states"."watched" IN (0,1))
);
--> statement-breakpoint
-- Preserve scores and only backfill verified app-account owners, not legacy IDs.
-- updated_at is an activity timestamp, never an inferred viewing date.
INSERT INTO `title_states` (`user_id`, `movie_id`, `liked`, `watched`, `updated_at`)
SELECT r.`user_id`, r.`movie_id`, 0, 1, r.`updated_at`
FROM `ratings` r INNER JOIN `users` u ON u.`id` = r.`user_id`;
