CREATE TABLE "agent_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payload" jsonb NOT NULL,
	"replacement_template_id" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_templates_status" CHECK ("agent_templates"."status" IN ('draft', 'active', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "template_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_resource_bindings" ADD COLUMN "origin_template_id" text;--> statement-breakpoint
ALTER TABLE "agent_resource_bindings" ADD COLUMN "origin_component_key" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "origin_template_id" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "origin_component_key" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "origin_content_digest" text;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_replacement_template_id_agent_templates_id_fk" FOREIGN KEY ("replacement_template_id") REFERENCES "public"."agent_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_templates_slug" ON "agent_templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_agent_templates_status" ON "agent_templates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agent_configs_template_ids" ON "agent_configs" USING gin ("template_ids");--> statement-breakpoint
CREATE INDEX "idx_agent_resource_bindings_template_origin" ON "agent_resource_bindings" USING btree ("agent_id","origin_template_id") WHERE "agent_resource_bindings"."origin_template_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_resources_template_origin_active" ON "resources" USING btree ("organization_id","origin_template_id","origin_component_key") WHERE "resources"."status" IN ('active', 'stale') AND "resources"."origin_template_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "ck_agent_configs_template_ids_cardinality" CHECK (cardinality("agent_configs"."template_ids") <= 3);--> statement-breakpoint
ALTER TABLE "agent_resource_bindings" ADD CONSTRAINT "ck_agent_resource_bindings_template_origin_consistency" CHECK (("agent_resource_bindings"."origin_template_id" IS NULL AND "agent_resource_bindings"."origin_component_key" IS NULL) OR ("agent_resource_bindings"."origin_template_id" IS NOT NULL AND "agent_resource_bindings"."origin_component_key" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "ck_resources_template_origin_consistency" CHECK (("resources"."origin_template_id" IS NULL AND "resources"."origin_component_key" IS NULL AND "resources"."origin_content_digest" IS NULL) OR ("resources"."origin_template_id" IS NOT NULL AND "resources"."origin_component_key" IS NOT NULL AND "resources"."origin_content_digest" IS NOT NULL));