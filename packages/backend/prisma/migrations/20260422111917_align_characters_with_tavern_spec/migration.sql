/*
  Warnings:

  - You are about to drop the column `author_name` on the `characters` table. All the data in the column will be lost.
  - You are about to drop the column `greeting` on the `characters` table. All the data in the column will be lost.
  - You are about to drop the column `personality_tags` on the `characters` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "characters" DROP COLUMN "author_name",
DROP COLUMN "greeting",
DROP COLUMN "personality_tags",
ADD COLUMN     "alternate_greetings" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "character_book" JSONB,
ADD COLUMN     "character_version" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "creator" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "extensions" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "first_mes" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "mes_example" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "personality" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "post_history_instructions" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "scenario" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "spec" TEXT NOT NULL DEFAULT 'chara_card_v2',
ADD COLUMN     "spec_version" TEXT NOT NULL DEFAULT '2.0',
ADD COLUMN     "system_prompt" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "tags" JSONB NOT NULL DEFAULT '[]',
ALTER COLUMN "description" SET DEFAULT '';
