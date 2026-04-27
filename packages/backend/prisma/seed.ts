/**
 * dev 后端种子数据 —— 保护前端 mock 依赖的 character UUID 永远存在。
 *
 * 维护约定见根 CLAUDE.md「数据契约纪律」第 6 条 / packages/backend/CLAUDE.md Dev 提交前清单第 3 条：
 * - 本文件的 upsert 列表必须与 packages/shared/src/dev-fixtures.ts 的 DEV_SEED_CHARACTERS 常量一致
 * - 不得删除或修改已存在的 UUID
 * - dev 部署时（Railway deploy hook 或手动 `pnpm tsx prisma/seed.ts`）跑一次
 *
 * 当前状态：最小骨架 —— 只保证 UUID + name 存在，使 `prisma.character.findUnique` 不会 404。
 * TODO (Dev)：如果想让 dev 后端清库重建后前端 UI 展示也有合理内容，补齐 description /
 *             first_mes / personality_tags / avatar_url / creator_notes 等字段。
 *             可以从当前 dev 后端 curl 这三个 character 的完整数据粘贴进来。
 */

import { PrismaClient } from '@prisma/client';
import { DEV_SEED_CHARACTERS } from '@miniapp/shared';

const prisma = new PrismaClient();

interface SeedCharacter {
  id: string;
  name: string;
  // TODO (Dev): 补齐需要保护的其他字段
}

const SEED_CHARACTERS: SeedCharacter[] = [
  { id: DEV_SEED_CHARACTERS.heavyTaste, name: '重口味小说' },
  { id: DEV_SEED_CHARACTERS.longdou, name: '龙斗 住公寓隔壁的不良同班同学' },
  { id: DEV_SEED_CHARACTERS.familySim, name: '华夏式家庭模拟器：人间烟火与风月秘事' },
];

async function main() {
  for (const c of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { id: c.id },
      update: {}, // 幂等：已存在不覆盖现有字段，保留 dev 环境已有内容
      create: {
        id: c.id,
        name: c.name,
        // 其他字段走 schema.prisma 的 default("")
      },
    });
  }
  console.log(`Seeded ${SEED_CHARACTERS.length} protected characters.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
