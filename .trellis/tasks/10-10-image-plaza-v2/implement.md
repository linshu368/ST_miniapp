# 图片广场与图片创作第二版 — 执行计划

> Q1–Q12-rev3 已拍板并于 2026-10-12 获实施授权；Q13 初始数据扩展于 2026-10-13 获代码实施授权。兼容层和离线 importer 已完成，真实数据写入仍受来源/内容审核、明确环境与 test canary 门禁约束。

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
| I    | 初始数据兼容层：origin/source 字段、seed artifact、全链路统一 2,000 字 prompt 契约、脱敏 DTO 与用同款快照          | AC17–AC21               |
| J    | 离线 importer：XLSX dry-run、allowlist、元数据核验、下载/转存、幂等写入、checkpoint/补偿/reconciliation            | AC17–AC23               |
| K    | test canary、容量/失败阈值、列表/详情/同款/点赞/泄漏回归；获单独授权后分批导入，production 仍另行确认              | AC18–AC24               |

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

初始数据扩展另需：运行 importer dry-run；对重复/断点续跑、超限 prompt、源图 404、重定向越界、MIME 欺骗、超 20 MiB/8,192 px、上传成功写库失败、模型下架、source 字段泄漏执行故障注入；在 test canary 中人工打开列表/详情并完成“用同款”提交。不得用生产库或生产 Storage 代替 test 验证。

## 3. 风险文件 / 回滚点

- 勿改动聊天「看看TA」frontend；勿破坏既有 `chat_message_images` settle / claim。
- **Q10**：广场业务不得挂进 `routes/images` / `features/image` / `lib/api/images` / `chat-message-image`；平台基建可复用，业务目录必须独立。
- 返利 RPC 必须幂等；回滚优先关入口停受理，不删 ledger。
- Admin 并发用 `base_version`，避免覆盖。
- 初始数据的来源授权/内容 allowlist/存储策略任一未关闭即停止导入；不以静默截断、跳过审计或伪造用户生成事实绕过。
- importer 与 schema 使用新文件/新 migration 向前演进，不改写已部署基础 migration；回滚先软删 seed，再按引用检查清理 Storage。

## 4. task.md 映射（拍板后细化）

阶段 A–H 已映射到 `task.md` T1–T9（T8 Skipped）；初始数据规划审计为 T10；阶段 I/J 已映射并完成 T11/T12；阶段 K 对应 T13，等待审核 allowlist、明确 test 环境和实库 migration/canary。
