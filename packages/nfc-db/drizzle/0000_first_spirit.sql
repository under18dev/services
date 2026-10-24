CREATE TABLE `nfc_card_events` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`event` text NOT NULL,
	`actor_user_id` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nfc_card_events_card_idx` ON `nfc_card_events` (`card_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `nfc_card_events_actor_idx` ON `nfc_card_events` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `nfc_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`target_url` text,
	`status` text DEFAULT 'issued' NOT NULL,
	`claim_code_hash` text,
	`claim_code_issued_at` integer,
	`claimed_at` integer,
	`transfer_count` integer DEFAULT 0 NOT NULL,
	`disabled_at` integer,
	`disabled_reason` text,
	`batch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nfc_cards_owner_idx` ON `nfc_cards` (`owner_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `nfc_cards_batch_idx` ON `nfc_cards` (`batch`);