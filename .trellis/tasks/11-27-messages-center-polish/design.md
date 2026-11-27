# 设计

## 方案

**唯一规则「14 天未读窗口」**放在 shared：`NOTIFICATION_UNREAD_WINDOW_MS` 和 `isOutsideNotificationUnreadWindow(publishedAt, nowMs)`。后端用它算未读数和列表 `is_read`，前端用它决定是否收起。前后端用的是同一条规则，红点和列表不会对不上。

### Shared（`packages/shared/src/api/notifications.ts`）

- 新增上面的常量和判断函数。
- `MarkNotificationsReadRequest` 增加 `all?: true`，必须带 `scope`、不能带 `ids`：把该分类窗口内的未读全部标为已读。其他情况的语义不变（只有 ids 才写入）。

### Backend（`routes/notifications.ts`）

- 列表：`limit(51)` → 取 50 条；`is_read = 已读记录 || 超出窗口`。
- 未读数：查询加 `published_at >= 窗口起点`。生产里已发布的行都有 `published_at`，只有 3 条草稿为空，草稿本来就不可见。
- `countUnread` 改成 `listUnreadIds`（返回 id）。未读数取它的长度；`all` 分支拿这些 id 去 upsert `notification_reads`，沿用现有的 `onConflict`，天然幂等。
- `all` 分支：`scope` 缺失或无效、或同时带了 `ids` → 400 `INVALID_READ_TARGET`；没有未读 → `marked: 0`，不写库；成功时记一条 info 日志 `notification.read_all`。

### Frontend

- `lib/api/notifications.ts`：
  - `useMarkNotificationsReadMutation` 的 `onSuccess` 增加 `all` 分支：该分类列表缓存全部置已读，未读数缓存里该分类清零、total 重算，再 invalidate 未读数作为校正。
  - 单条已读的逻辑不变。
- `profile/messages/page.tsx`：
  - **分类红点**：订阅 `useNotificationUnreadCountQuery({ poll: false })`。轮询仍只由 BottomNav 负责，页面进入时会刷新一次。
  - **全部已读**：放在分类栏右侧，当前列表有未读才显示，点击后 `mutate({ scope, all: true })`。
  - **折叠**：列表按窗口分成近期和更早两组；更早的那组收成「更早的 N 条」，点开展开、末尾「收起」，展开状态按分类分别记。
  - **点开不等待**：先 `router.push`，再后台 `markRead.mutate`。去掉 `openError`、`pending` 和 `openingId`。
- `lib/notifications/list-view-memory.ts`（新增，模块内存）：
  - 详情页返回前写入「回到哪个分类 + 各分类的展开状态」，列表页挂载时读一次并清掉。
  - 只有从详情返回时才恢复，从「我的」进入仍是默认状态。
  - 不用 URL 参数，避免为 `useSearchParams` 加 Suspense。

### ui-tests fixture

`/api/notifications/read` 的 mock 支持 `all: true`（只覆盖 personal 的心愿通知）。

## 规划门禁

1. **复用调研**：
   - 复用的部分：已读写入（`notification_reads` upsert）、可见性判断（`isNotificationVisibleToUser`）、未读缓存工具（`read-state.ts`）、`useNotificationUnreadCountQuery`（`poll: false` 的约定）、现有卡片组件。
   - 不复用 / 不改的部分：分页游标没有消费者，不改；也不新建表或 RPC。
2. **可靠性**：
   - 全部已读是幂等 upsert，重复点击和并发都安全。失败时前端不改缓存，按钮还在，可以再点。
   - 后台写单条已读失败只会让红点保留，下次轮询会校正；不影响进入详情。
   - 一个窗口内单分类的未读 id 最多几十条，`in()` 列表的规模没有问题。
   - 本次没有外部调用或新的超时。
3. **最小方案**：
   - 只新增一个 40 行以内的内存模块，没有新的状态源或依赖，不改数据库。
   - 拒绝了的做法：用户级「全部已读水位线」表（要建表，收益和直接 upsert 一样）、真正的翻页（数据量 ≤ 22 条，没必要）、置顶。
4. **演进与恢复**：
   - 无迁移、无数据变化。新接口参数对旧前端透明：旧前端从来不发 `all`。
   - 后端先上线、前端后上线的顺序也成立：前后端在同一个 PR，同时发布。
   - 回滚直接 revert。已写入的已读记录本来就合法，不用清理。
5. **可验证性**：
   - 后端：既有测试改为固定时间，并补充窗口外不算未读、`all` 分支的参数校验、幂等、跨分类隔离。
   - 前端：typecheck、lint，在 `pnpm preview:ui` 里人工走一遍。
6. **性能**：
   - 页面多订阅一个未读数缓存，进入时会多一次 `unread-count` 请求（background 优先级）。
   - 列表上限 20 → 50，返回体增加 ≤ 30 条短文本。
   - 点开详情少等一次 POST：去掉之前 Android P95 1295ms、iOS P95 1154ms 的阻塞。
7. **日志**：沿用 HTTP 终态日志，`all` 分支加 `notification.read_all`（info，字段：scope、marked），失败沿用 `notification.read_failed`。
