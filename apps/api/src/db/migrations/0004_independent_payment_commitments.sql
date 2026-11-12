CREATE TYPE "public"."payment_commitment_status" AS ENUM('ready_to_pay', 'order_created', 'approved', 'capturing', 'paid_verified', 'failed', 'cancelled', 'refund_pending', 'refunded', 'superseded');--> statement-breakpoint
ALTER TYPE "public"."participant_funding_status" ADD VALUE IF NOT EXISTS 'refunded';--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "payment_mode" varchar(40) DEFAULT 'single_payer' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "booking_status" varchar(40) DEFAULT 'pending_allocation' NOT NULL;--> statement-breakpoint
CREATE TABLE "payment_commitments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "checkout_session_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "provider" varchar(32) DEFAULT 'paypal' NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "amount_cents" bigint NOT NULL,
  "captured_cents" bigint,
  "currency" varchar(3) NOT NULL,
  "status" "payment_commitment_status" DEFAULT 'ready_to_pay' NOT NULL,
  "expected_payer_email" varchar(320),
  "payer_email" varchar(320),
  "provider_order_id" varchar(128),
  "provider_capture_id" varchar(128),
  "approval_url" varchar(2048),
  "create_request_id" varchar(255),
  "capture_request_id" varchar(255),
  "failure_code" varchar(120),
  "failure_message" varchar(500),
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "payment_commitment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "commitment_id" uuid NOT NULL,
  "event_type" varchar(80) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_member_id_group_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."group_members"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "payment_commitment_events" ADD CONSTRAINT "payment_commitment_events_commitment_id_payment_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."payment_commitments"("id") ON DELETE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commitments_session_member_revision_unique" ON "payment_commitments" USING btree ("checkout_session_id", "member_id", "revision");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commitments_provider_order_unique" ON "payment_commitments" USING btree ("provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commitments_provider_capture_unique" ON "payment_commitments" USING btree ("provider_capture_id");--> statement-breakpoint
CREATE INDEX "payment_commitments_session_status_index" ON "payment_commitments" USING btree ("checkout_session_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commitment_events_idempotency_unique" ON "payment_commitment_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_commitment_events_commitment_index" ON "payment_commitment_events" USING btree ("commitment_id");
