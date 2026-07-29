ALTER TABLE "attachments" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "lifecycle_state" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "bundle_attachment_id" text;--> statement-breakpoint
CREATE INDEX "attachments_org_state_idx" ON "attachments" USING btree ("organization_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "idx_resources_bundle_attachment" ON "resources" USING btree ("bundle_attachment_id");