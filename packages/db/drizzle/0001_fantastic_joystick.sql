DROP INDEX `user_emails_email_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_emails_email_unique` ON `user_emails` (lower("email")) WHERE "user_emails"."verified_at" is not null;