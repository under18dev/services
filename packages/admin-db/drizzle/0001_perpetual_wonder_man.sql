ALTER TABLE `admin_approval_events` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `admin_approvals` ADD `permissions` text DEFAULT '0' NOT NULL;