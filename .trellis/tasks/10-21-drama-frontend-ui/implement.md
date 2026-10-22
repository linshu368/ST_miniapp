# 执行计划：短剧前端列表/播放页与底部导航

前置条件：`10-21-drama-api-contract-backend` 的 `GET /api/dramas`、`GET /api/dramas/:id` 已在 test 环境真实联调通过。页面结构和占位态可以先用方案文档描述的字段形状（mock 数据）并行切 UI，但最终验收必须切到真实接口，不能留在 mock 阶段就报完成。

## 步骤

1. **lib/api/drama.ts**：实现 `useDramaListQuery`/`useDramaDetailQuery`（见 `design.md` §1）。
2. **列表页骨架**：先用 mock 数据（手写几条符合 `DramaSummary[]` 形状的样本，包含有标签/无标签、有封面/无封面的组合）搭 `app/(main)/dramas/page.tsx` 的 UI 和四种状态（loading/error/empty/success）。
3. **详情/播放页骨架**：同样先用 mock 数据搭 `app/(main)/dramas/[id]/page.tsx`，覆盖 `playable=true`/`false` 两种卡片、简介为空/非空两种情况。
4. **接入真实接口**：把 mock 换成 `lib/api/drama.ts` 的真实 hook，对着 test 环境真实数据跑一遍，确认 UI 在真实数据分布下仍然正确（标签大面积为空、`play_url` 是否可播）。
5. **BottomNav 扩展**：按 `design.md` §2 把 `NAV_ITEMS` 扩成 5 项、`grid-cols-4` 改 `grid-cols-5`，图标先用 `Clapperboard`（已确认 `lucide-react` 包含该图标），位置/图标细节待原型确认后再调整。
6. **移动端人工验证**：在 Telegram WebView 和至少一个常规移动浏览器里实际打开短剧 tab、列表页、播放页，确认安全区/点击区域/视频播放正常，5 列导航在窄屏下不挤压错位。
7. **类型检查/构建**：`pnpm --filter @miniapp/frontend typecheck`、`lint`、`build`。

## 验证命令

```bash
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
```

视觉/交互验证是人工打开真实页面核对，不是自动化测试；移动端验证（Telegram WebView、窄屏）需要在 task.md 执行日志里记录实际验证的设备/浏览器组合。

## 风险控制

- 步骤 2-3 的 mock 数据必须覆盖"标签为空"、"简介为空"、"playable=false"、"封面为 null"四种占位态组合，不能只用"数据齐全"的理想样本切 UI，否则接入真实接口后才发现占位态没处理。
- 步骤 5 改动 `BottomNav` 是现有 4 个 tab 共用的组件，改完之后要确认大厅/聊天/创作/我的四个 tab 的高亮、预取、未读红点行为没有被破坏（人工点一遍这 4 个 tab）。

## 回滚

- `lib/api/drama.ts`、`dramas/page.tsx`、`dramas/[id]/page.tsx` 都是全新文件，出问题可直接删除，不影响现有路由。
- `bottom-nav.tsx` 的改动是在现有数组/className 上增量修改，如需回滚，revert 这一次 diff 即可恢复到 4 tab 状态；回滚后 `/dramas` 路由仍然存在但没有导航入口可达，不会报错，只是用户找不到入口（这本身也是一种可用的"临时下线"手段，不需要额外的 feature flag）。
