CREATE INDEX "attachments_state_updated_idx" ON "attachments" USING btree ("lifecycle_state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_messages_attachment_image_id" ON "messages" USING btree (("content" ->> 'imageId'));--> statement-breakpoint
CREATE INDEX "idx_messages_content_attachments" ON "messages" USING gin ((("content" -> 'attachments')) jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_metadata_attachments" ON "messages" USING gin ((("metadata" -> 'attachments')) jsonb_path_ops);