CREATE TABLE `admin_approval_events` (
	`id` text PRIMARY KEY NOT NULL,
	`sub` text NOT NULL,
	`event` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_approval_events_sub_idx` ON `admin_approval_events` (`sub`,`created_at`);--> statement-breakpoint
CREATE TABLE `admin_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`sub` text NOT NULL,
	`is_super_approver` integer DEFAULT false NOT NULL,
	`approved_by_sub` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_approvals_sub_unique` ON `admin_approvals` (`sub`);