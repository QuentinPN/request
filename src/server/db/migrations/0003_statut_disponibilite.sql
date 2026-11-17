CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`detail` text,
	CONSTRAINT "job_runs_status_check" CHECK("job_runs"."status" IN ('running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_running` ON `job_runs` (`job`) WHERE "job_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `job_runs_job_started_at_idx` ON `job_runs` (`job`,`started_at`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`tvdb_id` integer,
	`radarr_id` integer,
	`sonarr_id` integer,
	`emby_item_id` text,
	`status` text,
	`status_updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "media_type_check" CHECK("media"."type" IN ('movie', 'tv')),
	CONSTRAINT "media_status_check" CHECK("media"."status" IN ('available', 'partial', 'downloading', 'requested', 'pending', 'declined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_type_tmdb_id_unique` ON `media` (`type`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `media_tvdb_id_idx` ON `media` (`tvdb_id`) WHERE "media"."tvdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `media_radarr_id_idx` ON `media` (`radarr_id`) WHERE "media"."radarr_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `media_sonarr_id_idx` ON `media` (`sonarr_id`) WHERE "media"."sonarr_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` integer PRIMARY KEY NOT NULL,
	`media_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "seasons_status_check" CHECK("seasons"."status" IN ('available', 'partial', 'downloading', 'requested', 'pending', 'declined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_media_id_season_number_unique` ON `seasons` (`media_id`,`season_number`);