# 技术设计

## 1. 基线与差异策略

### 1.1 基线

`8f63e0d^`（`d1c6513`）只用于识别 advanced 引入前的单入口形状，不作为普通图片免费体验的回退目标。实施时对每个候选文件执行三方比较：

1. 基线：`d1c6513:<path>`；
2. 高级图片引入提交及后续图片 commits；
3. 当前 `HEAD:<path>`。

只移除“advanced 档位/高级 VIP 门禁/高级 provider/高级价格结算”增量，保留普通图片 free-trial、telemetry、provider 降级、下载安全、错误收口和运营修复。禁止用 `git revert <commit>` 或整文件 checkout 覆盖上游/后续行为。

### 1.2 指定 commits 判定

| Commit    | 图片相关结论                               | 规划处理                                                           |
| --------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `8f63e0d` | Backend 高级档位与普通图片免费体验同时引入 | 只逆向 advanced hunks，保留 basic free-trial                       |
| `5059ad2` | Shared 图片 DTO + 混合语音/图片 migration  | 只收敛 advanced DTO；保留图片 free-trial 字段，历史 migration 不改 |
| `7cb2f8a` | 主要是任务/spec 归档，没有产品图片实现     | 不回退产品代码；后续用本任务 module update 修正当前事实            |
| `5413afe` | 普通聊天免费额度刷新                       | 非 images，明确不改                                                |
| `de4bb3d` | merge，混合 VIP 策略/Admin/计费            | 只移除 Admin/Shared 中高级图片或图片专属 hunk，保留其他 VIP 功能   |
| `ac8967a` | 通用 free-trial 形状与架构说明             | 不整体回退；通用能力被语音消费，保留                               |

## 2. 目标数据流

```text
Frontend 普通“看看TA”
  -> Shared 单一图片 request（历史 tier 输入兼容归一）
  -> Backend ownership/回复资格/普通图片 runtime config + basic_image 免费额度
  -> 中文描述 draft 或自定义描述
  -> 单一普通 attempt + DB lease worker
  -> DeepSeek 翻译 -> 现有 provider/降级 -> Storage 安全转存
  -> 既有 settle_image_generation 原子消费免费次数或扣费 + current ready
  -> Frontend 轮询、展示、预览、保存
```

不再经过：`advanced` runtime config、advanced VIP status 门禁、advanced provider dispatch、advanced price settlement。普通图片的 `basic_image` reservation/consume/release 保持不变。

## 3. 分层改造

### 3.1 Shared 契约

- `api/images.ts` 删除 advanced 档位选择、双 `tiers`、`vip_status` 和 advanced 锁定信息；普通图片 config/attempt/description 继续携带免费额度与 billing preview。
- 为旧客户端兼容，request runtime schema 在一个发布周期内可保留可选 `tier` 并将其 strip/normalize；TypeScript 新公开 request 不再鼓励发送 tier。这样 Backend 可先兼容旧 bundle，再由后续任务删除兼容输入。
- attempt 响应保留 `billing_mode`、`free_trial_ordinal` 等普通图片免费体验展示所需字段；`tier` 是否暂留只读兼容以历史 advanced 行可展示为准。
- `feature-free-trials.ts` 的 `basic_image`、通用类型及 `voice.ts` 免费体验契约全部保留。

### 3.2 Backend

- `features/image/config.ts` 删除 `image_advanced_*` 和高级 VIP 拼装；保留普通图片 free-trial quota 与 next billing config。
- `routes/images.ts` 恢复单一普通图片描述/创建流程；删除高级 VIP 拒绝和 advanced 分支，保留普通图片免费名额 reserve/release、billing preview、鉴权、ownership、`@frontend-ready`、结构化日志及 402 映射。
- `features/image/generate.ts` 与 `features/generation/image-upstream.ts` 删除按 attempt tier 选高级 provider/model 的分支，继续使用当前普通 provider 与已验证降级策略。
- `ChatMessageImageRepository` 新写入只走普通图片，但保留 `FeatureFreeTrialRepository` 协作和免费结算；历史行读取必须容忍已存在的 advanced 值。
- `MiniappWalletRepository` 只在确认为高级图片/图片免费实现新增的方法上做 hunk 级清理；消费明细中普通图片 ledger 查询必须保留。

### 3.3 Frontend

- `chat-message-image.tsx` 删除 `ImageGenerationTier` 状态、advanced 按钮、VIP-required Sheet 与 `/vip` 跳转；`describe()` 恢复无 tier 参数。
- 保留 `chat_image` 充值回流、普通图片计费文案、telemetry、轮询、失败重试、Telegram 保存和当前 ready 图片展示。
- `lib/api/images.ts` 与页面接线同步契约；只精确刷新图片和钱包 query，不引入第二套请求。
- `lib/vip/presentation.ts` 中仅删除无其他消费者的 `advancedImageEntry`；VIP 页面和媒体/文本其他展示保持不变。

### 3.4 Admin

