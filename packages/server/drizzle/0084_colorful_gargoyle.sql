DROP INDEX "idx_inbox_chat_silent";--> statement-breakpoint
CREATE INDEX "idx_inbox_chat_silent" ON "inbox_entries" USING btree ("inbox_id","chat_id","notify","status","id");