# Shared 架构与出口

## 目录职责

| 路径                         | 职责                                      |
| ---------------------------- | ----------------------------------------- |
| `src/index.ts`               | 包根公开出口，应用通过 workspace 源码消费 |
| `src/api/*`                  | HTTP/SSE DTO、枚举、跨端配置 schema       |
| `src/config/database.ts`     | 数据库环境配置纯工具，不建立连接          |
| `src/st-bridge/*`            | ST bridge handle 等稳定跨端适配           |
| `src/telemetry/sanitize.ts`  | 遥测脱敏纯函数                            |
| `src/logging/conventions.ts` | 日志字段约定；当前未从根出口导出          |
| `src/*.ts`                   | 小型稳定纯函数、类型和 fixture            |
| `src/__tests__/*`            | 契约与纯函数测试                          |
| `migrations/*`               | 唯一 SQL migration 源，不属于 TS 出口     |

## 根出口治理

- `src/index.ts` 当前导出全部 API、database config、st-bridge、PNG 类型、fixtures 和纯工具；新增导出前检查命名冲突、bundle/browser 安全和真实消费者。
- 类型专用符号优先 `export type`；禁止根出口产生连接、读取 env、启动 timer 或访问 Node-only API。
- 不为“方便”导出应用内部类型。若模块仅供 server 使用，应采用明确子路径且不得从根出口再导出。
- 删除出口按破坏性变更处理：搜索四个应用、脚本与测试，提供兼容期和迁移顺序。

## 简洁复用原则

shared 复用稳定的领域语言与纯行为，不合并仅语法相似但语义不同的 DTO。新抽象应有现实的多个消费者或明确稳定边界；否则保留在所有者包。
