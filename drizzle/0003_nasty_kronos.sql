CREATE TABLE IF NOT EXISTS `post_deploy_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`response_json` text NOT NULL,
	`response_digest` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `post_deploy_requests`(`request_id`) ON UPDATE restrict ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `post_deploy_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`request_digest` text NOT NULL,
	`site_id` text NOT NULL,
	`environment` text NOT NULL,
	`commit_sha` text NOT NULL,
	`worker_version_id` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`requested_at` integer NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `post_deploy_requests_digest_unique` ON `post_deploy_requests` (`request_digest`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `post_deploy_requests_scope_time_idx` ON `post_deploy_requests` (`site_id`,`environment`,`requested_at`);
