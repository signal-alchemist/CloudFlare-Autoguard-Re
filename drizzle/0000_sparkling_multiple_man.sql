CREATE TABLE IF NOT EXISTS `audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`decision` text NOT NULL,
	`policy_version` text NOT NULL,
	`correlation_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_target_time_idx` ON `audit_events` (`target_type`,`target_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `observations` (
	`observation_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`site_id` text NOT NULL,
	`environment` text NOT NULL,
	`component` text NOT NULL,
	`check_id` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text NOT NULL,
	`observed_at` text NOT NULL,
	`valid_until` text NOT NULL,
	`source` text NOT NULL,
	`scope` text NOT NULL,
	`evidence_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `observations_idempotency_key_unique` ON `observations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `observations_scope_time_idx` ON `observations` (`site_id`,`environment`,`component`,`observed_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `replay_claims` (
	`replay_key` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `signal_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`observation_id` text NOT NULL,
	`first_received_at` text NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `observations`(`observation_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `signal_receipts_idempotency_key_unique` ON `signal_receipts` (`idempotency_key`);
