CREATE TABLE IF NOT EXISTS `maintenance_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`request_digest` text NOT NULL,
	`site_id` text NOT NULL,
	`environment` text NOT NULL,
	`requested_by` text NOT NULL,
	`reason_code` text NOT NULL,
	`requested_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`credential_id` text NOT NULL,
	`status` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `maintenance_requests_scope_time_idx` ON `maintenance_requests` (`site_id`,`environment`,`requested_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `maintenance_request_freezes` (
	`request_id` text PRIMARY KEY NOT NULL,
	`freeze_id` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`request_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`freeze_id`) REFERENCES `freezes`(`freeze_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `maintenance_request_freezes_freeze_id_unique` ON `maintenance_request_freezes` (`freeze_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `maintenance_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`response_json` text NOT NULL,
	`response_digest` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`request_id`) ON UPDATE restrict ON DELETE restrict
);
