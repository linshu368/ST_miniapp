# 验证记录（2026-11-24，本地）

- 迁移：本地 PG17 一次性容器。旧函数由迁移文件反推并校验 md5 = 生产实测 `160f07aba2b38e80ba8fa85032f3dd5e`；迁移、重跑成功；断言全部通过（越权删除 P0404、重复删除幂等、删后不可发现、grant 玩家与作者仍可用、外人不可用、卡内容/published_revision/上架行不动、删后 save/publish/visibility/create 均 P0404、草稿可删、未知动作 22023、ACL 只 service_role）。函数被改过的库：迁移拒绝执行，deleted_at 列也没留下（事务回滚）。脚本在会话 scratchpad，未入库。
- 后端：`vitest run src/routes/creator-characters.test.ts` 37/37（新增删除成功、404、非法 id 三例）。
- 前端：`vitest run src/components/creation src/lib/api/creator-characters.test.ts` 16/16；eslint 仅既有 `<img>` 警告。
- shared：381/381。
- UI：`pnpm test:ui --grep "删后读写均为 404"` android + narrow 通过；截图确认⋯位置与确认框。
- 契约：`pnpm lint:db-contract` 新迁移无警告；复杂度预算通过，`CreatedCharacters` 276→210 行、`creatorCharacterRoutes` 降到预算内，基线只收紧这两项。
- 已知：同流程既有用例「载入最新版本前保留修改备份」在 dev 上因状态栏必填而失败（fillCharacter 未填状态栏），与本任务无关，未修改。
- 待做：TEST 迁移与真实回放、生产迁移、发布与线上核对。

## 第二轮（管理面板）

- 前端 vitest 16/16；frontend/ui-tests typecheck、eslint（仅既有 `<img>` 警告）、复杂度预算通过，`CreatedCharacters` 基线 210→167。
- `pnpm test:ui --grep "⋯管理"` android + narrow 4/4：私密卡 ⋯ → 公开 → 确认 → 已公开；⋯ → 删除角色 → 确认 → 列表空、删后 404；草稿卡 ⋯ 只有删除、取消可关。
- 全量 `@creator`：其余失败都停在编辑器保存/发布步骤（状态栏必填导致的必填数、保存后不跳转等）或 onboarding 缺 fixture，均在本改动之前，dev 上同样存在。
