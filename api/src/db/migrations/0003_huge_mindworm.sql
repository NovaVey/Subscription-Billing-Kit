ALTER TABLE "invoices" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "invoices_created_at_idx" ON "invoices" USING btree ("created_at");