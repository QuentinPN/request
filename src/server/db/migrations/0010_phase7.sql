CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_created_by_idx` ON `api_keys` (`created_by`);--> statement-breakpoint
CREATE TABLE `arr_servers` (
	`id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`api_key` text NOT NULL,
	`is_4k` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`quality_profile_id` integer NOT NULL,
	`root_folder_path` text NOT NULL,
	`minimum_availability` text,
	`series_type` text,
	`language_profile_id` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "arr_servers_type_check" CHECK("arr_servers"."type" IN ('radarr', 'sonarr')),
	CONSTRAINT "arr_servers_minimum_availability_check" CHECK("arr_servers"."minimum_availability" IN ('announced', 'inCinemas', 'released')),
	CONSTRAINT "arr_servers_series_type_check" CHECK("arr_servers"."series_type" IN ('standard', 'anime', 'daily')),
	CONSTRAINT "arr_servers_tags_json_check" CHECK(json_valid("arr_servers"."tags") AND json_type("arr_servers"."tags") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arr_servers_default_unique` ON `arr_servers` (`type`,`is_4k`) WHERE "arr_servers"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `blocked_titles` (
	`id` integer PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text NOT NULL,
	`blocked_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`blocked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "blocked_titles_media_type_check" CHECK("blocked_titles"."media_type" IN ('movie', 'tv'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_titles_media_type_tmdb_id_unique` ON `blocked_titles` (`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `blocked_titles_blocked_by_idx` ON `blocked_titles` (`blocked_by`) WHERE "blocked_titles"."blocked_by" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `issue_comments` (
	`id` integer PRIMARY KEY NOT NULL,
	`issue_id` integer NOT NULL,
	`user_id` text,
	`message` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_comments_issue_id_created_at_idx` ON `issue_comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `issue_comments_user_id_idx` ON `issue_comments` (`user_id`) WHERE "issue_comments"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY NOT NULL,
	`media_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`season_number` integer,
	`episode_number` integer,
	`message` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "issues_type_check" CHECK("issues"."type" IN ('video', 'audio', 'subtitles', 'other')),
	CONSTRAINT "issues_status_check" CHECK("issues"."status" IN ('open', 'resolved')),
	CONSTRAINT "issues_episode_check" CHECK("issues"."episode_number" IS NULL OR "issues"."season_number" IS NOT NULL),
	CONSTRAINT "issues_resolved_check" CHECK(("issues"."status" = 'resolved') = ("issues"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `issues_status_created_at_idx` ON `issues` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `issues_user_id_created_at_idx` ON `issues` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `issues_media_id_status_idx` ON `issues` (`media_id`,`status`);--> statement-breakpoint
CREATE INDEX `issues_resolved_by_idx` ON `issues` (`resolved_by`) WHERE "issues"."resolved_by" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_id_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `seasons_4k` (
	`id` integer PRIMARY KEY NOT NULL,
	`media_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`status` text NOT NULL,
	`episodes_present` integer,
	`episodes_expected` integer,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "seasons_4k_status_check" CHECK("seasons_4k"."status" IN ('available', 'partial', 'downloading', 'requested', 'pending', 'declined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_4k_media_id_season_number_unique` ON `seasons_4k` (`media_id`,`season_number`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text,
	`year` integer,
	`poster_path` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "watchlist_media_type_check" CHECK("watchlist"."media_type" IN ('movie', 'tv')),
	CONSTRAINT "watchlist_source_check" CHECK("watchlist"."source" IN ('manual', 'trakt', 'letterboxd'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_user_id_media_type_tmdb_id_unique` ON `watchlist` (`user_id`,`media_type`,`tmdb_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_id` integer,
	`issue_id` integer,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notifications_kind_check" CHECK("__new_notifications"."kind" IN ('requested', 'approved', 'declined', 'available', 'failed', 'requested_on_behalf', 'issue_created', 'issue_commented', 'issue_resolved', 'issue_reopened'))
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "user_id", "kind", "request_id", "detail", "created_at", "read_at") SELECT "id", "user_id", "kind", "request_id", "detail", "created_at", "read_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notifications_user_id_created_at_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`user_id`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX `notifications_request_id_idx` ON `notifications` (`request_id`) WHERE "notifications"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notifications_issue_id_idx` ON `notifications` (`issue_id`) WHERE "notifications"."issue_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `media` ADD `radarr_4k_id` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `sonarr_4k_id` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `status_4k` text CONSTRAINT "media_status_4k_check" CHECK("status_4k" IN ('available', 'partial', 'downloading', 'requested', 'pending', 'declined'));--> statement-breakpoint
CREATE INDEX `media_radarr_4k_id_idx` ON `media` (`radarr_4k_id`) WHERE "media"."radarr_4k_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `media_sonarr_4k_id_idx` ON `media` (`sonarr_4k_id`) WHERE "media"."sonarr_4k_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `requests` ADD `server_id` integer REFERENCES `arr_servers`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `requests` ADD `quota_exempt` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `requests` ADD `created_by` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `requests_created_at_idx` ON `requests` (`created_at`);--> statement-breakpoint
CREATE INDEX `requests_server_id_idx` ON `requests` (`server_id`) WHERE "requests"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `requests_created_by_idx` ON `requests` (`created_by`) WHERE "requests"."created_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `email_notifications` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `push_notifications` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Reprise des réglages `radarr` et `sonarr` : un serveur chacun, par défaut, non 4K. La clé d'API est copiée telle
-- quelle, déjà chiffrée (même clé `secret.key`, même format `v1:…`). Les réglages d'origine restent en place.
INSERT INTO `arr_servers` (`type`, `name`, `url`, `api_key`, `is_4k`, `is_default`, `quality_profile_id`, `root_folder_path`, `minimum_availability`)
SELECT 'radarr', 'Radarr', json_extract(`value`, '$.url'), json_extract(`value`, '$.apiKey'), 0, 1,
  json_extract(`value`, '$.qualityProfileId'), json_extract(`value`, '$.rootFolderPath'),
  coalesce(json_extract(`value`, '$.minimumAvailability'), 'released')
FROM `settings`
WHERE `key` = 'radarr' AND json_valid(`value`)
  AND json_extract(`value`, '$.url') IS NOT NULL AND json_extract(`value`, '$.apiKey') IS NOT NULL
  AND json_extract(`value`, '$.qualityProfileId') IS NOT NULL AND json_extract(`value`, '$.rootFolderPath') IS NOT NULL;--> statement-breakpoint
INSERT INTO `arr_servers` (`type`, `name`, `url`, `api_key`, `is_4k`, `is_default`, `quality_profile_id`, `root_folder_path`, `series_type`, `language_profile_id`)
SELECT 'sonarr', 'Sonarr', json_extract(`value`, '$.url'), json_extract(`value`, '$.apiKey'), 0, 1,
  json_extract(`value`, '$.qualityProfileId'), json_extract(`value`, '$.rootFolderPath'),
  coalesce(json_extract(`value`, '$.seriesType'), 'standard'), json_extract(`value`, '$.languageProfileId')
FROM `settings`
WHERE `key` = 'sonarr' AND json_valid(`value`)
  AND json_extract(`value`, '$.url') IS NOT NULL AND json_extract(`value`, '$.apiKey') IS NOT NULL
  AND json_extract(`value`, '$.qualityProfileId') IS NOT NULL AND json_extract(`value`, '$.rootFolderPath') IS NOT NULL;
