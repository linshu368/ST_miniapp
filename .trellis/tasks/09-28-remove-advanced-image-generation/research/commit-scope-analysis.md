# 指定 commits 与当前范围调研

## 1. 调研方法

- `git show --name-status/--stat` 查看六个指定 commits。
- `git show <commit> -- <path>` 查看关键图片 hunks。
- `git log --all -- <image paths>` 识别后续图片修复，避免整文件回退。
- `git grep` 搜索 `advanced_image`、`image_tier`、`basic_image`、`feature_free_trial_limits` 等当前消费者。

## 2. Commit 结论

### `8f63e0d`（主要回退源）

同时引入 Backend 的 advanced/basic 档位、图片 free trial、VIP 门禁、provider 快照和 main-only 结算。实施只能删除 advanced 部分，图片 free trial 属于明确保留范围。涉及：

- `features/generation/image-upstream.ts`
- `features/image/config.ts`
- `features/image/generate.ts`
- `ChatMessageImageRepository.ts`
- `MiniappWalletRepository.ts`
- `routes/images.ts`

这是主要逆向来源，但当前文件已叠加后续修复，不能整文件 checkout。

### `5059ad2`（混合 migration + Shared 图片契约）

- 新 migration 同时修改 voice 和 images，不能删除/改写。
- `shared/api/images.ts` 增加 tier、VIP、free-trial、billing snapshot 字段；只收敛 advanced/VIP 档位字段，保留普通图片 free-trial 和 billing snapshot。
- 同 commit 的 `voice.ts` 和 telemetry 非高级图片主体，不整体回退。

### `7cb2f8a`

主要归档任务和 module spec；没有新的图片产品实现。当前 spec 的事实更新应通过本任务完成后的 module update 处理，不改旧任务历史。

### `5413afe`

只修改会话发送后免费聊天额度刷新，属于普通聊天，不是 images，明确排除。

### `de4bb3d`

merge 了完整 VIP 策略、文本计费和 Admin。冲突合并中保留了 `image_advanced_*`，同时加入 `feature_free_trial_limits`。只能删除 `image_advanced_*` 相关 hunk；`feature_free_trial_limits.basic_image` 及 VIP 策略、文本计费、支付、签到必须保留。

### `ac8967a`

增强通用 `feature-free-trials` 形状并涉及 batch-lab/text generation。语音仍消费该通用能力，不能整体回退。架构文档后续如需同步应只修改图片事实，但用户本次限定四包，默认不把 `docs/ARCHITECTURE.md` 纳入产品实施 allowlist，除非审核时明确授权文档同步。

## 3. 当前直接消费者

- Backend：`features/image/config.ts`、`generate.ts`、`routes/images.ts`、`ChatMessageImageRepository.ts`。
- Frontend：`chat-message-image.tsx` 直接显示高级按钮、VIP lock 和 tier 计费；`lib/api/images.ts` 接线。
- Shared：`api/images.ts` 暴露双 tier 与 VIP/free-trial；仅双 tier/高级 VIP 部分退场，free-trial 保留。
- Admin：`configSchemas.ts`、`ConfigValueEditor.tsx`、`adminNavigation.ts`、`App.tsx` 暴露四个高级配置；`VipStrategyView` 暴露 `basic_image` 免费次数。

## 4. 必须保留的后续能力

- 图片 PostHog 安全 telemetry（`7ab4a18` / `439c6ee`）。
- 普通图片 provider 失败降级、URL/MIME/大小/私网防护、Storage、DB lease worker。
- 前端 Telegram 保存、轮询恢复、失败重试和 `chat_image` 充值回流。
- 普通图片 `basic_image` free trial、语音 free trial 和 VIP 其他权益。

## 5. 尚待实施前确认

1. 已确认只移除 advanced；普通图片 VIP 免费调用次数和相关 Admin/Shared/Backend/DB/Frontend 展示全部保留。
2. 四个相关 migrations 在 test/production 的实际执行状态。
3. 历史 advanced attempt 是否已产生；无论答案如何，默认保留可读兼容，不删业务行。