- 从 `managedConfigKeys`、schema、metadata、导航分组和 `ConfigValueEditor` 删除四个 `image_advanced_*` 项。
- 普通图片配置页保留；`VipStrategyView` 的 `feature_free_trial_limits.basic_image` 输入、校验、草稿/发布流程全部保留。
- Shared VIP strategy 契约继续要求 `voice` 与 `basic_image`，不改成 voice-only。

## 4. 数据库兼容与演进

### 4.1 不改历史 migration

`20260922_media_feature_free_trials.sql` 同时包含语音和图片对象，且可能已在 test/production 执行。不得删除或编辑该文件，也不得假设仓库存在即代表两个环境均已执行。

### 4.2 实施前只读确认

通过迁移账本/人工记录确认 test 与 production 是否执行：

- `20260922_media_feature_free_trials.sql`；
- `20260923_admin_vip_media_config.sql`；
- `20260923_vip_strategy_config.sql`；
- `20260923_vip_strategy_media_limit_alignment.sql`。

不读取业务行。若无法确认，应用代码按“列和旧配置可能存在”设计；配置数据清理由独立、可安全失败且需 test-first 人工执行的 forward migration 完成，不碰业务 attempt/计费行。

### 4.3 最小 forward-fix

- 默认不物理删除 `image_tier/billing_mode/free_trial_ordinal/wallet_policy/vip_valid_until`，以免破坏历史 attempt、当前函数和回滚；新代码停止写高级语义即可。
- 新增 `20260928_remove_advanced_image_config.sql`：删除四个 `image_advanced_*` runtime config、对应 Admin 草稿/发布快照，从 managed-key 函数与 validator 移除高级图片支持，并增加负向 CHECK 防止绕过 RPC 回写。独立 Admin audit event 保留；历史图片 attempt、普通图片 settlement、free-trial reserve/consume/release、语音函数、`feature_free_trial_limits.basic_image` 和 VIP strategy 不动。
- 先 test 单文件执行并验证 shape/grants/RLS/关键读写，再考虑 production。回滚优先恢复函数定义/重新插入安全默认配置，不删除历史数据。

## 5. 可靠性设计

| 维度     | 处理                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 超时     | 保留图片描述、provider、下载的现有显式 timeout；本任务不新增外部调用                              |
| 重试     | 保留 provider 写请求不自动重投、Replicate 只轮询同 prediction 的规则                              |
| 幂等     | 保留 attempt ID、DB lease、free-trial reservation 和 settlement 幂等                              |
| 并发     | current ready 与钱包扣款继续由原子 RPC/DB 约束处理，不使用进程锁                                  |
| 事务     | Storage 成功与数据库结算边界沿用现有补偿；余额明确不足删除对象，结算未知保留待对账                |
| 降级     | 只保留普通图片现有 provider 降级，不允许 advanced 自动降成普通后仍按高级收费                      |
| 容量     | 沿用图片字节、MIME、私网 URL、尺寸和 worker 租约上限                                              |
| 可观测性 | 保留图片 telemetry/pino 安全摘要，不记录 prompt、URL、Storage path、token 或错误 body             |
| 恢复     | 发布前先关闭高级入口；已受理旧 attempt 按快照收口，新请求走普通路径；异常时停新请求并 forward-fix |

## 6. 最小充分方案与拒绝项

- 不新建图片服务、adapter、队列或通用 tier 框架；删除分叉并复用既有普通图片链路。
- 不删除或弱化 VIP/free-trial 基础设施；普通图片和语音都继续消费。
- 不重构与图片无关的 Admin/VIP 页面，不借机清理命名或注释。
- 不整 commit revert、不整文件回退，避免覆盖后续上游图片可靠性修复。

## 7. 发布、停止条件与回滚

1. 先确认高级图片 runtime 开关关闭；若仍开启，先由运营关闭，停止新 advanced 请求。
2. 部署兼容旧 DB/旧客户端的 Shared + Backend，再部署 Frontend/Admin 去入口。
3. 应用代码先停止读写 advanced 配置，再在 test 单文件执行配置清理 migration；验证通过后才单独申请 production，避免旧 Backend 在配置删除后继续请求高级配置。
4. 停止条件：普通图片 5xx/结算异常上升、历史图片无法读取、语音额度或 VIP 策略出现回归。
5. 回滚代码时恢复上一版本应用；数据库采用 forward-fix 恢复函数/配置，不回写或删除历史 attempt。

## 8. 验证矩阵

- 普通成功：generated/custom prompt -> pending -> ready/current -> 正确扣费。
- 失败：描述、翻译、provider、下载、Storage、settlement unknown，均不错误扣费且可重试。
- 余额不足：上游前拦截或按既有结算语义失败，不显示新 ready。
- 并发/重放：同消息重复点击、worker 重领、settlement 重放不重复扣费或产生两个 current。
- 兼容：旧请求带 `tier=basic/advanced`；历史 advanced ready/failed 行；旧 runtime config 残留。
- 消费者：Frontend 无高级入口；Admin 无高级配置但仍有 basic_image 免费次数；普通图片与语音 free trial、VIP 策略、文本/支付 smoke 不变。
