# 实施计划

## 0. 实施门禁

- [ ] 人工审核 `prd.md`、`design.md`、本文件与 `task.md`。
- [x] 产品口径确认：只删除 advanced，高级入口/调用/结算/管理台配置退场；普通图片 VIP 免费调用次数完整保留。
- [ ] 确认 test/production 上相关 migration 的实际执行状态，仅做只读结构/账本核对。
- [ ] 运行 `task.py start` 后才允许修改产品代码。

## 1. 建立精确回退清单

1. 对用户指定 commits 逐 hunk 标记 `image-remove`、`image-keep`、`non-image`。
2. 对候选文件做 `d1c6513`、引入 commit、当前 HEAD 三方比较。
3. 输出最终 allowlist；实施中发现新文件必须先回到规划补充，禁止顺手修改。
4. 明确保留：普通图片 free-trial 全链路、图片 telemetry、provider 可靠性/安全修复、Storage/worker、语音免费体验、聊天 quota refresh、VIP 非图片功能。

## 2. Shared 先行收敛契约

1. 收敛 `src/api/images.ts` 为单一普通图片 DTO，并设计旧 tier 输入兼容解析；保留 free-trial 与 billing preview 字段。
2. 只清理高级图片类型引用；`basic_image`、通用 free-trial/voice/VIP/wallet 类型保留。
3. 更新现有 shared tests；由于这是跨包契约回退且有历史客户端，规划确认需要回归测试锁定旧 tier 兼容。
4. 运行 Shared tests/typecheck，并记录公开出口增减。

## 3. Backend 恢复普通图片链路

1. 配置层停止读取/返回 `image_advanced_*` 和高级 VIP 状态，继续返回普通图片 free-trial 状态。
2. route 恢复单档位描述/创建，删除高级门禁，保留普通图片 reservation、auth、ownership、日志、`@frontend-ready`。
3. worker/upstream/repository 删除 advanced provider/结算分叉，保留普通图片免费/付费原子 settlement。
4. 历史行读取做兼容，不做破坏性数据回写。
5. 更新现有图片测试；重点覆盖普通成功、失败、余额不足、幂等、旧 tier 请求和历史 advanced 行。

## 4. Frontend 移除高级 UI

1. API hook 与页面接线跟随 Shared 单档位契约。
2. 图片组件移除 tier state、advanced 按钮、VIP lock Sheet；保留普通图片完整交互。
3. 只删除无剩余消费者的高级图片 presentation helper/test；不改 VIP 其他展示。
4. 人工验证 Telegram WebView、移动浏览器、窄屏、safe area、生成中离开/返回、预览/保存和充值回流。

## 5. Admin 移除高级配置

1. 删除 `image_advanced_*` managed keys、schema、metadata、专用 editor 和导航分组。
2. 保留普通图片配置与完整 VIP 策略。
3. 明确保留并验证 `feature_free_trial_limits.basic_image` 的 Admin 输入、校验、草稿和发布流程。
4. 更新现有 Admin 测试并人工验证 test/production 环境切换与发布表单。

## 6. Database forward-fix（仅在确认需要时）

1. 不修改历史 migration。
2. 新建 `20260928_remove_advanced_image_config.sql`，只删除四个 advanced runtime/Admin config、收敛 managed-key/validator 并添加负向 CHECK；写明 domain、不变量、权威写入方、消费者、锁/容量和 forward-fix 恢复。
3. test 环境逐文件验证前后 shape、grants/RLS、普通图片免费/付费读写、历史行读取、语音/VIP 不变。
4. production 不在本任务自动执行；附命令、停止条件和 forward-fix 回滚说明，等待人工批准。

## 7. 验证命令

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin typecheck
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/admin build
pnpm lint:imports
pnpm lint:legacy
pnpm lint:migrations
pnpm -r typecheck
```

如新增 migration，再运行仓库 migration ledger 协议测试及该 migration 的 throwaway DB 场景。真实 provider、Storage、Telegram 保存与环境配置无法在无凭证单测中证明，必须记录人工回归结果和剩余风险。

## 8. 最终范围审计

```bash
git status --short
git diff --name-status
git diff -- packages/backend packages/frontend packages/shared packages/admin
git grep -n -E "image_advanced|advancedImage|高级图片|tier.*advanced|advanced.*tier" -- packages/backend packages/frontend packages/shared packages/admin
```

- 对每个 dirty path 说明为什么是 images 直接范围。
- 非任务已有修改不得纳入；不得自动提交或 push。
- module knowledge 在完成时更新受影响的四个应用模块及数据库迁移基建模块，不把规划推断写成当前事实。
