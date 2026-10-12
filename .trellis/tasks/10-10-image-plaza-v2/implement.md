# 图片广场与图片创作第二版 — 执行计划

> Q1–Q12-rev 已拍板；最终规划摘要**已确认**；用户于 2026-10-12 明确授权开始实施。

## 0. 规划收口

1. [x] Q1–Q8 回写 PRD/AC；PRD 收敛。
2. [x] design 草案 + implement/check JSONL。
3. [x] 用户确认最终规划摘要（2026-10-10）。
4. [x] 声明 `module_impact`；八域归属终审；核验 `anime-wai -> wai-Illustrious`；2026-10-12 获实施授权。

## 1. 建议实施顺序

| 阶段 | 内容                                                                                                               | 验证焦点                |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| A    | **独立** `shared/api/image-plaza*` + 返利 runtime_config key + migration 草案（不改 `api/images.ts`）              | shared test / typecheck |
| B    | **独立** `features/image-plaza` + `routes/image-plaza*`：quote/会话 job/settle（不调用 `features/image` 业务入口） | 失败不扣；与聊天图隔离  |
| C    | 同模块：广场 feed/详情/点赞/用同款、分享返利                                                                       | AC10–AC11               |
| D    | frontend：`/create` 直接广场瀑布流 + 吸顶去创作；底栏保留；保留原许愿流程但隐藏入口；详情/用同款                   | AC01–AC05               |
| E    | 同模块：创作壳、抽屉、就地生成、四图标                                                                             | AC06–AC09               |
| F    | 分享弹窗与角标（Q1-C）                                                                                             | AC12                    |
| G    | Admin 三页 + 用户端读已发布配置                                                                                    | AC13–AC14               |
| H    | 探索环境联调、故障注入、文档同步                                                                                   | AC15–AC16               |

> Q9：不改会话「看看TA」frontend。Q10：广场前后端业务目录与聊天图生成完全独立，仅可复用平台基建。

## 2. 验证命令（实施期）

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/admin typecheck
# 视改动范围：
pnpm -r typecheck
```

人工：对照原型默认广场路径走 `prd.md` 4.1 必验路径（以拍板后的 Q1 替换弹窗步骤）；故障：断网分享、重复点击、离页恢复、余额不足、模型下架后用同款。

## 3. 风险文件 / 回滚点

- 勿改动聊天「看看TA」frontend；勿破坏既有 `chat_message_images` settle / claim。
- **Q10**：广场业务不得挂进 `routes/images` / `features/image` / `lib/api/images` / `chat-message-image`；平台基建可复用，业务目录必须独立。
- 返利 RPC 必须幂等；回滚优先关入口停受理，不删 ledger。
- Admin 并发用 `base_version`，避免覆盖。

## 4. task.md 映射（拍板后细化）

阶段 A–H 已映射到 `task.md` T1–T9（T8 Skipped）。
