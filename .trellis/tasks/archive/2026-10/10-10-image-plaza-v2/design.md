# 图片广场与图片创作第二版 — 技术设计

> 状态：规划已确认（含 Q9–Q12-rev3），2026-10-12 已获实施授权。创作 Tab 打开即广场瀑布流；许愿池功能保留但入口暂时隐藏，见 `prd.md`。

## 1. 架构边界（Q10：与聊天图生成业务隔离）

| 包         | 职责                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared`   | **新建**广场/创作/分享契约（建议 `packages/shared/src/api/image-plaza*.ts`）；**不**把广场 DTO 塞进既有 `api/images.ts`                                                     |
| `backend`  | **新建**路由与 feature 目录（建议 `routes/image-plaza*.ts`、`features/image-plaza/`）；**不**在 `routes/images.ts` / `features/image/*`（聊天看看TA）上叠广场业务方法       |
| `frontend` | **`/create` = 广场瀑布流**（Q12-rev3）：吸顶「图片广场」+「✦ 去创作」，底栏保留；保留 `/create/wish` 原流程但隐藏入口；hooks 用 `src/lib/api/image-plaza*`；不复用聊天图 UI |
| `admin`    | 模型/弹窗/标签三页可新建视图文件；配置发布链复用 Admin 基建                                                                                                                 |
| `database` | **新建**广场/创作/分享相关表与 RPC；**不**扩展 `chat_message_images` 承载 V2 attempt                                                                                        |

跨应用仅 HTTP。出图与扣费须走统一平台能力时：

- **允许复用（平台/基建级）**：`platform/runtime-config.ts` 读法、wallet precheck/ledger 模式、pino/超时/鉴权中间件、Storage 上传工具函数（若已是 lib 级）、Admin 草稿发布 RPC。
- **禁止混用（业务级）**：聊天图的 route handler、feature 编排入口、attempt 仓储、frontend 聊天图 hooks/组件、`shared/api/images.ts` 的聊天语义类型作为广场 API。

若需共用「上游 HTTP 客户端 / 文件转存」等纯技术能力，应抽到 **无业务语义** 的 lib/platform 辅助，或在 `features/image-plaza` 内自建调用层；**不得**让广场业务直接调用 `features/image/generate` 等聊天图编排函数。

计费：新建广场专用 settle/rebate RPC（或明确命名的 billing 函数），语义绑定广场产物；可参考 `settle_image_generation` 的「成功才扣」模式，但**不共用**聊天图 settle 入口与幂等键空间。

## 2. 建议目录与命名（实施时落地）

```
packages/shared/src/api/image-plaza.ts          # 契约（可拆分 plaza / studio / share）
packages/backend/src/routes/image-plaza.ts      # 路由注册 + @frontend-ready
packages/backend/src/features/image-plaza/      # quote、studio job、plaza feed、share…
packages/frontend/src/lib/api/image-plaza/      # React Query hooks
packages/frontend/src/app/(main)/create/       # /create = 广场瀑布流；子路由 studio/详情等
# 保留 create/wish 与沉浸式导航隐藏；当前不提供可见许愿池入口
packages/admin/.../ImagePlaza*.tsx              # 三页运营
packages/shared/migrations/*_image_plaza_*.sql  # 新表/RPC
```

既有路径保持不动（本任务也不改聊天入口代码，见 Q9）：

- `shared/api/images.ts`、`backend/routes/images.ts`、`features/image/*`、`frontend/.../chat-message-image*`

## 3. 复用调研（修订后）

### 可参考、不可业务混用

| 既有                                           | 用法                                                         |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `features/image/*`、`api/images.ts`、聊天图 UI | **只读参考**实现模式；不 import 业务入口做广场编排           |
| `settle_image_generation`                      | 参考「成功才扣」；广场自建 settle/rebate 与幂等键            |
| `runtime-config` + Admin 草稿发布              | **直接复用**读/发布基建；广场配置用新 key / 新 managed 视图  |
| Storage / wallet helpers                       | 复用 lib 级工具；路径与 ledger reference type 用广场专用前缀 |

### 必须新建

- 独立创作会话、消息、生成 attempt、广场作品、点赞、标签、分享/返利记录、账号首次分享标志。
- Frontend 广场/详情/创作壳与 hooks。
- Admin 三页用户端消费 API。

### 明确不做

- 不把原型 FEED/假生成当生产。
- 不建通用工作流/AB 框架。
- 不把 Venice LLM catalog 当出图模型目录。
- 不把广场业务挂进聊天图模块「顺手扩展」。

## 4. 数据流（概念）

```
[image-plaza] 广场 feed ←→ GET …/image-plaza/…
[image-plaza] 详情 / 用同款 ←→ GET work + snapshot
[image-plaza] 创作 → quote → accept job → pending → worker → settle → 消息原位替换
[image-plaza] 分享 → publish + rebate RPC（幂等）
Admin 草稿发布 → 用户端读已发布配置
```

与聊天图链路并行存在、互不调用业务层。分享与返利绑定**具体广场产物 + 实扣事实**。

### 4.1 分享弹窗 UI（最新设计稿 + Q11-B）

```
┌─────────────────────────┐
│ [✕]                     │
│ ┌─────────────────────┐ │
│ │  用户本次生成作品图  │ │  ← 上：具体产物图，非运营配图
│ └─────────────────────┘ │
│   运营配置主文案        │  ← 中：如「分享返还 {rate}」+ 说明
│   （无「不再提示」）     │  ← Q11-B
│ ┌─────────────────────┐ │
│ │    分享至广场        │ │  ← 下：唯一主按钮
│ └─────────────────────┘ │
└─────────────────────────┘
```

Admin 配置中部文案与弹窗总开关；`{rate}` 运行时替换；顶图始终绑当前待分享 artifact。实现时忽略设计稿中的「不再提示」勾选。

### 4.2 分享弹窗状态机（Q1-C + Q11-B）

服务端权威事实：`tip_enabled` + 账号 `has_completed_first_share`（仅分享 RPC 成功时置真）。**无** `tip_suppressed` /「不再提示」。

```
点击未分享产物的分享入口
  ├─ tip_enabled == false → 直接 share RPC → 轻提示
  ├─ has_completed_first_share == true → 直接 share RPC → 轻提示
  └─ tip_enabled && !has_completed_first_share
        → 展示引导弹窗（顶图=该产物）
              ├─ 确认「分享至广场」→ share RPC 成功 → 置 has_completed_first_share → 轻提示
              └─ ✕ / 遮罩 → 关闭，不分享；下次点击仍弹
```

生成成功不得自动弹窗。「返 N%」在账号首次点击分享入口后消失。并发分享须幂等。

## 5. 可靠性设计

| 故障点            | 策略                                                         |
| ----------------- | ------------------------------------------------------------ |
| 上游超时/失败     | 明确超时；有限重试仅安全幂等读；失败不结算；UI「本次未消耗」 |
| 重复点击发送/分享 | 客户端锁 + 服务端 idempotency / unique(share, charge)        |
| 并发分享同图      | DB 唯一约束                                                  |
| 离页/重启         | job 可查询恢复；attempt 防旧响应写新会话                     |
| 报价漂移          | 受理锁定 quote 快照                                          |
| 配置损坏          | fail closed                                                  |
| 返利比例变更      | 分享时快照；不重算历史                                       |
| 免审 UGC          | 本期无下架/举报（Q6-C）；不追回已发返利                      |
| 限流/容量         | feed 游标；广场自有 claim/worker（可同进程不同队列名）       |
| 可观测            | pino 规范；禁敏感字段                                        |

## 6. 八域归属（2026-10-12 终审通过）

| 对象                                                | 归属                                                        | 权威写入                     | 生命周期                                   |
| --------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| `image_plaza_conversations/messages/attempts/works` | `experience`                                                | Backend / worker / share RPC | 核心互动内容与图片产物；保留审计，作品软删 |
| `image_plaza_likes`                                 | `miniapp_features`                                          | 用户动作                     | 可随广场功能下线删除                       |
| `image_plaza_share_rewards`                         | `billing`                                                   | share RPC                    | 不可变账务与幂等事实，长期保留             |
| 标签 / 模型目录 / 弹窗文案                          | `app_core.runtime_config`（正式）+ 既有 `admin` 草稿/发布表 | Admin 发布                   | 版本化                                     |
| 返利比例                                            | `app_core.runtime_config`                                   | 技术改库                     | 分享时快照                                 |
| 首次分享完成事实                                    | `app_core.miniapp_user_settings` 扩展字段                   | 仅分享成功事务               | 账号生命周期                               |

完整的不变量、消费者、跨 schema 依赖、RLS/grant、容量、迁移顺序与恢复见
`research/implementation-readiness.md`。对象不进入 `public` 或旧 `miniapp` schema。

## 7. 兼容与演进

1. **聊天图（Q9）**：不改 frontend；旧表保持；与广场模块零业务耦合。
2. **独立模块（Q10）**：广场下线不影响聊天图代码路径；反之亦然。
3. **Prompt**：Frontend 输入框、请求契约、作品快照、数据库与服务端模型调用链统一由 600 调整为 2,000 字。初始作品“用同款”把不超过 2,000 字的完整来源提示词恢复到输入框并关闭自动改写。
4. **发布**：仅探索环境；关广场入口即可停新受理。
5. **回滚**：停广场 job + 隐藏路由；不删 ledger；不碰聊天图 settle。

## 8. 前端模块边界（广场包内复用）

仅在 **image-plaza** 包内抽组件，避免与聊天 UI 共享：

- `PlazaCard` / `PlazaFeed`、`WorkDetail`、`StudioShell`、`BottomSheet`、`ShareTipModal`（上用户成图 + 中运营文案 + 下分享；无「不再提示」）
- `usePlazaFeed` / `useStudioConversation` / `useShareWork`

## 9. 与原型差异的工程强制项

| 原型演示             | 生产必须                                                 |
| -------------------- | -------------------------------------------------------- |
| 固定 FEED            | 分页 API + 持久化点赞                                    |
| 假生成               | 真实 job + 恢复（广场自有）                              |
| `setmodel` 清参考图  | Q3-B                                                     |
| +10/+20 或 edit 另表 | 不用；一律 Admin「上架星尘价」（Q7-rev）；有参考图不加价 |
| Admin 内存即时改     | 草稿→发布→回滚                                           |
| 旧独立结果页         | 不实现为默认路径                                         |

## 10. Open Design Dependencies

产品决策见 `prd.md` Key Decisions（含 Q7-rev、Q9–Q13-rev3）。quote 服务只读已发布模型目录的上架星尘价；`mode=t2i|i2i|edit` 不改变价目，仅影响上游调用形态。业务 ID `anime-wai` 映射 Venice provider id `wai-Illustrious`（2026-10-12 官方模型页核验）；映射只存在于已发布模型配置。API 前缀固定 `/api/image-plaza`；generated Storage 使用现有用户/attempt 路径，seed 扩展采用独立内部导入路径。

## 11. 初始广场数据扩展（Q13-rev3）

详细输入审计、字段统计、来源限制与导入故障模型见 `research/seed-gallery-data-audit.md`。本节是后续实施设计，本轮不修改代码或数据。

### 11.1 方案选择与拒绝项

选择扩展现有 `experience.image_plaza_works` 与 `experience.image_plaza_artifacts`，让初始作品继续使用同一 feed/detail/like/use-same API；以 `origin` 约束区分用户生成和 `civitai_seed`，并为 seed 允许无 user/attempt 的合法状态。

拒绝：

- 不伪造系统用户、conversation、quote、attempt 或 billing ledger；这些对象代表真实用户生成/计费事实。
- 不另建第二张公开 feed 表或在 service 层 union 两套游标；会增加详情、点赞、搜索、签名 URL 和分页一致性成本。
- 不把来源热度写入 `like_count`；本地点赞 RPC 会从 likes 事实重算。
- 不在 migration 中嵌入 8,227 行或远程下载；migration 保持结构变更，数据通过可恢复的离线 importer 分批进入。
- 不依赖 Civitai 热链，不按 URL `.jpeg` 后缀推断真实格式，不静默截断提示词。

### 11.2 数据不变量与八域归属

扩展对象仍归 `experience` 域，Backend/importer 是权威写入方，Frontend 只消费脱敏 DTO。核心约束：

- `origin=generated`：现有 `user_id/attempt_id` 必填且来源字段为空。
- `origin=civitai_seed`：`user_id/attempt_id` 为空，`source_platform=civitai`、`source_image_id/source_image_url/source_heat` 必填，artifact 必须存在；禁止进入分享返利/账务写路径。
- `source_image_id` 在 Civitai seed 范围唯一；字段用 TEXT 保留外部标识语义，不假定数据库整数范围。
- `source_heat >= 0` 且只参与初始顺序物化；`like_count` 仅表示本地用户点赞。
- seed artifact 的 `attempt_id` 可空，但存储路径必须属于 `image-plaza/imports/civitai/`；generated artifact 保持用户/attempt 路径。
- public/shared work DTO 不暴露 source ID、source URL、source heat。分享 RPC 显式拒绝 seed artifact，避免未来路由误用。

不得修改已部署的 `20261012_image_plaza_v2.sql` 追加该扩展；使用新的向前兼容 migration。先在 test 采集实际 shape/constraint/RLS/grant，再执行并记录前后差异。

### 11.3 快照与“用同款”

导入快照：`model_id/name` 按白名单映射；`mode=t2i`；`reference_artifact_id=null`；`reasoning=false`；`auto_optimize=false`；`style=None`；aspect ratio 从实图尺寸映射为模型支持的最近比例；resolution 取已发布安全默认档。

提示词采用单一 2,000 字上限：Frontend textarea、手工提交 DTO、snapshot/attempt/message、Backend 校验和数据库约束同源，不新增双层 prompt 字段或服务端绕过输入框的特殊提交协议。“用同款”仍按现有 source work snapshot 创建会话，并把完整提示词恢复到 textarea；提交时携带 `auto_optimize=false`，任一层都不得静默截断。

工作簿中 8,054 条可通过 2,000 字本地长度校验，超过 2,000 字的 173 条先隔离；如以后人工提供经批准的缩短版本，须保留变更审计且不覆盖源数据。部分 Venice 模型公开限制可能低于 2,000，故“本地可接纳”不等于“上游已证明可调用”：实施日须按模型 canary 实测，拒绝项继续隔离，不能通过截断绕过。

seed 的“用同款”只复制模型、提示词和快照参数，不引用源图；Studio 必须从 conversation snapshot 恢复并提交 `auto_optimize=false`，不能继续使用当前固定 `true`。模型下架/参数失效时返回明确错误，不静默换模。

### 11.4 导入编排、容量与可观测性

离线 importer 顺序：XLSX dry-run → 来源/内容 allowlist → Civitai 元数据核验 → 有界并发下载 → 字节/MIME/尺寸/解码校验 → 可选转码 → 确定性 Storage 上传（不覆盖）→ 小事务写 artifact/work → checkpoint。

外部调用有显式超时；仅 GET 做有限退避重试；限制重定向和最终主机；限制 20 MiB/8,192 px；按批次限流。上传成功而 DB 失败时立即补偿删除本次对象，补偿失败写 orphan reconciliation 清单。日志只允许批次、source ID、状态、摘要计数、耗时和 `{ err }`，禁止提示词、完整 URL、响应正文和凭据。

60 条分层样本推算原图存储约 19.4 GiB。建议产品在实施授权前确认单份优化 WebP（长边 2,048 px）或保留原图；未确认不得以样本估算替代容量批准。

### 11.5 排序、兼容和恢复

首次导入按 `source_heat DESC, source_image_id` 生成稳定 `published_at`，继续使用现有 `(published_at,id)` 游标；幂等重跑不得更新时间。新用户作品按真实发布时间自然位于初始数据之前。搜索仍按现有公开字段，不因内部 ID/URL 扩大搜索面。

发布顺序：基础 migration 在 test 成功 → 新兼容 migration → shared/backend/frontend 兼容发布 → dry-run → 小批 canary → feed/详情/同款/点赞人工回归 → 分批全量。停止条件与逐项验收见审计文档。回滚以 `origin=civitai_seed` 软删除为先，确认无引用后清理 Storage；不影响 generated UGC、账务和本地点赞。production 仍需单独授权。

### 11.6 尚未关闭的依赖

- 来源使用/再托管权利、署名和撤回要求。
- 成人内容安全 allowlist 与审核责任人；现有“UGC 无审核页”不能替代第三方批量初始内容的离线准入。
- 图片转码/分辨率/容量选择。
- 共享抓取会话正文目前不可访问，其中可能存在的额外规则尚未纳入已验证事实。

## 12. 2026-10-14 性能与失败语义修订

### 12.1 复用与最小方案

继续复用现有 cursor infinite query、React Query work key、Radix Dialog、Supabase Storage 签名和 `createConversation`；不增加分页状态源、缩略图表、图片代理或通用手势框架。Feed DTO 仍使用同一作品契约，只在列表读路径签发宽度受控的 Storage transform URL，并将列表不消费的 `reference_image_url` 置空；详情读路径继续签发原图和参考图。

### 12.2 故障、并发与恢复

- attempt 受理前检查进程内 Venice key 与 worker 开关；不可用时 503 fail-fast，避免产生必败任务。该检查不替代 worker 内防线，部署中途失效仍由原有失败不扣费逻辑收口。
- 下拉刷新复用 infinite query refetch，只重置/刷新页链，不与下一页请求并行触发；触摸距离设上限且不阻止系统滚动。
- 下一页仍以 `(published_at,id)` 游标和 20 条固定页长保证稳定；IntersectionObserver 有界触发，React Query 去重并发请求。
- Storage transform 失败可通过详情原图路径诊断；不改原始对象和数据库，可直接 forward-fix 回退为原图签名。
- “用同款”仍由数据库 insert 确认后导航，不做乐观伪造；仅移除新建空会话后必为空的 messages/attempts 二次读取。

### 12.3 容量、可观测性与拒绝项

20 张最高约 720px、质量 72 的 feed 图显著降低 20–50 MiB seed 原图的首屏传输/解码压力。后端沿用请求耗时日志与 `{ err }`；不记录 prompt、签名 URL 或 key。不引入 service worker、无限预取、客户端原图压缩或新 CDN 层，避免超出本次已证实瓶颈。
