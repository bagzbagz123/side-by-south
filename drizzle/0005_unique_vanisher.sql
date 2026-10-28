CREATE TABLE `square_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`body_hash` text NOT NULL,
	`event_type` text NOT NULL,
	`data_id` text NOT NULL,
	`event_created_at` text NOT NULL,
	`received_at` text NOT NULL,
	`last_attempt_at` text NOT NULL,
	`processed_at` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`code` text DEFAULT 'processing' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
