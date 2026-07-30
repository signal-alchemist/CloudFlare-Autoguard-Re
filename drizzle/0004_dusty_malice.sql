CREATE TABLE IF NOT EXISTS `component_verdicts` (
	`site_id` text NOT NULL,
	`environment` text NOT NULL,
	`component` text NOT NULL,
	`schema_version` integer NOT NULL,
	`policy_version` text NOT NULL,
	`state` text NOT NULL,
	`reason_codes_json` text NOT NULL,
	`observation_ids_json` text NOT NULL,
	`evaluated_at` text NOT NULL,
	`fresh_until` text,
	PRIMARY KEY(`site_id`, `environment`, `component`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `component_verdicts_scope_idx` ON `component_verdicts` (`site_id`,`environment`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `freezes` (
	`freeze_id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`environment` text NOT NULL,
	`reason_code` text NOT NULL,
	`correlation_id` text NOT NULL,
	`activated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`released_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `freezes_scope_active_idx` ON `freezes` (`site_id`,`environment`,`released_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `observations_verdict_lookup_idx` ON `observations` (`site_id`,`environment`,`component`,`check_id`,`source`,`observed_at`,`observation_id`);
