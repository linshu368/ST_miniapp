# 图片广场与图片创作第二版 — 技术设计

> 状态：草案。Open Questions（尤其 Q1）未拍板前，状态机与部分表字段不得冻结为最终契约。交互以原型为准，见 `prd.md`。

## 1. 架构边界

| 包         | 职责                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `shared`   | 广场/创作/分享/模型目录/弹窗配置/标签的 Zod 契约与错误码；禁止 frontend 直接用 DB 行类型                                         |
| `backend`  | 路由 + features：广场 feed、作品、点赞、独立创作会话与生成、报价扣费、分享上架返利、运营配置读取；计费走既有 wallet/RPC 模式扩展 |
| `frontend` | 广场 / 详情 / 创作三路由（或等价 scene）；数据仅经 `src/lib/api/` React Query hooks                                              |
| `admin`    | 模型管理、弹窗配置、内容标签 3 页；鉴权与环境隔离沿用现网                                                                        |
| `database` | 新对象按八域归属评审后再写 `packages/shared/migrations/`；禁止平行 supabase/migrations                                           |

跨应用仅 HTTP；LLM/出图计费编排仍经 `features/generation/`（或在其旁扩展 image-plaza feature，但**不得**绕过统一结算入口另造扣费）。

## 2. 复用调研

### 直接复用

- `packages/shared/src/api/images.ts` — DTO/错误码/计费预览形状（V2 宜新建 `image-plaza.ts` 等，避免把 chat message 语义撑爆）。
- `packages/backend/src/features/image/*` + `generation/image-upstream.ts` — 异步 job、翻译、双 provider、Storage 转存思路。
- `billing.settle_image_generation` + wallet precheck — 「成功才扣、失败不消耗」模式。
- `platform/runtime-config.ts` + `features/image/config.ts` — 运营配置读取范式；返利比例新 key 只读此处。
- Admin 草稿/发布/`base_version`、以及 `PaymentPromptDialogConfigEditor` — 弹窗 JSON 编辑与预览可参考形态。
- Frontend `lib/api/images.ts` 轮询 + wallet 刷新 — 创作消息流恢复模板。

### 扩展

- 出图 upstream：多模型、img2img/edit；当前仅 Grok/Z 聊天图。
- 报价：按模型×分辨率×模式；非固定 `image_generation_credits`。
- Storage：广场公开作品 vs 创作私有产物的 bucket/路径/URL 策略（现网 chat 图为 public URL，与部分 spec「签名」表述不一致，V2 需在 design 终稿写明选定策略）。

### 新建（最小充分）

- 独立创作会话与消息/产物（**不**复用 `/chat/[characterId]` 语义，不硬塞 `chat_message_images`）。
- 广场作品、点赞、标签关联、分享记录、返利幂等键、账号首次分享完成标志。
- Frontend：广场瀑布流、详情、创作壳（历史侧栏 + 消息流 + 底部抽屉）。
- Admin 三页 + 用户端消费 API。

### 明确不复用 / 不提前泛化

- 不把原型内存 FEED/模拟 genSeq 当生产。
- 不建通用「运营工作流引擎」或 AB 框架。
- 不把 Venice LLM catalog 直接当出图模型目录。

## 3. 数据流（概念）

```
广场 feed ←→ GET plaza（游标 + q + tag）
详情 / 用同款 ←→ GET work + snapshot（含受控参考图授权）
创作发送 → quote → accept job → 对话内 pending → worker → settle → 消息原位替换
分享 →（Q1 状态机）→ publish work + rebate RPC（幂等：artifact_id / charge_id）
Admin 改模型文案/标签/弹窗 → 持久化 → 用户端读同一版本
```

分享与返利必须绑定**具体产物 + 实扣事实**，禁止「当前最新图」模糊定位。

### 3.1 分享弹窗状态机（已确认 · 方案 C）

服务端权威事实：`tip_enabled`（Admin 弹窗开关）+ 账号 `has_completed_first_share`（仅在分享 RPC 成功时置真）。

```
点击未分享产物的分享入口
  ├─ tip_enabled == false → 直接 share RPC → 轻提示
  ├─ has_completed_first_share == true → 直接 share RPC → 轻提示
  └─ tip_enabled && !has_completed_first_share
        → 展示引导弹窗（不写「已展示即永久」）
              ├─ 确认「分享至广场」→ share RPC 成功 → 置 has_completed_first_share → 轻提示
              └─ ✕ / 遮罩 → 关闭，不分享；下次点击仍走弹窗分支
```

- 生成成功**不得**自动打开弹窗（与原型演示代码差异，以产品确认覆盖）。
- 「返 N%」角标：账号首次点击分享入口后按账号消失（可与打开弹窗或直接分享同一次请求更新）。
- 并发：两个设备同时「首次确认分享」时，share RPC 对账号标志与单图返利均须幂等。

