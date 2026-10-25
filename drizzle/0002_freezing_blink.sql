CREATE TABLE `inquiry_alerts` (
	`inquiry_id` text PRIMARY KEY NOT NULL,
	`queued_at` text NOT NULL,
	`claim_id` text,
	`claim_expires_at` text,
	`reported_at` text,
	FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tracking_cloud_state` (
	`key` text PRIMARY KEY NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_status` text DEFAULT 'ready' NOT NULL,
	`last_result_code` text,
	`last_imported_days` integer DEFAULT 0 NOT NULL,
	`connection_status` text DEFAULT 'not_verified' NOT NULL,
	`connection_verified_at` text,
	`connection_result_code` text,
	`updated_at` text NOT NULL
);
