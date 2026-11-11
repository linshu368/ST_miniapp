> Historical planning/research record: the initial 200-sample policy below was superseded by the user on 2026-11-11. Current policy is local-mobile-p95-v2: 20 samples per platform/page/API/scenario, P95 <= 2000ms.

# 调研依据与差异

采集日期：2026-11-11。以下均区分仓库事实、用户决策和拟实现能力。

## 仓库证据

- `.trellis/scripts/mobile_performance_gate.py`：目前schema_version=1；检查required/not_applicable和正数目标，缺整个字段则为历史任务放行；没有200样本、≤2000ms或结果校验。新政策不能只改模板，必须审计删除字段绕过。
- `.trellis/scripts/task.py`：start在状态变化前校验声明；finish只清指针。不能为结果门禁把中途切任务误当“功能完成”。
- `.trellis/scripts/common/task_store.py::cmd_archive`：模块知识应用后将status写completed。性能校验需先于这些副作用。
- `.trellis/scripts/archive_stale.py`：模块门禁失败存在直接写completed并移动目录的fallback。必须扩展其性能校验，不能把当前行为推断成“过期只移动、不代表完成”。
- `.trellis/tests/test_mobile_performance_gate.py`、`test_trellis_git_safety.py`：已有可扩展Python回归。
- `packages/ui-tests/playwright.config.ts`：chromium、android/narrow、workers1、retries0；没有WebKit性能项目。`preview.mjs`使用Next dev，`tests/fixtures.ts`重置mock并阻断外网。应新建同包perf配置，不能污染现有mock用例。
- `frontend/lib/perf/page-ready.ts`、`page-tracker.ts`：ready来自业务状态，存在导航/启动/可视内容计时；不要提前终点。`api-timing.ts`与`api/client.ts`已有logical总时长和attempt分段，优先复用。
- `scripts/test-conversation-branches-migration.sh`：隔离PG17 fixture与语义验证可保留。性能SQL一个大事务最后rollback，不包含真实逐请求提交；不作为新机制完整证据。
- `.github/workflows/ci.yml`：目前无本机制Performance Gate；YAML存在也不证明仓库保护设置已要求该check。
- `packages/shared/migrations/README.md`：Database Migration workflow为远端schema执行通道；TEST和production不保证同构。采样器不改DDL。

## 连接实况边界

本会话前一轮：配置解析为TEST `zoqelpfhurwehlvypryl`，开启TLS验证后REST根入口200。当前两个MCP连接均未列出TEST且get_project返回not found。此处不凭MCP可见性判断数据库不可达，也不把REST200当成目标schema齐备。本轮规划没有发起200次压测、业务行读取或远端写入。

## 官方文档

- [Playwright设备模拟](https://playwright.dev/docs/emulation)：模拟viewport、userAgent、touch等；本项目用户明确接受模拟，报告仍须标记，不作真机声明。
- [Playwright浏览器版本](https://playwright.dev/docs/browsers)：浏览器二进制与Playwright版本关联，工具升级后需固定并记录版本，旧证据不能跨浏览器版本拼接。
- [Playwright Request事件](https://playwright.dev/docs/api/class-request)：response是headers阶段，requestfinished才是网络body结束；HTTP错误仍可能requestfinished，因此还需状态和应用契约校验。网络事件也不自动覆盖client排队和应用重试。
- [PostgREST连接池](https://docs.postgrest.org/en/stable/references/connection_pool.html)：请求可等待池连接；不能用SQL用时冒充本地到TEST的接口总耗时。

## 已排除的过度设计

首期无需新的性能数据库表、独立服务、通用流程DSL或同时引入多套压测产品。现有Playwright可完成两个浏览器与真实请求采样，Node/Python可统计并验证。pgbench/k6可用于专项容量诊断，不是200样本门禁的先决条件。
