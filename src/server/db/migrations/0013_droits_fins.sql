ALTER TABLE `users` ADD `permissions` text CONSTRAINT "users_permissions_json_check" CHECK("permissions" IS NULL OR (json_valid("permissions") AND json_type("permissions") = 'object'));
