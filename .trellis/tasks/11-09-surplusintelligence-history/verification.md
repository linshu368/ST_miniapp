# 验证记录（2026-11-10）

## TEST迁移错误修复补充

用户确认测试库执行原文件时遇到 `P0001: Unexpected installed delivery provider branch`，并提供legacy ELSE分支截图。隔离环境在同一已安装函数下将原输入SQL转换为CRLF，可精确重现同错误及inline_code_block line9；LF输入通过。原因是旧脚本只统一了pg_get_functiondef的换行，没有统一多行dollar-quoted模板。

新增完整前向入口 `packages/shared/migrations/20261110_surplusintelligence_chat_history_compat.sql`，统一目标、全部anchor及replacement为LF，并要求唯一匹配。原迁移内容保持不变，不改历史checksum，不移除版本保护，不替换其他交付/计费逻辑。新文件可直接用于原迁移整份失败回滚后的环境，不需先成功执行原文件。

修复后已在隔离PGlite PostgreSQL18.6验证新文件重复执行、全部既有Surplus SQL场景、OID/owner/ACL保持和未知表shape事务拒绝；Shared222项测试、shared typecheck和migration lint通过。`research/delivery-line-endings-regression.mjs`实际执行四组installed LF/CRLF × submitted LF/CRLF全部通过；原CRLF故障与未知provider分支均拒绝且表/约束/函数完整回滚；原文件LF已应用并生成调用记录后，compat CRLF及重放保持记录digest与安装shape不变。原生harness已加入对应场景，脚本bash语法检查通过。Docker PG17/PostgREST仍不可用，尚未替用户重试测试库，也未操作生产。

## 实现结果与范围

已实现 **Surplus Intelligence** 官方平台适配（默认`https://api.surplusintelligence.ai/v1`）。内部provider=`surplus`兼容保留；新增migration定义`experience.surplusintelligence_chat_history`。会话正文及业务/账务终态继续由chat_history和既有charge_key链路掌握。

受控响应按body/stream/headers/request_record保存，保留厂商原名/类型/嵌套结构，包含字段覆盖、完整性、冲突和排除原因；不保存正文/思考/密钥/任意错误文本。目录、数据库允许值、交付三分支、输者记录、非流式、取消和恢复已接线。请求冻结及身份确认仍等待正确性结果，诊断写入不阻塞首字或EOF；终态诊断异步有界执行。

已按全范围trellis-check复查并修正：身份格式跨层一致、原始非法ID不能进入交付选择、非流式身份失败保留正文、缺request ID不永久pending、临时零用量可由首次终态纠正、同请求详情可更新权威投影、可选诊断不能使DONE越过期限、RPC拒绝不回显失败行敏感DETAIL。

未执行远端migration、生产配置发布、真实收费生成、部署、git add/commit/push；任务不自动归档。

## 自动检查结果

| 检查                                     | 结果                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| Backend完整非integration suite           | 133文件，1475测试通过；`--testTimeout 15000 --maxWorkers 2`   |
| 最终诊断原因归一化后focused              | capture/transport/nonstream 3文件，34测试通过                 |
| Shared完整suite                          | 18文件，222测试通过                                           |
| Admin suite                              | 11文件，109测试通过                                           |
| Admin-client suite                       | 2文件，19测试通过                                             |
| Admin-cli suite                          | 23/24通过；既有POSIX权限断言在Windows失败，见下文             |
| Workspace consumer typecheck             | 8个包全部通过；最终Backend测试mock签名补全后再次typecheck通过 |
| Frontend build                           | 通过；既有img/hooks/Browserslist/Tailwind警告不属于本次改动   |
| Admin build                              | 通过；既有large-chunk警告                                     |
| 修改的TS文件ESLint/import边界            | 通过（直接使用仓库ESLint配置）                                |
| legacy / migration filename / complexity | 通过；只收紧execute/sync/models三个触达文件的复杂度基线       |
| 本地fixture server suite                 | 11/11通过                                                     |
| 新@surplus浏览器场景                     | 4/4通过，Android390与320窄屏                                  |
| 既有@chat浏览器回归                      | 25项完成验证：20项通过＋修正终态等待竞态后剩余5项通过         |
| task/context/module knowledge/diff/格式  | 全部通过；module-updates为待人审payload，未archive apply      |

Backend最终全量命令：

```powershell
pnpm --filter @miniapp/backend exec vitest run --exclude '**/*.integration.test.ts' --testTimeout 15000 --maxWorkers 2
pnpm -r typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm lint:legacy
pnpm lint:migrations
pnpm lint:complexity
```

第一次高并发全量执行与同时运行的typecheck/build竞争CPU，两个既有30–100ms实时时钟竞争场景发生调度波动；最终限制worker后的全量全部通过，没有放宽产品超时或删除断言。浏览器冷导航使用90s CLI预算；窄屏思考面板旧断言改为等待终态按钮消失后再手动展开，保留产品行为。

## SQL证据与限制

本机缺Docker/psql，使用OS临时目录内的PGlite0.5.16／**PostgreSQL18.6 WASM**，未增加仓库依赖、未连接远端库。重放既有bootstrap/依赖migration后，新migration重复执行两次及SQL场景全部通过。

验证了：OID/owner/ACL保持、未知前置shape事务拒绝、RLS及service_role实际RPC写入、参数冻结与ID冲突、30位微美元/NULL/零值、首次终态与权威详情投影、敏感/超限JSON拒绝且不泄露失败行DETAIL、父级联、OR/Surplus胜负隔离、补齐领取去重/次数/退避。真实mapper的大型125597字节JSON与SQL jsonb::text容量计算一致（包括指数数值转换）。

可重复的正式验收入口为已扩展的`bash scripts/test-first-token-fallback-local.sh`及`packages/shared/migrations/tests/surplusintelligence_chat_history.sql`。本地WASM结果不能替代**PG17/PostgREST、多连接并发、真实钱包或真实供应商验收**；这些仍是发布前门禁。

## 已知环境差异与发布待办

- Admin-cli `safety.test.ts` 的“会话与配置文件只有本人可读写”检查POSIX mode700；Windows Node返回mode666，断言失败。该逻辑与本任务无修改；Linux/CI需复验，不为通过测试降低权限要求。
- 原生PG17/PostgREST、TEST/Production结构/账本/权限/索引/容量及真实调用尚未验证，不能把PGlite或fixture成功当线上事实。
- 官方只给reasoning参数名，未给统一合法effort值；当前记录能力限制，复用新鲜缓存不冷查询，不猜测开关值。公开思考显示继续由既有UI控制。
- 可选诊断在异步确认前进程退出仍可能缺数据；仅按已确认request ID有界补齐，缺失保留unknown，不重发收费POST。
- Android/iOS真实页面加载及首字P95仍无可见样本，保持null；工程目标不代表已达成。

发布与恢复的逐环境步骤见release-checklist.md。生产模型发布仍需把具体CLI diff交给用户明确确认。

## 最终内容审阅

建议提交单元：`feat: support Surplus Intelligence call history and recovery`。本轮不执行暂存或提交；提交前需工程师审阅最终路径、diff、验证结果和module-updates payload。文件清单与摘要由review-files.json记录（其自身与本报告为审阅辅助，不构成自动提交授权）。
