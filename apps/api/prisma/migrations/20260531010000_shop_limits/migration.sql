-- Phase 7 (limits/time/FOMO): a crowdfunding campaign can have a deadline — past it, an unfilled
-- campaign is auto-refunded by ShopCron. (Stock / availability window / FOMO discount reuse the
-- Listing fields added inert in Phase 2; this only adds the campaign deadline snapshot.)
ALTER TABLE "orders" ADD COLUMN "expires_at" TIMESTAMP(3);
