CREATE TABLE "participant_approval_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "checkout_session_id" uuid NOT NULL REFERENCES "checkout_sessions"("id") ON DELETE restrict,
  "member_id" uuid NOT NULL REFERENCES "group_members"("id") ON DELETE restrict,
  "token_hash" varchar(64) NOT NULL,
  "purpose" varchar(16) NOT NULL,
  "allocation_version" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "participant_approval_tokens_hash_unique" ON "participant_approval_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "participant_approval_tokens_session_member_index" ON "participant_approval_tokens" USING btree ("checkout_session_id", "member_id");
