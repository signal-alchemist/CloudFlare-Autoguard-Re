CREATE TABLE IF NOT EXISTS `notification_outbox` (
	`outbox_id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`notification_kind` text NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_digest` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`enqueued_at` text,
	`last_error_code` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`incident_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`observation_id`) REFERENCES `observations`(`observation_id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "notification_outbox_kind_check" CHECK("notification_outbox"."notification_kind" IN ('incident_opened')),
	CONSTRAINT "notification_outbox_status_check" CHECK("notification_outbox"."status" IN ('pending', 'enqueued', 'blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `notification_outbox_incident_kind_unique` ON `notification_outbox` (`incident_id`,`notification_kind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notification_outbox_pending_scan_idx` ON `notification_outbox` (`status`,`created_at`,`outbox_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `observations_failure_repair_idx` ON `observations` (`site_id`,`environment`,`status`,`created_at`,`observation_id`);
