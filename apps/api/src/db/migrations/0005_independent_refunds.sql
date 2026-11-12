ALTER TABLE "payment_commitments" ADD COLUMN "provider_refund_id" varchar(128);--> statement-breakpoint
ALTER TABLE "payment_commitments" ADD COLUMN "refund_request_id" varchar(255);--> statement-breakpoint
ALTER TABLE "payment_commitments" ADD COLUMN "refunded_cents" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commitments_provider_refund_unique" ON "payment_commitments" USING btree ("provider_refund_id");
