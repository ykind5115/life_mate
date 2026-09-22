CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"event_time" timestamp with time zone NOT NULL,
	"category" varchar(50),
	"importance_score" real DEFAULT 0.5 NOT NULL,
	"source_type" varchar(20) DEFAULT 'conversation' NOT NULL,
	"source_message_id" uuid,
	"timeline_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_events_source_type" CHECK ("events"."source_type" IN ('conversation', 'manual', 'system')),
	CONSTRAINT "chk_events_importance" CHECK ("events"."importance_score" BETWEEN 0 AND 1),
	CONSTRAINT "chk_events_category" CHECK ("events"."category" IS NULL OR "events"."category" IN ('work', 'study', 'project', 'life', 'health', 'other'))
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"priority" real DEFAULT 0.5 NOT NULL,
	"started_at" timestamp with time zone,
	"target_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_goals_status" CHECK ("goals"."status" IN ('active', 'paused', 'completed', 'cancelled', 'archived')),
	CONSTRAINT "chk_goals_priority" CHECK ("goals"."priority" BETWEEN 0 AND 1),
	CONSTRAINT "chk_goals_time_order" CHECK (("goals"."target_at" IS NULL OR "goals"."started_at" IS NULL OR "goals"."target_at" >= "goals"."started_at")
          AND ("goals"."completed_at" IS NULL OR "goals"."started_at" IS NULL OR "goals"."completed_at" >= "goals"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"relation_type" varchar(50),
	"description" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_relationships_status" CHECK ("relationships"."status" IN ('active', 'ended', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_user_time" ON "events" USING btree ("user_id","event_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_events_user_category" ON "events" USING btree ("user_id","category");--> statement-breakpoint
CREATE INDEX "idx_events_timeline" ON "events" USING btree ("user_id","event_time" DESC NULLS LAST) WHERE "events"."timeline_visible" = true AND "events"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_goals_user_status" ON "goals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_relationships_user_status" ON "relationships" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_relationships_user_name" ON "relationships" USING btree ("user_id","name") WHERE "relationships"."deleted_at" IS NULL;