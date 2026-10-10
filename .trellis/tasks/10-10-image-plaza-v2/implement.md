# 图片广场与图片创作第二版 — 执行计划

> Q1–Q8 已拍板；最终规划摘要**已确认**；用户要求**先不实施**——暂不 `task.py start`、不写产品代码。

## 0. 规划收口

1. [x] Q1–Q8 回写 PRD/AC；PRD 收敛。
2. [x] design 草案 + implement/check JSONL。
3. [x] 用户确认最终规划摘要（2026-10-10）；**实施暂缓**。
4. 下次启动前：声明 `module_impact`（changes + module-updates）→ `task.py start`；八域 migration 终审；Anime 上游 id 核验映射。

## 1. 建议实施顺序

| 阶段 | 内容                                                                                   | 验证焦点                |
| ---- | -------------------------------------------------------------------------------------- | ----------------------- |
| A    | shared 契约骨架 + runtime_config 返利 key（只读）+ 八域 migration 草案（先评审后执行） | shared test / typecheck |
| B    | backend：模型目录下发、quote、独立会话 accept/job/settle                               | 失败不扣、并发、坏配置  |
| C    | backend：广场 feed/详情/点赞/用同款 snapshot、分享上架+返利幂等                        | AC10–AC11               |
| D    | frontend：广场 + 详情 + 用同款（对齐原型视觉）                                         | AC01–AC05               |
| E    | frontend：创作壳、抽屉、就地生成、四图标、刷新网格                                     | AC06–AC09               |
| F    | 分享弹窗与角标（按 Q1 终裁）                                                           | AC12                    |
| G    | Admin 三页 + 用户端读配置                                                              | AC13–AC14               |
| H    | 移除聊天新生图入口 + 旧 pending 收口说明                                               | AC15                    |
| I    | 探索环境联调、故障注入、文档同步                                                       | AC16                    |

## 2. 验证命令（实施期）

```bash
pnpm --filter @st/shared test
pnpm --filter @st/shared typecheck
pnpm --filter @st/backend typecheck
pnpm --filter @st/frontend typecheck
pnpm --filter @st/admin typecheck
# 视改动范围：
pnpm -r typecheck
```

人工：对照原型默认广场路径走 `prd.md` 4.1 必验路径（以拍板后的 Q1 替换弹窗步骤）；故障：断网分享、重复点击、离页恢复、余额不足、模型下架后用同款。

## 3. 风险文件 / 回滚点

- 勿破坏 `chat_message_images` settle / claim。
- 返利 RPC 必须幂等；回滚优先关入口停受理，不删 ledger。
- Admin 并发用 `base_version`，避免覆盖。

## 4. task.md 映射（拍板后细化）

将上表 A–I 拆为可勾选 Task 行（含 Files / Depends / Verification）；当前 `task.md` 仍为占位。
