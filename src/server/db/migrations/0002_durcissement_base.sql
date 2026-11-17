-- Attention : les CHECK sur `users` obligent drizzle-kit a recreer la table. `migrate()` s'execute dans une
-- transaction, ou `PRAGMA foreign_keys=OFF` est sans effet : le `DROP TABLE users` supprime donc en cascade toutes
-- les `sessions` (les membres, eux, sont copies a l'identique). Accepte avant la mise en production : simple
-- deconnexion. Apres la mise en production, ecrire ce genre de migration a la main pour preserver les sessions.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`role` text DEFAULT 'member' NOT NULL,
	`quota_override` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_login_at` integer,
	CONSTRAINT "users_role_check" CHECK("__new_users"."role" IN ('member', 'auto_approve', 'manager', 'owner')),
	CONSTRAINT "users_quota_override_json_check" CHECK("__new_users"."quota_override" IS NULL OR json_valid("__new_users"."quota_override"))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "avatar", "role", "quota_override", "created_at", "updated_at", "last_login_at") SELECT "id", "name", "avatar", "role", "quota_override", "created_at", "updated_at", "last_login_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);