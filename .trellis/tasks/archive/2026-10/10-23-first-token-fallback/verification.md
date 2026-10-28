# 本地实现与验证记录

日期：2026-10-23。分支：`feat/first-token-fallback`，基于 `origin/dev`。没有 commit、push、PR、远端迁移、应用部署或线上 Grafana 修改。

## 已实现

型号默认 4000ms、全局首 token 默认 6000ms、目标 0.01。Admin 新增/编辑沿用既有目录草稿、发布、恢复机制。自研 send/regenerate 使用同一个生成/计费出口；触发一次固定 OpenRouter `deepseek/deepseek-v4.1-flash`，切换后不回首发。晚到首发只记录其真实首 token 并停止，最多到原 110 秒生命周期保护边界。

请求与尝试分表、原报价/权益冻结、一次 charge/quota/settlement、实际交付 provider 的原子绑定、用户实际可见正文 DOM 计时、后台/缺报/删失区分、供应商对照、24h 人工报告及离线 Grafana 文件已接通。没有 AI、Prompt、自动调参、损失函数或每日调参任务。

## 自动验证结果

| 验证                                           | 结果                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Shared tests                                   | 16 files / 170 tests 通过                                         |
| Backend tests（排除 opt-in integration）       | 96 files / 788 tests 通过                                         |
| Frontend tests                                 | 48 files / 330 tests 通过                                         |
| Admin tests                                    | 13 files / 113 tests 通过                                         |
| 跨 5 包 typecheck                              | 通过                                                              |
| Frontend lint/build                            | 通过；已有图片 `<img>` 与 Browserslist 数据更新提示，不在本次范围 |
| Admin build                                    | 通过；现有大 chunk 提示，不影响构建                               |
| migration filename lint / diff whitespace      | 通过                                                              |
| 追加报价版本字段后 settle/sync 定向回归        | 35 tests 通过                                                     |
| 最新调用身份观测改动的 helper/execute 定向回归 | 38 tests 通过                                                     |

两种首发平台（OR、Venice）分别验证付费和免费轮：DeepSeek 请求体重新构造，不继承 Claude cache_control 或 Venice 参数；固定原报价，只有一个 charge identity/预留/结算，迟到首发不输出第二份内容。

