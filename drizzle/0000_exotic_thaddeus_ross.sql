CREATE TABLE `ad_spend` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`verified_at` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_spend_campaign_date_unique` ON `ad_spend` (`campaign_id`,`date`);--> statement-breakpoint
CREATE TABLE `inquiries` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`reference` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`name` text NOT NULL,
	`instagram` text NOT NULL,
	`event_date` text,
	`flexible_date` integer DEFAULT false NOT NULL,
	`event_location` text NOT NULL,
	`coverage` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`quoted_media_cents` integer,
	`booking_date` text,
	`completed_date` text,
	`source` text DEFAULT 'unknown' NOT NULL,
	`source_ad_id` text,
	`attribution_json` text DEFAULT '{}' NOT NULL,
	`planned_cost_cents` integer DEFAULT 5000 NOT NULL,
	`actual_costs_confirmed` integer DEFAULT false NOT NULL,
	`decoration_settled` integer DEFAULT false NOT NULL,
	`is_test` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inquiries_submission_unique` ON `inquiries` (`submission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inquiries_reference_unique` ON `inquiries` (`reference`);--> statement-breakpoint
CREATE TABLE `ledger_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`inquiry_id` text,
	`occurred_on` text NOT NULL,
	`type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`reference_note` text DEFAULT '' NOT NULL,
	`reference_key` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_payment_reference_unique` ON `ledger_transactions` (`reference_key`);--> statement-breakpoint
CREATE TABLE `tracker_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
