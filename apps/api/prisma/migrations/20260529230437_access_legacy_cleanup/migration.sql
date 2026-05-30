/*
  Warnings:

  - You are about to drop the `calendar_shares` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `showcase_shares` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "calendar_shares" DROP CONSTRAINT "calendar_shares_calendar_owner_id_fkey";

-- DropForeignKey
ALTER TABLE "calendar_shares" DROP CONSTRAINT "calendar_shares_shared_with_user_id_fkey";

-- DropForeignKey
ALTER TABLE "showcase_shares" DROP CONSTRAINT "showcase_shares_showcase_id_fkey";

-- DropTable
DROP TABLE "calendar_shares";

-- DropTable
DROP TABLE "showcase_shares";

-- Data cleanup: shop/showcase staff are now `manager` tuples in relation_tuples (access engine).
-- Drop the legacy UserRole rows for those contexts. The user_roles table stays (system/workspace/circle).
DELETE FROM "user_roles" WHERE "context" IN ('shop', 'showcase');
