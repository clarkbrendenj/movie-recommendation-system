CREATE TABLE `ratings` (
	`user_id` text NOT NULL,
	`movie_id` integer NOT NULL,
	`rating` real NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `movie_id`),
	CONSTRAINT "ratings_valid_movie" CHECK("ratings"."movie_id" > 0),
	CONSTRAINT "ratings_valid_value" CHECK("ratings"."rating" >= 0.5 AND "ratings"."rating" <= 5 AND "ratings"."rating" * 2 = CAST("ratings"."rating" * 2 AS INTEGER))
);
