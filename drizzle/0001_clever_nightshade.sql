CREATE TABLE `transaction_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`actor_id` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `ledger_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP INDEX `ledger_payment_reference_unique`;--> statement-breakpoint
ALTER TABLE `ledger_transactions` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `ledger_transactions` ADD `void_reason` text;--> statement-breakpoint
ALTER TABLE `ledger_transactions` ADD `last_change_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_payment_reference_unique` ON `ledger_transactions` (`reference_key`) WHERE "ledger_transactions"."voided_at" is null;