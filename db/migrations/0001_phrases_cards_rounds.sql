CREATE TABLE `card` (
	`id` text PRIMARY KEY NOT NULL,
	`phrase_id` text NOT NULL,
	`type` text NOT NULL,
	`due` integer NOT NULL,
	`stability` real DEFAULT 0 NOT NULL,
	`stability_fast` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 0 NOT NULL,
	`scheduled_days` real DEFAULT 0 NOT NULL,
	`learning_steps` integer DEFAULT 0 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`state` integer DEFAULT 0 NOT NULL,
	`schedule_status` text DEFAULT 'new' NOT NULL,
	`last_review` integer,
	`buried_until` integer,
	`suspended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`phrase_id`) REFERENCES `phrase`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_phrase_type_unique` ON `card` (`phrase_id`,`type`);--> statement-breakpoint
CREATE INDEX `card_due_idx` ON `card` (`due`);--> statement-breakpoint
CREATE TABLE `phrase` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`kind` text NOT NULL,
	`hanzi` text NOT NULL,
	`hanzi_key` text NOT NULL,
	`english` text NOT NULL,
	`addressee` text,
	`heard_as` text,
	`examples` text DEFAULT '[]' NOT NULL,
	`note` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`pinyin` text NOT NULL,
	`pinyin_override` text,
	`usefulness` integer,
	`turn_kind` text,
	`base_score` real NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`pinned_at` integer,
	`source` text NOT NULL,
	`source_turn_id` text,
	`asked_count` integer DEFAULT 1 NOT NULL,
	`last_asked_at` integer NOT NULL,
	`flags` text DEFAULT '[]' NOT NULL,
	`introduced_at` integer,
	`dropped_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `phrase_hanzi_key_unique` ON `phrase` (`hanzi_key`);--> statement-breakpoint
CREATE INDEX `phrase_status_idx` ON `phrase` (`status`);--> statement-breakpoint
CREATE TABLE `review_log` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`rating` integer NOT NULL,
	`source` text NOT NULL,
	`state_before` integer NOT NULL,
	`round_id` text,
	`reviewed_at` integer NOT NULL,
	`duration_ms` integer,
	`fsrs_log` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`round_id`) REFERENCES `round`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_log_reviewed_at_idx` ON `review_log` (`reviewed_at`);--> statement-breakpoint
CREATE INDEX `review_log_card_idx` ON `review_log` (`card_id`);--> statement-breakpoint
CREATE TABLE `round` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`cards` integer DEFAULT 0 NOT NULL,
	`card_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_type_at_idx` ON `event` (`type`,`at`);