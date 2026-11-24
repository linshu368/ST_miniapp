# 验证记录（2026-11-24，本地）

## 自动化

| 检查                                                                                                      | 结果                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm -r typecheck`                                                                                       | 通过                                                                                                                                 |
| backend `vitest run --exclude '**/*.integration.test.ts'`（CI 同款占位环境变量）                          | 190 文件 / 2065 用例通过                                                                                                             |
| frontend `test`                                                                                           | 80 文件 / 967 用例通过（含新增 `reset` 用例）                                                                                        |
| shared / admin-client / admin-cli / admin 测试                                                            | 381 / 32 / 24 / 119 通过                                                                                                             |
| 新增 backend「出字后兜底」5 例 + `stream-recovery.test.ts`                                                | 见 implement.md 验证一节                                                                                                             |
| `lint:complexity`                                                                                         | 通过；`createSseTap` 129→125 只收紧本条基线；`readConversationStream` 比改前少 1 行；`runTurn` 比改前多 2 行（仅警告，原本已超基线） |
| `lint:db-contract`（本迁移无警告）、`lint:backend-logging`、`logging:validate`、`lint:migrations`、`lint` | 通过                                                                                                                                 |
| `bash scripts/test-llm-calls-stream-end-migration.sh`（PG17 一次性容器）                                  | 旧行不变、rewrite 与新列可写、非法值拒绝、重跑、回滚语句通过                                                                         |
| admin build                                                                                               | 通过                                                                                                                                 |

## 真实 API（development 环境变量，合成 prompt，只看输出前 120 字）

- assistant prefill：Together 2 次输出乱码（`# lexer - 搜索结果…`、`<ds_safety>…`），Crusoe 1 次正常 → 不采用。
- 续写指令：Together、Crusoe 各 2 次均从断点接上。之后用户改为擦掉重写，续写不再使用。

## 未做（待发布时）

- TEST/生产迁移执行、development 环境真实回合（人为调低 `stall_ms` 触发重写）。
- 上线后 24 小时复查。
