DROP INDEX `requests_active`;--> statement-breakpoint
CREATE UNIQUE INDEX `requests_active` ON `requests` (`media_id`,`user_id`,`is_4k`) WHERE "requests"."status" IN ('pending', 'approved', 'failed');