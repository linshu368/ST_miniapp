/**
 * dev 后端常驻 seed character UUID。
 *
 * 本地、测试和文档中可引用这些常量，避免手写 seed 角色 UUID。
 *
 * 维护约定（见根 CLAUDE.md「数据契约纪律」第 6 条）：
 * - 这些 UUID 由 packages/backend/prisma/seed.ts 的幂等 upsert 保证在 dev 后端永远存在
 * - 不得删除或修改已存在的 UUID 值
 * - 新增时：Dev 在 seed.ts 加 upsert → 在此文件加常量
 *
 * 名字用 camelCase 英文键，避免角色中文名变动影响 key。注释里备注 dev 后端当前对应的角色名便于查阅。
 */
export const DEV_SEED_CHARACTERS = {
  heavyTaste: '1551063f-1e68-4717-84a5-272222039f82', // dev 后端当前角色名："重口味小说"
  longdou: '2a3de762-51ab-4882-b01f-7c26fe7a4a47', // dev 后端当前角色名："龙斗 住公寓隔壁的不良同班同学"
  familySim: '622fc352-ac90-4ca4-85b9-dbcb46ed7a27', // dev 后端当前角色名："华夏式家庭模拟器"
} as const;

export type DevSeedCharacterKey = keyof typeof DEV_SEED_CHARACTERS;
