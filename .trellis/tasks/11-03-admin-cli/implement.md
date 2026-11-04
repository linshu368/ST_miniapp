# 执行计划：运营平台 CLI 与侧边栏整理

## 阶段 1：抽出 `@miniapp/admin-client`（Admin 行为不变）

1. 新建 `packages/admin-client`（`type: module`，`main: src/index.ts`，依赖 `@miniapp/shared`、`@supabase/supabase-js`、`zod`；无 React/Vite）。
2. 移入：
   - `configSchemas.ts` → `src/registry.ts`；`adminNavigation.ts` 中的 key 分组常量 → `src/registry-groups.ts`（菜单解析函数留在 admin）。
   - `adminApi.ts`、`announcementsApi.ts`、`inviteAdminApi.ts`、`textPostprocessApi.ts` → `src/api/*`；`getAdminApiUrl(environment)` 调用点改为显式 `apiBaseUrl` 参数。对应单测随文件移动。
3. Admin SPA 改为从 `@miniapp/admin-client` 导入。
4. `.eslintrc.json` 为 `packages/admin-client/**`、`packages/admin-cli/**` 增加“禁止导入 frontend/backend/admin/cs-platform”规则。
5. 验证：admin-client typecheck/test；admin typecheck/test/build；`pnpm lint:imports`。失败即停。

## 阶段 2：`@miniapp/admin-cli`（只连生产）

1. 骨架：`src/main.ts`（命令分发、`--json` 输出与退出码）、`src/output.ts`、`src/errors.ts`、`src/confirm.ts`（写操作 `--yes` 门禁）。
2. `src/store.ts`（0700/0600、原子写、刷新锁）、`src/client.ts`（supabase client 指向生产代理、自定义 storage、读重试、超时）。
3. 账号：`setup`、`login`（仅 TTY，隐藏密码，登录后 `set_operator_name`，校验 `can_access_prod`）、`logout`、`whoami`。
4. 配置：`list/describe/get/validate/draft get/draft set/diff/publish/discard/releases/rollback`；路径级 JSON 差异。
5. 角色卡与布局、公告、邀请、富文本规则（request_id 恢复）、测试类命令。
6. `help --json` 输出完整命令目录（名称、参数、是否写操作）。
7. 根 `package.json` 增加 `admin` 脚本，参数原样透传。
8. 你执行 `! pnpm admin setup` 与 `! pnpm admin login` 后：跑生产只读冒烟；读出 `lobby_pinned_characters`、`image_plaza_tags_feature_enabled` 生产当前值并告诉你，再进入阶段 3。

## 阶段 3：入口清理、后端改动、菜单归类

1. 注册表删除 6 项（3 个死 key + 打标开关 + 主推候选；回访赠送是页面不是 key）；删除对应编辑器分支、`OutreachCreditGrantView.tsx`、`LobbyPinnedCharactersEditor.tsx`、`outreachCreditsApi.ts` 及测试；发布历史行的 key 用 `string` 承接。
2. 后端：
   - `image-plaza/config.ts` 去掉打标开关读取；`routes/image-plaza.ts` 分享时无标签即打标。
   - 删除 `lobby/pinned-characters.ts`；`recommendation.ts`、`recommended-ranking.ts`、`recommendation-ranking.ts`、`featured-snapshot.ts`/`featured.ts` 去掉固定位/主推参数与分支；更新相关测试。
   - shared 删除 `lobby-pinned-characters.ts` 契约及导出；`pnpm -r typecheck` 确认无残留消费者。
3. 菜单：admin-client 增加 `ADMIN_MENU_GROUPS`；`App.tsx` 侧栏按 7 组渲染，默认展开选中项所在组；CLI `config list` 使用同一分组。
4. 验证：shared test；backend test（lobby、image-plaza 相关）；admin typecheck/test/build；本地 `pnpm --filter @miniapp/admin dev` 看菜单与各页面可打开。

## 阶段 4：文档与性能基线

- `packages/admin-cli/README.md`：setup、login、常见流程（改配置、上下架角色、发公告）、退出码、安全约定。
- `AGENTS.md` 新增“运营平台操作”小节；`.claude/skills/mijing-admin/SKILL.md`。
- 更新 admin spec（architecture-and-files、modules）、`docs/ARCHITECTURE.md`、lobby/image-plaza 相关 spec 中关于主推与打标开关的描述。
- 从 Grafana 采集 `/` 页面（Android/iOS）与三个接口近 7 天 P95，回填 `task.json.meta.mobile_performance`。

## 验证命令

```bash
pnpm --filter @miniapp/admin-client typecheck && pnpm --filter @miniapp/admin-client test
pnpm --filter @miniapp/admin typecheck && pnpm --filter @miniapp/admin test && pnpm --filter @miniapp/admin build
pnpm --filter @miniapp/admin-cli typecheck && pnpm --filter @miniapp/admin-cli test
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/features/lobby src/routes/lobby-recommendation.test.ts src/routes/image-plaza.test.ts src/routes/characters.test.ts
pnpm -r typecheck && pnpm lint:imports && git diff --check
```

## 人工验证（生产）

1. `whoami --json`；非 TTY 下 `login` 返回 `usage`，未提示密码。
2. 只读：`config list/describe/get/draft get/releases`、`character list/get`、`layout get/releases`、`announcement list`、`invite records`、`text-rules get`。
3. 门禁：任一写命令不带 `--yes` → `confirmation_required`，网页无变化；`validate` 故意给错值 → 字段路径报错。
4. 经你同意后：选一个低风险配置 `draft set → diff → publish → get → rollback`，网页核对操作人。
5. 网页先存草稿 → CLI `draft set` 返回 `draft_exists`（验证后放弃该草稿）。
6. 删除本机会话文件后执行命令 → `auth_required`。
7. 发布后：首页推荐正常、金框正常；分享一张无标签图片自动打标。

## 风险与剩余

- 富文本规则、布局等网页有拖拽/预览，CLI 以 JSON 整体提交，正确性依赖同一 shared 与数据库校验。
- refresh token 失效（长时间未用、网页登出）时需要人重新 `login`。
- 停用主推后，若将来要恢复需回退代码（数据库配置行仍在）。
- 已删除 key 与回访赠送 RPC 的数据库对象保留，后续清理需单独迁移。
