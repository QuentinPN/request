ALTER TABLE `requests` ADD `external_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `requests_external_ref_unique` ON `requests` (`external_ref`);