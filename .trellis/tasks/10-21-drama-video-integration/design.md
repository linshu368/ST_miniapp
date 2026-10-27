# 技术设计：短剧视频接入 miniapp（整体架构，父任务视角）

本设计只覆盖跨子任务的整体架构和边界；每个子任务的具体实现设计在各自的 `design.md` 里（`10-21-drama-archive-access/design.md`、`10-21-drama-api-contract-backend/design.md`、`10-21-drama-frontend-ui/design.md`）。

## 整体链路

```
drama_archive.dramas / videos / ai_results（test 库，已存在）
drama-videos 私有桶（已存在）
        │ service_role 只读（新增授权，子任务 1）
        ▼
packages/backend
  features/drama/
    repository.ts   —— getDomainDb('drama_archive') 查 dramas/videos/ai_results
    assemble.ts      —— 字段回退：标题/标签/简介/是否可播
    signed-url.ts    —— storage.createSignedUrl 现签播放地址
  routes/drama.ts
    GET /api/dramas          列表（标题 + 占位 tag/简介 + 封面占位）
    GET /api/dramas/:id      详情（含该短剧下的视频 + 现签播放地址）
        │ HTTP REST（和其它功能一致，X-Init-Data 鉴权）
        ▼
packages/frontend
  lib/api/drama.ts           React Query hooks
  components/nav             BottomNav 4 → 5 个 tab
  app/(main)/dramas/page.tsx          列表页
  app/(main)/dramas/[id]/page.tsx     播放页
```

（子任务 2 对应 `packages/backend` 那一层，子任务 3 对应 `packages/frontend` 那一层，子任务 1 对应最上面的权限/访问前置。）

## 关键架构决策（跨子任务统一，子任务不得各自变通）

1. **访问路径**：backend 用自己的 `service_role` 直接只读 `drama_archive`，走和其它域一样的 `getDomainDb(domain)` 入口，不新建专门的访问层，不复用 `drama_worker`。这保持了"一个 repository 横跨多个域时必须显式取多个域客户端"的既有约定，没有为短剧模块发明新的数据访问范式。
2. **契约单一来源**：`DramaSummary`/`VideoItem`/`DramaDetail` 只在 `packages/shared/src/api/drama.ts` 定义一次，backend 和 frontend 都消费它，不允许任一方私定并行类型。
3. **字段回退逻辑单点实现**：所有"原始 vs AI 兜底"的判断只在 backend `features/drama/assemble.ts` 一处实现。这保证了二期 `ai_results` 产出真实内容后，前端不需要改一行代码——这是方案本身的核心卖点，设计上必须守住"回退逻辑不下沉到前端"这条线。
4. **播放链接现签不落库**：这是本仓库第一次引入私有桶现签模式（此前都是公开桶 `getPublicUrl`），只在子任务 2 的 `signed-url.ts` 一处实现，不在其它地方重复签名逻辑。
5. **导航扩展方式**：子任务 3 用扩展现有 `NAV_ITEMS` 常量数组 + `grid-cols-4 → grid-cols-5` 的方式新增入口，不重写 `BottomNav` 组件，保持现有 4 个 tab 的行为/样式不受影响。

## 已知规范偏离（明确记录，不回避）

`drama_archive` 不在 `.trellis/spec/database/supabase/schema-and-object-conventions.md` 登记的八域地图里，该规范要求"扩展八域需要单独的架构决策、权限模型、迁移顺序和回滚方案"。本次接入**不创建新 schema**（`drama_archive` 已由外部项目建好），但确实让 `DOMAIN_SCHEMAS` 以只读方式收录了一个游离在域地图之外的 schema，这不完全满足规范的完整要求。

处理方式（三方已达成一致，记录在此避免后续审查时被当成遗漏）：

- 子任务 1 的代码注释和文档里显式写明这个缺口。
- 本父任务 `prd.md` 的 Open Issue 同步记录。
- 不在本轮任何子任务里尝试"顺手补齐"正式架构决策——用户已经在方案文档里明确这是刻意延后到二期的决定，仓促补一个不完整的架构决策文档反而是过度设计。

## 跨子任务验证策略

- 每个子任务独立可验收：子任务 1 验收标准不依赖 backend/frontend 代码（纯 SQL/权限层面验证）；子任务 2 验收标准可以用 curl 独立验证，不依赖前端；子任务 3 最终验收依赖真实接口，但页面结构可以先用 mock 并行推进。
- 父任务的整合验收是额外的一层：三个子任务各自验收通过后，父任务要实际走一遍完整用户路径（打开短剧 tab → 列表 → 详情 → 播放），确认组装起来的整体行为符合预期，不只是分别验证局部正确。

## 回滚/灰度形状

- 子任务 1（权限/暴露）：纯增量授权，出问题可对称回滚，不影响任何现有功能（没有任何现有代码路径依赖 `drama_archive` 不可读）。
- 子任务 2（backend API）：全新路由和 feature，不影响任何现有接口，出问题直接下线这组新文件。
- 子任务 3（frontend）：底部导航改动是本次唯一"触碰现有共享组件"的改动；如果验收发现问题，revert `bottom-nav.tsx` 的 diff 即可恢复到 4 tab 状态，`/dramas` 路由仍存在但没有入口可达，等同于临时下线，不需要额外的 feature flag 机制。
- 三个子任务之间没有需要联动回滚的耦合——按依赖顺序，子任务 1 的回滚不影响子任务 2/3 已经写好的代码（它们只是暂时跑不通，不会产生错误数据或副作用）。
