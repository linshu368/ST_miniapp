# 实施计划

> 未获用户对最终规划摘要的明确批准前，不得 `task.py start` / 写产品代码。

## 顺序

1. **Migration**：插入 `image_plaza_tags_feature_enabled=true`；扩展 Admin validate/publish allowlist（boolean，同 `image_plaza_enabled`）。
2. **shared**：`ImagePlazaSnapshotSchema` 增加可选 `prompt_zh`；更新契约测试。
3. **backend config/routes**：读开关；feed/bootstrap 过滤业务 tags；share 跳过自动打标。
4. **backend repository**：`listWorks` 搜索 `prompt_zh` OR `prompt`。
5. **frontend**：详情 `prompt_zh ?? prompt`；标签行在无业务 tags 时隐藏或仅「全部」（跟 API）。
6. **admin**：注册 key 元数据/schema（boolean 编辑）。
7. **脚本**：`translate-image-plaza-seed-prompts.ts` + package.json script；translate helper（Venice chat）。
8. **验证**：typecheck；相关单测；test 环境 dry-run → 小批 apply → 搜索/详情/同款人工。

## 风险文件

- `packages/backend/src/routes/image-plaza.ts`（share 打标分支）
- `packages/backend/src/features/image-plaza/repository.ts`（搜索）
- `packages/shared/src/api/image-plaza.ts`（snapshot）
- `packages/frontend/.../work/[workId]/page.tsx`
- 新 migration / Admin configSchemas

## 回滚点

- 关 `image_plaza_tags_feature_enabled`。
- 回退搜索改动后仅匹配 `prompt`。
- 译文字段可保留不删。

## 验证命令（实施时）

```bash
pnpm --filter @miniapp/shared test -- image-plaza
pnpm --filter @miniapp/backend exec vitest run src/features/image-plaza src/routes/image-plaza
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/frontend typecheck
# 脚本 dry-run（实施后）
pnpm --filter @miniapp/backend image-plaza:translate-seed-prompts -- --target test
```

## 实施后状态（2026-10-14）

- [x] 代码与 migration 文件已写入
- [x] `pnpm --filter @miniapp/shared test -- image-plaza-contracts` 通过
- [x] backend `config` / `routes/image-plaza` / `tagging` 共 21 tests 通过；`backend typecheck` 通过
- [ ] test 库手工执行 `20261014_image_plaza_tags_feature_and_prompt_zh.sql`
- [ ] test 库运行翻译脚本（先 dry-run 再小批 `--apply --target test --limit N`）
- [ ] 人工：开关关/开、详情中文、同款英文、中文搜索
