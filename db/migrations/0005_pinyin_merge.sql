CREATE TABLE `pinyin_job` (
	`id` text PRIMARY KEY NOT NULL,
	`phrase_id` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`model` text,
	`prompt_version` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `pinyin_job_status_created_idx` ON `pinyin_job` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `pinyin_job_phrase_idx` ON `pinyin_job` (`phrase_id`);--> statement-breakpoint
ALTER TABLE `phrase` ADD `pinyin_sources` text;