`bash scripts/test-first-token-fallback-local.sh` 已通过，运行一次性 PG17、[固定版本 PostgREST v12.2.12](https://github.com/PostgREST/postgrest/releases/tag/v12.2.12) 和实际 Supabase 客户端；没有读取应用 env 或调用真实模型。

- 实际新迁移及重复运行，既有 validator OID/新校验兼容，准备失败也有事实行；阈值窗界、149/150、同型号多参数分组、两 attempt 不重复计数、NULL/删失/首次回报不被覆盖。
- 交付 CAS、切兜底后禁止首发重获交付、取消关闭、报价非路由字段不变，只有一个交付 provider 明细。
- RLS 与 ACL：service role 经真实 HTTP/RPC 正常写入；metrics role 可读派生指标，但不能读用户正文或调用写入函数；匿名角色被拒绝。
- **4 个真实 PostgREST 集成测试通过**：可选快照的开始/绑定、跨 provider 交付与晚到观察、身份校验和报表、只读/匿名权限。Supabase gateway 的 `/rest/v1` 前缀只在测试 transport 去掉，仓库使用真实 supabase-js。
- Grafana 导出文件的全部 SQL 在替换时间宏后，以专用只读角色真实执行通过。
- 既有 T2/T3/T4/T3A/T5/T6 钱包、VIP、免费额度、并发重复扣费回归通过；既有迁移台账 checksum/重复执行/中断恢复/inspect 协议通过。日志中的两次 `daily check-in is not ready` 是既有并发拒绝用例，套件最终通过。

默认 Node 测试不会自动连接这个集成环境；集成测试只接受 `127.0.0.1` 的专用测试 URL。容器、网络、临时数据库与 wrapper 均由脚本自动清理。

## 浏览器显示验证

通过本地临时 fixture，直接使用项目实际 `ChatMessageBubble`、Markdown 和首 token 观测模块；不是 Telegram 真机或完整应用端到端验收。浏览器执行由 Playwright MCP 完成；CLI 包下载受当前网络限制，使用已连接的工具完成同一验证。

| 场景                                | 实际观测                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| 100ms 后渲染一个“字”，同次已 done   | 约 127ms 上报 observed，不等待段落或完整回复                                       |
| 50ms 收到内容但正文在滚动区外       | 300ms 时没有成功上报；滚到可见后约 311ms 上报                                      |
| 50ms 收到只有不可见注释的内容       | 6000ms 截止，timed_out，visible_ms 为 NULL                                         |
| 模拟隐藏 document，恢复时已超过上限 | timed_out、backgrounded=true；恢复不补写伪成功                                     |
| 每 16ms 持续追加文字                | 约 111ms 已记录首 token，450ms 时仍在持续出字；observer 不因新 callback 每帧被重置 |

这些数值来自人工注入延迟的本地 fixture，只验证显示观测机制，不代表模型性能。双 animation frame 只代表绘制机会，不代表物理像素确认。截图见 `research/first-token-visible.png`。

## 交付边界与上线前验证

1. 仓库 TEST ref 当前不在 Supabase MCP 可见项目里；没有使用生产替代 TEST，也没有应用新迁移或调整真实目录。
2. TEST 须按 migration ledger 流程先应用数据库，再发布 Backend，最后 Frontend/Admin，并核对真实 PostgREST schema cache、部署配置和老客户端 missing 占比。
3. 固定兜底型号在真实 OpenRouter 账号上的可用性、真实 Venice/OR 生成、Telegram WebView/网络/后台与扣费烟测尚未执行；本地 mock 不能替代这些验收。
4. Grafana 文件可导入，SQL/只读权限已本地验证；没有导入真实实例或猜测当前 datasource 登录角色。真实 Grafana 联调需明确该角色，并选择 TEST 数据源。文件使用官方 [PostgreSQL 插件](https://grafana.com/grafana/plugins/grafana-postgresql-datasource/)。
5. 若服务端已完成回复而浏览器未显示，记录客户端首 token 超时与服务端完成这两个事实；本期不因不可信客户端报告改写已完成扣费。
6. 只有被接受并创建 revision 的生成进入 per-model 表；开轮前鉴权/配置/归属失败和真正离线的点击不在其分母内。余额/VIP 拒绝单列排除，不能把这个报告冒称为全部点击的覆盖率。

正式审阅入口：`docs/first-token-fallback.md`、迁移、`docs/grafana/chat-first-token.json` 和 `module-updates.json`。模块知识 payload 已准备，未自动归档或修改未审阅的模块正文。

## 2026-10-23 追加：运营集中配置验收

- Shared 171、Admin 117、Backend 789 个既有及扩展测试通过；受影响消费者全量typecheck与Admin生产构建通过。
- 新forward migration在隔离PG17连续执行两次；真实PostgREST repository 4个测试及原钱包/额度/迁移账本套件通过。验证非默认兜底受理快照、attempt与report型号一致，原权限不扩张。
- 实际FallbackConfigEditor浏览器交互：选择其他型号、上限8秒、目标2%、型号等待3.5秒，对应受控值准确；上限3秒时提示阈值冲突；390px页面无横向溢出。截图research/fallback-config.png。此预览使用本地合成目录，未调用供应商或登录远端Admin。
- React检查：复用现有受控配置，无第二份状态、重复请求或新依赖；表格stable ID、输入aria-label，环境/权限/保存发布沿用原通路。
- 新入口：运营配置→兜底配置。与模型目录共用草稿，发布包含同份草稿的所有改动。
- 未执行远端迁移、真实模型调用、线上配置发布或部署；先TEST依次迁移，再部署新后端/Admin后可发布型号变更。
