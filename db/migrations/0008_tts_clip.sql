CREATE TABLE `tts_clip` (
	`key` text PRIMARY KEY NOT NULL,
	`audio` blob NOT NULL,
	`chars` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_played_at` integer
);
