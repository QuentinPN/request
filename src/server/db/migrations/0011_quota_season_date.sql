CREATE TABLE `__new_request_seasons` (
	`request_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`request_id`, `season_number`),
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_request_seasons`(`request_id`, `season_number`, `created_at`) SELECT s.`request_id`, s.`season_number`, r.`created_at` FROM `request_seasons` s JOIN `requests` r ON r.`id` = s.`request_id`;--> statement-breakpoint
DROP TABLE `request_seasons`;--> statement-breakpoint
ALTER TABLE `__new_request_seasons` RENAME TO `request_seasons`;
