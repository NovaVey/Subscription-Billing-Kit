ALTER TABLE "invoices" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
CREATE INDEX "invoices_stripe_subscription_id_idx" ON "invoices" USING btree ("stripe_subscription_id");