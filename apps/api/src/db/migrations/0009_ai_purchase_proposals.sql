CREATE TABLE "ai_purchase_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE restrict,
  "request" varchar(4000) NOT NULL,
  "model" varchar(120) NOT NULL,
  "interpretation" jsonb NOT NULL,
  "checkout_session_id" uuid REFERENCES "checkout_sessions"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_purchase_proposals_checkout_unique" ON "ai_purchase_proposals" ("checkout_session_id");--> statement-breakpoint