## 4. 可靠性设计

| 故障点            | 策略                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| 上游超时/失败     | 明确超时；有限重试仅安全幂等读；失败不结算；UI「本次未消耗」                                               |
| 重复点击发送/分享 | 客户端锁 + 服务端 idempotency key / unique(share, charge)                                                  |
| 并发分享同图      | DB 唯一约束保证最多一次上架返利                                                                            |
| 离页/重启         | job 可查询恢复；`genSeq`/attempt 防旧响应写新会话                                                          |
| 报价漂移          | 受理时锁定 quote 快照；扣费以快照为准                                                                      |
| 配置损坏          | fail closed，拒受理                                                                                        |
| 返利比例变更      | 分享时快照；不重算历史                                                                                     |
| 免审 UGC          | **本期无下架/举报 UI**（Q6-C）；分享成功即上架即返；**不追回**已发返利；探索环境接受内容风险，生产上线另议 |
| 限流/容量         | feed 游标分页；生成队列沿用/扩展现有 claim worker                                                          |
| 可观测            | pino：允许字段、结果摘要、耗时、链路；禁 token/完整 prompt/大图 URL 明文滥记                               |

## 5. 八域归属（待 Q 拍板后落 migration）

规划阶段预归类（实施前按 `schema-and-object-conventions.md` 终审）：

| 对象                       | 建议域                                | 权威写入                     | 生命周期                       |
| -------------------------- | ------------------------------------- | ---------------------------- | ------------------------------ |
| 创作会话/消息/生成 attempt | experience（或 content 子域，终审定） | backend worker + user action | 用户删除/保留策略另定          |
| 广场作品（公开快照）       | experience/content                    | 分享动作                     | 下架软删，不追回返利           |
| 点赞                       | experience                            | user                         | 可取消                         |
| 标签定义                   | app_core / ops config                 | admin                        | 删标签解绑不删作品             |
| 模型目录与价               | app_core runtime_config 或专用 config | admin                        | 版本化                         |
| 弹窗文案配置               | app_core                              | admin                        | 版本化                         |
| 返利比例                   | app_core.runtime_config               | 技术改库                     | 分享时快照到 ledger            |
| 返利/分享 ledger           | billing                               | share RPC                    | 不可变成功行                   |
| 账号首次分享完成           | experience 用户标志                   | **仅分享 RPC 成功时**置真    | 账号生命周期；✕ 弹窗不写此标志 |

## 6. 兼容与演进

1. **聊天图**：去掉新生图入口；旧 `chat_message_images` 只读展示 + pending 收口；不共用 V2 attempt 表语义。
2. **Prompt 上限**：V2 创作 600；旧契约 1000 — 分契约或分字段，避免双轨误伤。
3. **发布**：仅探索环境；生产另任务。Feature flag / 路由隔离，便于回滚到隐藏入口。
4. **回滚**：关入口 + 停受理新 job；不自动删已分享内容；账务靠幂等与 ledger 审计。
5. **灰度**：探索环境全量即可；勿上未确认的生产迁移。

## 7. 高复用组件边界（前端）

最小共享、避免过早抽象：

- `PlazaCard` / `PlazaFeed`（纯图 + 操作层）
- `WorkDetail`（上图下信息 + 参考图切换）
- `StudioShell`（顶栏 + 可选左栏 + 消息流 + 输入区）
- `BottomSheet`（设置 / 模型共用）
- `ShareTipModal`（单按钮 + ✕ + 9:16；文案来自配置）
- `usePlazaFeed` / `useStudioConversation` / `useShareWork` hooks

后端按 feature 分包：`plaza`、`studio`（或 `image-plaza`）、`share-rebate`；报价与 settle 复用 billing helpers。

## 8. 与原型差异的工程强制项

| 原型演示                    | 生产必须                                                       |
| --------------------------- | -------------------------------------------------------------- |
| 固定 FEED / 内存 liked      | 分页 API + 持久化点赞                                          |
| `setTimeout` 假生成         | 真实 job + 恢复                                                |
| `setmodel` 清参考图 + toast | **按产品确认实现**（Q3-B）；在不支持模型上「添加参考图」仍阻止 |
| 前端 `currentQuote` +10/+20 | **不采用**；服务端按需求 3.12 + edit 固定档 quote（Q7）        |
| Admin 改 TIP 即时内存       | **草稿→发布→回滚**（Q5-B），复用现有 Admin 配置发布链          |
| 旧 gen/result/shared 页     | 不实现为默认路径                                               |

## 9. Open Design Dependencies

产品决策 Q1–Q8 均已冻结（见 `prd.md` Key Decisions）。Admin 弹窗校验拒绝 `{reward}`；用户端读已发布配置；`{rate}` 与结算读 runtime_config 返利键。实施前核验 Anime 上游 id → 业务键 `anime-wai` 映射，不改变「10 模型全上」产品范围。
