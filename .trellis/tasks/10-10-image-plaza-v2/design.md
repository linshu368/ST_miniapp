# 图片广场与图片创作第二版 — 技术设计

> 状态：规划已确认（含 Q9–Q12-rev），2026-10-12 已获实施授权。创作 Tab 打开即广场瀑布流，见 `prd.md`。

## 1. 架构边界（Q10：与聊天图生成业务隔离）

| 包         | 职责                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared`   | **新建**广场/创作/分享契约（建议 `packages/shared/src/api/image-plaza*.ts`）；**不**把广场 DTO 塞进既有 `api/images.ts`                                                            |
| `backend`  | **新建**路由与 feature 目录（建议 `routes/image-plaza*.ts`、`features/image-plaza/`）；**不**在 `routes/images.ts` / `features/image/*`（聊天看看TA）上叠广场业务方法              |
| `frontend` | **`/create` = 广场瀑布流**（Q12-rev）：吸顶「图片广场」+「✦ 去创作」，底栏保留；**移除**创作下许愿入口与 `/create/wish` 依赖；hooks 用 `src/lib/api/image-plaza*`；不复用聊天图 UI |
| `admin`    | 模型/弹窗/标签三页可新建视图文件；配置发布链复用 Admin 基建                                                                                                                        |
| `database` | **新建**广场/创作/分享相关表与 RPC；**不**扩展 `chat_message_images` 承载 V2 attempt                                                                                               |

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
# 删除或停用 create/wish；layout 中 NAV_HIDDEN 的 /create/wish、大厅「许愿池」文案一并清理
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
3. **Prompt**：V2 创作 600，独立契约字段。
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

产品决策见 `prd.md` Key Decisions（含 Q7-rev、Q9–Q12-rev）。quote 服务只读已发布模型目录的上架星尘价；`mode=t2i|i2i|edit` 不改变价目，仅影响上游调用形态。业务 ID `anime-wai` 映射 Venice provider id `wai-Illustrious`（2026-10-12 官方模型页核验）；映射只存在于已发布模型配置。API 前缀固定 `/api/image-plaza`，Storage 前缀固定 `image-plaza/{userId}/{attemptId}/`。
