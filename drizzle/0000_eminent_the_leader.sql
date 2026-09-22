CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Shanghai' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200),
	"summary" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_conversations_status" CHECK ("conversations"."status" IN ('active', 'archived', 'deleted')),
	CONSTRAINT "chk_conversations_deleted" CHECK ("conversations"."status" <> 'deleted' OR "conversations"."deleted_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"sequence" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_messages_role" CHECK ("messages"."role" IN ('user', 'assistant', 'system', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"start_sequence" bigint NOT NULL,
	"end_sequence" bigint NOT NULL,
	"extractor_version" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"memories_created" integer DEFAULT 0 NOT NULL,
	"memories_updated" integer DEFAULT 0 NOT NULL,
	"memories_superseded" integer DEFAULT 0 NOT NULL,
	"conflicts_found" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "chk_extraction_status" CHECK ("extraction_runs"."status" IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "chk_extraction_range" CHECK ("extraction_runs"."end_sequence" >= "extraction_runs"."start_sequence")
);
--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"sequence_from" bigint NOT NULL,
	"sequence_to" bigint NOT NULL,
	"summarizer_version" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_summaries_range" CHECK ("conversation_summaries"."sequence_to" >= "conversation_summaries"."sequence_from"),
	CONSTRAINT "chk_summaries_status" CHECK ("conversation_summaries"."status" IN ('active', 'stale'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversations_user_updated" ON "conversations" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_conversations_user_status" ON "conversations" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_conversation_sequence" ON "messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_messages_sequence" ON "messages" USING btree ("conversation_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_messages_created_at" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_extraction_idempotency" ON "extraction_runs" USING btree ("conversation_id","start_sequence","extractor_version");--> statement-breakpoint
CREATE INDEX "idx_extraction_conversation" ON "extraction_runs" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_extraction_pending" ON "extraction_runs" USING btree ("status") WHERE "extraction_runs"."status" IN ('pending','running','failed');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_summaries_range" ON "conversation_summaries" USING btree ("conversation_id","sequence_from","sequence_to");