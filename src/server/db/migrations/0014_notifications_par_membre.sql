-- Lot 8.10. Écrite à la main : drizzle-kit recréait `users` pour ajouter la contrainte, ce qui effacerait les sessions
-- (`ON DELETE CASCADE`) ; deux `ALTER TABLE ADD` conservent tout.
ALTER TABLE `users` ADD `notification_types` text CONSTRAINT "users_notification_types_json_check" CHECK("notification_types" IS NULL OR (json_valid("notification_types") AND json_type("notification_types") = 'object'));--> statement-breakpoint
-- Option du membre pour la demande automatique depuis Ma liste : lue par un lot suivant, pas encore exposée.
ALTER TABLE `users` ADD `watchlist_auto_request` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- `notifications.kind` accepte `auto_approved` : le `CHECK` d'une table ne se modifie pas, on la recrée (modèle de
-- 0010). Aucune table ne référence `notifications.id` : `DROP TABLE` ne supprime rien d'autre ; les quatre index sont
-- recréés tels quels.
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
	CONSTRAINT "notifications_kind_check" CHECK("__new_notifications"."kind" IN ('requested', 'approved', 'declined', 'available', 'failed', 'auto_approved', 'requested_on_behalf', 'issue_created', 'issue_commented', 'issue_resolved', 'issue_reopened'))
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "user_id", "kind", "request_id", "issue_id", "detail", "created_at", "read_at") SELECT "id", "user_id", "kind", "request_id", "issue_id", "detail", "created_at", "read_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notifications_user_id_created_at_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`user_id`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX `notifications_request_id_idx` ON `notifications` (`request_id`) WHERE "notifications"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notifications_issue_id_idx` ON `notifications` (`issue_id`) WHERE "notifications"."issue_id" IS NOT NULL;
