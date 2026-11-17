CREATE TABLE `request_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`request_id` integer NOT NULL,
	`type` text NOT NULL,
	`actor_id` text,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "request_events_type_check" CHECK("request_events"."type" IN ('requested', 'approved', 'declined', 'cancelled', 'sent', 'failed', 'retried', 'available'))
);
--> statement-breakpoint
CREATE INDEX `request_events_request_id_created_at_idx` ON `request_events` (`request_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `request_events_actor_id_idx` ON `request_events` (`actor_id`) WHERE "request_events"."actor_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `request_seasons` (
	`request_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	PRIMARY KEY(`request_id`, `season_number`),
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY NOT NULL,
	`media_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decline_reason` text,
	`quality_profile_id` integer,
	`root_folder` text,
	`series_type` text,
	`is_4k` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "requests_status_check" CHECK("requests"."status" IN ('pending', 'approved', 'declined', 'cancelled', 'sent', 'failed', 'available')),
	CONSTRAINT "requests_series_type_check" CHECK("requests"."series_type" IN ('standard', 'anime', 'daily'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_active` ON `requests` (`media_id`,`user_id`,`is_4k`) WHERE "requests"."status" IN ('pending', 'approved', 'sent', 'failed');--> statement-breakpoint
CREATE INDEX `requests_user_id_created_at_idx` ON `requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_status_created_at_idx` ON `requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_media_id_status_idx` ON `requests` (`media_id`,`status`);--> statement-breakpoint
CREATE INDEX `requests_decided_by_idx` ON `requests` (`decided_by`) WHERE "requests"."decided_by" IS NOT NULL;