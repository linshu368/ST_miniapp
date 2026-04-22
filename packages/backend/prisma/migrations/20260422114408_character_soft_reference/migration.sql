-- DropForeignKey
ALTER TABLE "app_sessions" DROP CONSTRAINT "app_sessions_character_id_fkey";

-- AlterTable
ALTER TABLE "app_sessions" ALTER COLUMN "character_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
