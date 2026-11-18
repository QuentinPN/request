ALTER TABLE `arr_servers` ADD `tag_requester` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `arr_servers` ADD `search_on_add` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `arr_servers` ADD `external_url` text;--> statement-breakpoint
ALTER TABLE `arr_servers` ADD `anime_quality_profile_id` integer;--> statement-breakpoint
ALTER TABLE `arr_servers` ADD `anime_root_folder_path` text;--> statement-breakpoint
ALTER TABLE `arr_servers` ADD `anime_series_type` text CONSTRAINT "arr_servers_anime_series_type_check" CHECK("anime_series_type" IN ('standard', 'anime', 'daily'));--> statement-breakpoint
ALTER TABLE `arr_servers` ADD `anime_language_profile_id` integer;--> statement-breakpoint
ALTER TABLE `arr_servers` ADD `anime_tags` text DEFAULT '[]' NOT NULL CONSTRAINT "arr_servers_anime_tags_json_check" CHECK(json_valid("anime_tags") AND json_type("anime_tags") = 'array');
