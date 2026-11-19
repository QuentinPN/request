-- Lot 8.8 : règles de surcharge (Seerr `OverrideRule`). Une table neuve, aucune donnée existante touchée : relue à la
-- main après `drizzle-kit generate` (aucune reconstruction). Conditions et étiquettes en listes JSON vérifiées par
-- `CHECK` ; supprimer un serveur supprime ses règles (`ON DELETE CASCADE`, index `server_id`).
CREATE TABLE `override_rules` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`server_id` integer NOT NULL,
	`genres` text DEFAULT '[]' NOT NULL,
	`languages` text DEFAULT '[]' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`quality_profile_id` integer,
	`root_folder_path` text,
	`series_type` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`position` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `arr_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "override_rules_type_check" CHECK("override_rules"."type" IN ('movie', 'tv')),
	CONSTRAINT "override_rules_series_type_check" CHECK("override_rules"."series_type" IN ('standard', 'anime', 'daily')),
	CONSTRAINT "override_rules_movie_series_type_check" CHECK("override_rules"."type" = 'tv' OR "override_rules"."series_type" IS NULL),
	CONSTRAINT "override_rules_genres_json_check" CHECK(json_valid("override_rules"."genres") AND json_type("override_rules"."genres") = 'array'),
	CONSTRAINT "override_rules_languages_json_check" CHECK(json_valid("override_rules"."languages") AND json_type("override_rules"."languages") = 'array'),
	CONSTRAINT "override_rules_keywords_json_check" CHECK(json_valid("override_rules"."keywords") AND json_type("override_rules"."keywords") = 'array'),
	CONSTRAINT "override_rules_tags_json_check" CHECK(json_valid("override_rules"."tags") AND json_type("override_rules"."tags") = 'array')
);
--> statement-breakpoint
CREATE INDEX `override_rules_server_id_idx` ON `override_rules` (`server_id`);