CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"subject_key" varchar(100),
	"predicate_key" varchar(100),
	"object_value" text,
	"polarity" varchar(10),
	"importance_score" real DEFAULT 0.5 NOT NULL,
	"confidence_score" real DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"superseded_by" uuid,
	"source_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_memories_type" CHECK ("memories"."type" IN ('fact', 'preference', 'event', 'goal', 'relationship', 'state')),
	CONSTRAINT "chk_memories_status" CHECK ("memories"."status" IN ('active', 'conflict', 'superseded', 'archived', 'deleted')),
	CONSTRAINT "chk_memories_polarity" CHECK ("memories"."polarity" IS NULL OR "memories"."polarity" IN ('affirm', 'deny')),
	CONSTRAINT "chk_memories_importance" CHECK ("memories"."importance_score" BETWEEN 0 AND 1),
	CONSTRAINT "chk_memories_confidence" CHECK ("memories"."confidence_score" BETWEEN 0 AND 1),
	CONSTRAINT "chk_memories_valid_range" CHECK ("memories"."valid_until" IS NULL OR "memories"."valid_from" IS NULL OR "memories"."valid_until" >= "memories"."valid_from"),
	CONSTRAINT "chk_memories_superseded" CHECK ("memories"."status" <> 'superseded' OR "memories"."superseded_by" IS NOT NULL),
	CONSTRAINT "chk_memories_deleted" CHECK ("memories"."status" <> 'deleted' OR "memories"."deleted_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"model" varchar(100) NOT NULL,
	"dim" integer NOT NULL,
	"embedded_text" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"status" varchar(20) DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_embeddings_status" CHECK ("memory_embeddings"."status" IN ('ready', 'stale', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"message_id" uuid,
	"event_id" uuid,
	"goal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_sources_type" CHECK ("memory_sources"."source_type" IN ('conversation', 'manual', 'system', 'goal_projection', 'event_derived')),
	CONSTRAINT "chk_sources_has_origin" CHECK ("memory_sources"."message_id" IS NOT NULL OR "memory_sources"."event_id" IS NOT NULL OR "memory_sources"."goal_id" IS NOT NULL OR "memory_sources"."source_type" IN ('manual','system'))
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memories_current_slot" ON "memories" USING btree ("user_id","subject_key","predicate_key") WHERE "memories"."status" = 'active' AND "memories"."deleted_at" IS NULL AND "memories"."valid_until" IS NULL AND "memories"."superseded_by" IS NULL AND "memories"."predicate_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_memories_user_status_type" ON "memories" USING btree ("user_id","status","type");--> statement-breakpoint
CREATE INDEX "idx_memories_user_updated" ON "memories" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_memories_slot" ON "memories" USING btree ("user_id","subject_key","predicate_key");--> statement-breakpoint
CREATE INDEX "idx_memories_type_time" ON "memories" USING btree ("user_id","type","valid_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_memories_content_trgm" ON "memories" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_embeddings_memory_model" ON "memory_embeddings" USING btree ("memory_id","model");--> statement-breakpoint
CREATE INDEX "idx_embeddings_status" ON "memory_embeddings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_sources_memory_message" ON "memory_sources" USING btree ("memory_id","message_id") WHERE "memory_sources"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_memory_sources_message" ON "memory_sources" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_memory_sources_memory" ON "memory_sources" USING btree ("memory_id");