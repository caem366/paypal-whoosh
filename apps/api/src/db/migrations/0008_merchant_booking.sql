ALTER TABLE "checkout_sessions" ADD COLUMN "merchant_id" varchar(80);--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "merchant_order_id" varchar(128);--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "expected_payee_merchant_id" varchar(128);--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_merchant_order_unique" ON "checkout_sessions" ("merchant_id", "merchant_order_id");--> statement-breakpoint
ALTER TABLE "payment_commitments" ADD COLUMN "provider_custom_id" varchar(127);--> statement-breakpoint
ALTER TABLE "payment_commitments" ADD COLUMN "provider_invoice_id" varchar(255);--> statement-breakpoint
ALTER TABLE "payment_commitments" ADD COLUMN "provider_payee_merchant_id" varchar(128);--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commitments_provider_invoice_unique" ON "payment_commitments" ("provider_invoice_id");--> statement-breakpoint
CREATE TABLE "northline_bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "checkout_session_id" uuid NOT NULL REFERENCES "checkout_sessions"("id") ON DELETE restrict,
  "merchant_order_id" varchar(128) NOT NULL,
  "total_cents" bigint NOT NULL,
  "currency" varchar(3) NOT NULL,
  "expected_payee_merchant_id" varchar(128),
  "status" varchar(32) DEFAULT 'pending' NOT NULL,
  "failure_reason" varchar(200),
  "expires_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "northline_bookings_session_unique" ON "northline_bookings" ("checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "northline_bookings_order_unique" ON "northline_bookings" ("merchant_order_id");--> statement-breakpoint
CREATE TABLE "northline_booking_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "booking_id" uuid NOT NULL REFERENCES "northline_bookings"("id") ON DELETE restrict,
  "event_type" varchar(80) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "northline_booking_events_key_unique" ON "northline_booking_events" ("idempotency_key");--> statement-breakpoint
CREATE TABLE "funding_ready_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "checkout_session_id" uuid NOT NULL REFERENCES "checkout_sessions"("id") ON DELETE restrict,
  "status" varchar(24) DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX "funding_ready_notifications_session_unique" ON "funding_ready_notifications" ("checkout_session_id");--> statement-breakpoint
