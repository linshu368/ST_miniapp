# 实施与验证（2026-11-20，本地未部署）

## 已实现

- 安全标量诊断及真实Pino投影：实际输出字数、prompt/历史/近期/旧记忆规模、目标/实际验收线/硬上限、超出字数、usage、结束原因、响应大小及耗时；未知测量省略。
- 超长立即精简完整候选，80%→60%目标；坏修复不覆盖完整候选，主阶段最多三次，原质量校验不变。预精简按真实85%线记录，异常回落可见。
- 120s取消覆盖静止body，清理不延长截止；worker按需claim一条、每轮最多三条；逐块确认进度，后续失败保留；finish未知/lease_lost不报成功，第三次连续失败告警沿用。
- 无UI、公共API、SQL、模型/计费或生产配置变更。

## 验证结果

| 检查                                                  | 结果                                            |
| ----------------------------------------------------- | ----------------------------------------------- |
| Backend全量测试（隔离本机DeepSeek配置，maxWorkers=2） | 190文件，2041测试通过                           |
| 记忆/transport/worker/真实Pino定向回归（最终源码）    | 5文件，73测试通过                               |
| Shared既有测试                                        | 27文件，363测试通过                             |
| Backend typecheck                                     | 通过                                            |
| lint:backend-logging                                  | 通过，389运行时文件                             |
| logging:validate                                      | 通过，5条规则、1条启用                          |
| lint:complexity                                       | 通过；无关存量超标警告保留，未放宽基线          |
| 导入边界                                              | 等价ESLint命令通过，原脚本有Windows参数解析问题 |
| Prettier（本轮全部TS）                                | 通过                                            |
| 日志/P95/模块规划及module-updates候选                 | 通过                                            |
| git diff --check                                      | 通过                                            |

## 环境问题与复现

初次全量8项失败：两个路由文件并发超时后单独复跑通过；既有creator-status-bar测试读取本机可选DeepSeek配置，意外进入真实供应商路径，导致超时/与mock不符。该路径不是本次记忆压缩调用；没有统计其是否产生供应商费用，不能声称本轮绝无外部模型请求。随后在子进程屏蔽此配置、降低并发，全量2041项通过；未修改`.env`或该无关测试/产品代码。

完整复现（PowerShell）：

```powershell
@'
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath,
  ['node_modules/vitest/vitest.mjs','run','--exclude','**/*.integration.test.ts','--maxWorkers=2'],
  { cwd:'packages/backend', env:{...process.env,DEEPSEEK_API_KEY:''}, stdio:'inherit' });
process.exit(result.status ?? 1);
'@ | node --input-type=module
```

原`pnpm lint:imports`中的`--rule '{}'`在Windows被解析成非法字符串；保持配置和扫描范围，去掉无效果的空覆盖后通过：

```powershell
pnpm exec eslint --no-eslintrc -c .eslintrc.json "packages/*/src/**/*.{ts,tsx}" --no-inline-config
```

Backend无build脚本，无跨包/部署变更，不编造build结果。执行了复杂度收紧命令并丢弃其对无关存量的收紧；本轮运行时代码均在预算内，无基线例外。

## 发布门禁与边界

未提交、push、部署、执行migration或修改生产配置/告警。TEST/production的retry_guard状态尚未分别核验；真实记忆语义质量、跨副本/数据库退避、上线24h拒绝率/成本/覆盖及双端P95仍需真实验证，mock不能证明。

长期验收建议复用@chat固定场景覆盖记忆就绪/失败保留旧版，见运行说明；本轮未启动浏览器或新增一次性UI脚本。module-updates.json已check但未apply/archive，供最终人工审阅；所有文件未暂存，不自动提交。
