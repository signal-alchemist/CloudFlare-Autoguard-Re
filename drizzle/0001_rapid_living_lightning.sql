CREATE TABLE IF NOT EXISTS `incident_timeline` (
	`event_id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`event_type` text NOT NULL,
	`observation_id` text,
	`from_state` text,
	`to_state` text,
	`correlation_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`idempotency_key` text NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`incident_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `incident_timeline_idempotency_unique` ON `incident_timeline` (`incident_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incident_timeline_incident_time_idx` ON `incident_timeline` (`incident_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `incidents` (
	`incident_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`site_id` text NOT NULL,
	`environment` text NOT NULL,
	`component` text NOT NULL,
	`reason_code` text NOT NULL,
	`scope` text NOT NULL,
	`severity` text NOT NULL,
	`state` text NOT NULL,
	`opened_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `incidents_fingerprint_unique` ON `incidents` (`fingerprint`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incidents_scope_state_idx` ON `incidents` (`site_id`,`environment`,`state`);
