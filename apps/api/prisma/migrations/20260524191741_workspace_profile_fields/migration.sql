-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "card_visibility" JSONB,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "industry" TEXT,
ADD COLUMN     "website" TEXT;
