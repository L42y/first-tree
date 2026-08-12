CREATE TABLE "im_bot_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"app_id" text,
	"bot_open_id" text,
	"tenant_key" text,
	"app_secret_cipher" text,
	"registration_state_cipher" text,
	"registration_expires_at" timestamp with time zone,
	"granted_scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"connection_status" text DEFAULT 'disconnected' NOT NULL,
	"connection_owner_instance_id" text,
	"connection_lease_expires_at" timestamp with time zone,
	"connection_epoch" integer DEFAULT 0 NOT NULL,
	"last_connected_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_im_bot_bindings_status" CHECK ("im_bot_bindings"."status" IN ('provisioning', 'active', 'error', 'revoked')),
	CONSTRAINT "chk_im_bot_bindings_connection_status" CHECK ("im_bot_bindings"."connection_status" IN ('disconnected', 'connecting', 'connected', 'error')),
	CONSTRAINT "chk_im_bot_bindings_connection_epoch" CHECK ("im_bot_bindings"."connection_epoch" >= 0),
	CONSTRAINT "chk_im_bot_bindings_active" CHECK ("im_bot_bindings"."status" <> 'active' OR ("im_bot_bindings"."app_id" IS NOT NULL AND "im_bot_bindings"."bot_open_id" IS NOT NULL AND "im_bot_bindings"."app_secret_cipher" IS NOT NULL AND "im_bot_bindings"."registration_state_cipher" IS NULL)),
	CONSTRAINT "chk_im_bot_bindings_revoked" CHECK ("im_bot_bindings"."status" <> 'revoked' OR ("im_bot_bindings"."app_secret_cipher" IS NULL AND "im_bot_bindings"."registration_state_cipher" IS NULL AND "im_bot_bindings"."connection_owner_instance_id" IS NULL AND "im_bot_bindings"."connection_lease_expires_at" IS NULL AND "im_bot_bindings"."connection_status" = 'disconnected' AND "im_bot_bindings"."revoked_at" IS NOT NULL)),
	CONSTRAINT "chk_im_bot_bindings_lease_owner" CHECK (("im_bot_bindings"."connection_owner_instance_id" IS NULL AND "im_bot_bindings"."connection_lease_expires_at" IS NULL) OR ("im_bot_bindings"."connection_owner_instance_id" IS NOT NULL AND "im_bot_bindings"."connection_lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "im_chat_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_binding_id" text NOT NULL,
	"feishu_chat_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"feishu_chat_type" text NOT NULL,
	"title_snapshot" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_im_chat_bindings_chat_type" CHECK ("im_chat_bindings"."feishu_chat_type" IN ('p2p', 'group')),
	CONSTRAINT "chk_im_chat_bindings_status" CHECK ("im_chat_bindings"."status" IN ('active', 'detached'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_kind" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_provider" text;--> statement-breakpoint
ALTER TABLE "im_bot_bindings" ADD CONSTRAINT "im_bot_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_bot_bindings" ADD CONSTRAINT "im_bot_bindings_agent_id_agents_uuid_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("uuid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_chat_bindings" ADD CONSTRAINT "im_chat_bindings_bot_binding_id_im_bot_bindings_id_fk" FOREIGN KEY ("bot_binding_id") REFERENCES "public"."im_bot_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_chat_bindings" ADD CONSTRAINT "im_chat_bindings_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_im_bot_bindings_current_agent" ON "im_bot_bindings" USING btree ("agent_id") WHERE "im_bot_bindings"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_im_bot_bindings_current_app" ON "im_bot_bindings" USING btree ("app_id") WHERE "im_bot_bindings"."status" <> 'revoked' AND "im_bot_bindings"."app_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_im_bot_bindings_org_status" ON "im_bot_bindings" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_im_bot_bindings_connection_claim" ON "im_bot_bindings" USING btree ("connection_lease_expires_at") WHERE "im_bot_bindings"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_im_chat_bindings_bot_chat" ON "im_chat_bindings" USING btree ("bot_binding_id","feishu_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_im_chat_bindings_chat" ON "im_chat_bindings" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_feishu_inbound_message" ON "messages" USING btree ("chat_id",("metadata" -> 'feishu' -> 'reference' ->> 'messageId')) WHERE "messages"."sender_kind" = 'integration' AND "messages"."sender_provider" = 'feishu' AND "messages"."metadata" -> 'feishu' ->> 'direction' = 'inbound';--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "chk_messages_sender_identity" CHECK (("messages"."sender_kind" = 'member' AND "messages"."sender_provider" IS NULL) OR ("messages"."sender_kind" = 'integration' AND "messages"."sender_provider" = 'feishu' AND "messages"."sender_id" = 'integration:feishu'));