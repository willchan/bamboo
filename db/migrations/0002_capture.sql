CREATE TABLE `import` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`source_ref` text,
	`conversation_title` text,
	`discord_channel_id` text,
	`discord_message_id` text,
	`idempotency_key` text,
	`turns_total` integer NOT NULL,
	`turns_new` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`jobs_failed` integer DEFAULT 0 NOT NULL,
	`phrases_new` integer DEFAULT 0 NOT NULL,
	`phrases_again` integer DEFAULT 0 NOT NULL,
	`uploaded_at` integer,
	`summary` text,
	`notified_at` integer,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_idempotency_key_unique` ON `import` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `import_created_at_idx` ON `import` (`created_at`);--> statement-breakpoint
CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`import_id` text NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`model` text,
	`prompt_version` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`import_id`) REFERENCES `import`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_status_created_idx` ON `job` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `job_import_idx` ON `job` (`import_id`);--> statement-breakpoint
CREATE TABLE `turn` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`turn_key` text NOT NULL,
	`user_text` text NOT NULL,
	`reply_text` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text,
	`extracted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `import`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_turn_key_unique` ON `turn` (`turn_key`);--> statement-breakpoint
CREATE INDEX `turn_import_idx` ON `turn` (`import_id`);--> statement-breakpoint
ALTER TABLE `phrase` ADD `last_asked_import_id` text;