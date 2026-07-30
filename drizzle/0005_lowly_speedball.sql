CREATE TABLE IF NOT EXISTS `deployment_runtime_identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`site_id` text NOT NULL,
	`environment` text NOT NULL,
	`commit_sha` text NOT NULL,
	`worker_version_id` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`source_observation_id` text NOT NULL,
	`policy_version` text NOT NULL,
	`observed_at` text NOT NULL,
	`valid_until` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_observation_id`) REFERENCES `observations`(`observation_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `deployment_runtime_identity_scope_time_unique` ON `deployment_runtime_identities` (`site_id`,`environment`,`observed_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deployment_runtime_identity_scope_latest_idx` ON `deployment_runtime_identities` (`site_id`,`environment`,`observed_at`,`identity_id`);
