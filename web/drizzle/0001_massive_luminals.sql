CREATE TABLE `auth_rate_limits` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `friendships` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`pair_key` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "friendships_distinct_users" CHECK("friendships"."requester_id" <> "friendships"."recipient_id"),
	CONSTRAINT "friendships_valid_status" CHECK("friendships"."status" IN ('pending','accepted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friendships_pair_unique` ON `friendships` (`pair_key`);--> statement-breakpoint
CREATE TABLE `list_items` (
	`list_id` text NOT NULL,
	`movie_id` integer NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`list_id`, `movie_id`),
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "list_items_valid_title" CHECK("list_items"."movie_id" > 0)
);
--> statement-breakpoint
CREATE TABLE `list_members` (
	`list_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`list_id`, `user_id`),
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "list_members_valid_role" CHECK("list_members"."role" IN ('owner','member'))
);
--> statement-breakpoint
CREATE INDEX `list_members_user` ON `list_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`media_type` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lists_valid_kind" CHECK("lists"."kind" IN ('watchlist','recommendation')),
	CONSTRAINT "lists_valid_media_type" CHECK("lists"."media_type" IN ('movies','series','both'))
);
--> statement-breakpoint
CREATE INDEX `lists_owner` ON `lists` (`owner_id`);--> statement-breakpoint
CREATE TABLE `rating_queue_statuses` (
	`user_id` text NOT NULL,
	`movie_id` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `movie_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rating_queue_valid_title" CHECK("rating_queue_statuses"."movie_id" > 0),
	CONSTRAINT "rating_queue_valid_status" CHECK("rating_queue_statuses"."status" IN ('skip','unseen'))
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_digest` text NOT NULL,
	`friend_code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_friend_code_unique` ON `users` (`friend_code`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ratings` (
	`user_id` text NOT NULL,
	`movie_id` integer NOT NULL,
	`rating` real NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `movie_id`),
	CONSTRAINT "ratings_valid_movie" CHECK("__new_ratings"."movie_id" > 0),
	CONSTRAINT "ratings_valid_value" CHECK("__new_ratings"."rating" >= 0.5 AND "__new_ratings"."rating" <= 5 AND ABS("__new_ratings"."rating" * 20 - ROUND("__new_ratings"."rating" * 20)) < 0.00000001)
);
--> statement-breakpoint
INSERT INTO `__new_ratings`("user_id", "movie_id", "rating", "updated_at") SELECT "user_id", "movie_id", "rating", "updated_at" FROM `ratings`;--> statement-breakpoint
DROP TABLE `ratings`;--> statement-breakpoint
ALTER TABLE `__new_ratings` RENAME TO `ratings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;