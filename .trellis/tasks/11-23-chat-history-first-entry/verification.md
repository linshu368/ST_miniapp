# 实施验证记录（2026-11-23）

状态：已获用户“进行修复处理 / 继续处理”授权并启动 Trellis 实施。当前是本地候选，未提交、未推送、未部署。真实 TEST 功能/负载对照及生产 48 小时复测未完成。

## 已通过

| 检查                                                      | 结果                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| shared 全量单元测试，maxWorkers=2                         | 27 文件、365 项通过                                                                    |
| frontend 全量单元测试，maxWorkers=2                       | 81 文件、942 项通过（最终全量复跑）                                                    |
| 新增历史生命周期回归所在既有文件                          | 55 项通过，含 4 项新回归；不依赖浏览器                                                 |
| backend 排除 integration，maxWorkers=2，testTimeout=15000 | 190 文件、2052 项通过                                                                  |
| 最终 Backend 重点复跑                                     | detail/logger/execute/generate.lifecycle 共 4 文件、155 项通过，含新增执行超时分类回归 |
| pnpm -r typecheck                                         | 全部 8 个包通过                                                                        |
| Frontend production build                                 | 通过；原 standalone 已核验路径后移到仓库内忽略目录                                     |
| Frontend lint                                             | 通过；仅保留本轮无关的已有 img 警告                                                    |
| backend logging guard / logging:validate                  | 通过；393 个运行文件，5 条日志规则                                                     |
| complexity budget                                         | 通过；收紧本轮聊天页基线，未新增复杂度豁免                                             |
| git diff --check                                          | 通过                                                                                   |

Backend 全量复跑仅在子进程临时将 DEEPSEEK_API_KEY 置空、ENGINEERING_TELEMETRY_ENABLED=false，避免既有状态栏单测因本机真实 DeepSeek 配置选择真实通道；未修改 .env 或部署配置。最终重点复跑覆盖所有运行代码收尾变化。最终 Frontend 全量942项包含新增历史生命周期和退避期间总超时的回归；不重复累加重点复跑数量。

## 执行中的失败与处理

- 默认并发 shared 测试曾遇到主机内存分配失败；限制 maxWorkers=2 后全部通过。
- 首次 Backend 使用直接 vitest 命令，误绕过默认脚本的 integration 排除，触发 TEST 数据库测试与 Docker 测试：Docker 不存在；数据库旧角色 fixture 的 characters.enabled 列不存在。该轮不能记为通过，也不能据此判断生产数据库结构。
- TEST 集成测试创建了测试用户后在角色插入阶段失败，afterAll 执行清理；随后仅查询最近30分钟 history-test-\* 用户的 HEAD count，环境明确为 test，结果0，未读取业务行。未执行迁移、未操作生产库。
- 首轮 Backend 另有路由5秒计时与状态栏真实通道干扰；两份路由测试单独15秒预算下52项通过，随后使用明确排除integration的完整命令2052项通过。
- 新增 Hook 依赖 lint 问题和测试函数命名问题已修正；服务端deadline回归已通过。误把 Fastify 自身计时器纳入泄漏断言的检查已去除，保留本次请求截止与迟到结果不继续编排的真实断言。
- pnpm lint:imports 的单引号在 Windows cmd 下被作为字面字符传给 ESLint；改用 Python subprocess 参数数组执行相同 ESLint 参数，检查通过。
- 本机既有 TLS 配置输出警告，本轮没有修改其配置。

## 本地 UI 与尚未验证

用户最新要求“不启动本地ui测试”。此后未启动浏览器、Playwright、预览或本地 UI 服务。此前被中断的 @chat 尝试未完成，不记为通过。

以下仍是发布前/发布后门禁，不能以 mock 代替：

1. 隔离 TEST 的真实 DTO/角色权限/分支/占位符、200轮分页完整性，真实计费/额度/供应商与并发恢复。
2. stale streaming 全窗口查询计划、积压吞吐、失败回绕、跨副本和重启容量；通过前保持 GET 原同步恢复。
3. PT409 具体拒绝守卫与历史 finalize 超时的数据库证据；本次补诊断，不盲目修改 CAS、重试或扣费。
4. 部署后按 release、平台、用途统计真实 N、页面及GET P95、应用首字终态和恢复积压。没有新生产样本，不宣称达到目标。

重复执行命令、实现边界和移动端基线见 [运行说明](../../../docs/chat-history-first-entry.md)。建议未来扩展现有 @chat 固定场景，本次按用户要求不启动。

补充结果：Admin production build通过（仅既有bundle大小提示）；全仓库import边界检查通过。Frontend/Backend在最后超时诊断修改后单独typecheck通过；Frontend最终重点3文件89项通过。
