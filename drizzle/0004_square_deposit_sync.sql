CREATE TABLE `square_connections` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`encrypted_tokens` text NOT NULL,
	`expires_at` text NOT NULL,
	`refreshed_at` text NOT NULL,
	`scopes_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `square_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE TABLE `square_quote_enrollments` (
	`inquiry_id` text PRIMARY KEY NOT NULL,
	`offer_key` text NOT NULL,
	`accepted_quote_reference` text NOT NULL,
	`digital_only` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `square_receipts` (
	`payment_id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`provider_updated_at` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`occurred_on` text NOT NULL,
	`offer_key` text,
	`reference` text,
	`status` text DEFAULT 'review' NOT NULL,
	`code` text NOT NULL,
	`inquiry_id` text,
	`ledger_transaction_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ledger_transaction_id`) REFERENCES `ledger_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `square_refunds` (
	`refund_id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`provider_updated_at` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`occurred_on` text NOT NULL,
	`status` text DEFAULT 'review' NOT NULL,
	`code` text NOT NULL,
	`ledger_transaction_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `square_receipts`(`payment_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ledger_transaction_id`) REFERENCES `ledger_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `square_sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`watermark` text,
	`scan_begin` text,
	`scan_upper` text,
	`scan_phase` text,
	`cursor` text,
	`page_ids_json` text,
	`page_next_cursor` text,
	`page_offset` integer DEFAULT 0 NOT NULL,
	`scan_pages` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_status` text DEFAULT 'not_connected' NOT NULL,
	`last_code` text,
	`coverage_gap` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
