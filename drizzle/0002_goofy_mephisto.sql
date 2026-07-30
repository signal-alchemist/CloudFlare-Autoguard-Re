CREATE TABLE IF NOT EXISTS `notification_deliveries` (
	`delivery_key` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`payload_digest` text NOT NULL,
	`provider_code` text NOT NULL,
	`delivered_at` text NOT NULL,
	`correlation_id` text NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`incident_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notification_deliveries_incident_time_idx` ON `notification_deliveries` (`incident_id`,`delivered_at`);
