# 执行计划

## 改动清单

1. `packages/shared/migrations/20261124_creator_character_delete.sql`：加 `deleted_at` 列；整体替换 `mutate_creator_character`（md5 前置校验）；文件头写回滚 SQL。
2. `docs/db/registry.yaml`：`app_core.character_creations` 的 note 补上 `deleted_at`。
3. `packages/shared/src/api/creator-characters.ts`：`DeleteCreatorCharacterData`。
4. `packages/backend/src/features/creator/repository.ts`：`list`/`get` 过滤；`remove()`。
5. `packages/backend/src/routes/creator-characters.ts`：`DELETE /api/creator/characters/:id`（保留 `@frontend-ready` 注释）。
6. `packages/backend/src/routes/creator-characters.test.ts`：补删除路由用例（成功、404、未登录）。现有测试文件，不新建文件。
7. `packages/shared/migrations/tests/creator_characters.sql`：补 SQL 断言（删除幂等、删后写入 404、公开不可发现、grant 玩家仍可用、作者列表过滤由后端负责不在 SQL 测）。属于迁移和权限变更，按风险评估需要锁定。
8. `packages/frontend/src/lib/api/creator-characters.ts`：`useDeleteCreatorCharacterMutation`。
9. `packages/frontend/src/components/creation/created-characters.tsx`：封面「⋯」+ 删除确认 Sheet。
10. 模块文档：`module-updates.json` → `module_knowledge.py apply`。

## 验证命令

```bash
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter @miniapp/backend test -- src/routes/creator-characters.test.ts
pnpm --filter @miniapp/frontend test -- src/components/creation
pnpm lint:complexity
pnpm lint:db-contract
bash scripts/test-creator-migration.sh   # 如存在；否则按 migrations/tests/README 跑 creator_characters.sql
pnpm --filter @miniapp/frontend build
```

## 失败路径与人工场景

- 删除别人的卡、不存在的 id → 404；未登录 → 401。
- 删除后：PATCH/publish/visibility/GET 详情 → 404；再次 DELETE → 200。
- 删除中断网：Sheet 显示错误，卡片仍在；重新点击成功（幂等）。
- 本地预览 `pnpm preview:ui`：在「我的创作」截图检查⋯的位置、对比度、与状态标签不重叠；Sheet 右滑关闭、返回键先关 Sheet。
- TEST 环境（Railway development，DEV_AUTH_BYPASS）真实回放：建卡 → 发布公开 → 另一用户收藏（无法用第二身份时只验作者侧）→ 删除 → 列表消失、大厅接口不返回、作者主页不返回；测完数据由删除本身清理。

## 发布

TEST 迁移 → 生产迁移（GitHub Actions `Database Migration`）→ 合并 dev → 按现有流程发 main。迁移必须先于后端。
