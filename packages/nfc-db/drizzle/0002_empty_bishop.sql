CREATE TABLE `nfc_card_taps` (
	`card_id` text NOT NULL,
	`date` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`card_id`, `date`)
);
