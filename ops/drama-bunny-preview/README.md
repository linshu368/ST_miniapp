# Telegram 手机 Bunny 单轮验收

本分支仅提供内部 Preview 实验。既有桌面实验在独立工作区 `drama-cdn-experiment` 中，未提交的本机工具不随本接入发布。桌面结果不能证明 Telegram 手机收益。

## 边界与接入

复用真实 `DramaPlayer`、React Query/API client、完整签名 URL 复用、媒体释放、首帧观察与位置恢复。仅新增固定样本的受鉴权 manifest/play 接口、单一 Bunny 签名器及有界本地记录。普通播放接口保持 Supabase；无媒体转发、生产切流、migration、存储复制、转码或监控系统。

接口在 `RAILWAY_ENVIRONMENT_NAME=pr-数字`、数据库目标 TEST、两个鉴权旁路均关闭、显式 enabled 后才可用。Telegram 验签后检查数字用户白名单；play query 使用 shared strict schema，只允许样本 `1fc8b3d5-9426-5ce6-b675-d98074da4801` 和 `original|bunny`。manifest 只描述同一个 46,518,538 字节样本，不访问 TEST/production 业务行。

Preview 环境只接收该单对象的临时 Supabase 下载签名及独立 Bunny token key，不接收生产数据库/service-role 凭证。来源固定为生产项目 `wbtsfzozlmurljvglhpn` 的私有 `drama-videos/videos/<样本 ID>/original`。源凭证由操作者在已有生产授权下手工签发一次；不建设刷新服务。

配置统一经 Backend `platform/runtime-config.ts`，变量见 `.env.example` 的 `DRAMA_CDN_EXPERIMENT_*`。源签名只存 Railway PR 服务及 Bunny 精确回源规则；真实值不进入 Git、日志、结果或前端配置。Bunny 用户 URL 最长 30 分钟，早于源签名至少 60 秒，并不晚于实验截止；缓存复用完整 URL、不绑定 IP、不忽略 token。原路径请求返回同一完整源签名；截止后 B 返回 410，A 在源签名余量有效时仍可重新取得，源失效时提示从原鉴权入口重新获取。

Zone `6882359`、Standard、`stminiappvid20261028.b-cdn.net/experiment/v1.mp4` 固定同一对象。原生 token、Range 大对象优化、20 分钟缓存及 1 GB 月流量上限保持。只更新该对象回源签名，不换对象；若将来换对象，必须换版本路径，不能复用 v1 缓存。本轮不换对象。先更新有效回源并检查限制，再停用 `Experiment closed` 全路径 Block Request。收尾重新启用该规则，并实测仍有效 token 也被 403 拒绝。

## 发布与功能验收

分支从最新 `origin/dev` 隔离创建，PR base 为 dev。通过既有 Railway PR workflow 与 Vercel GitHub 集成部署。核对实际部署 commit，Frontend bundle 的 API 目标必须是对应 `stminiapp-pr-<号>`，不能用 stable dev 或旧 Preview 替代。PR 服务设置 `DEV_AUTH_BYPASS=0`、`MOCK_AUTH=0`，`FRONTEND_URL` 为实际 Preview origin；沿用 TEST Supabase 与测试 Bot。仅为参加账号设置测试 Bot 的 chat menu，不修改生产 Bot 入口。

本地回归覆盖未鉴权/非内部/非样本/未知 query/截止、源失效、完整 URL 复用与 token 公式；seek 覆盖目标未缓冲、首目标帧后继续推进、超时、不可读缓冲和中断。执行相关既有 tests、shared tests、`pnpm -r typecheck`、`pnpm -r --if-present build`、Frontend lint、import guard、`@drama` 既有页面验收。自动化与桌面功能检查均不作为手机性能样本。

此实验增加跨接口状态和失败恢复，后续若保留该入口，建议扩展现有 `packages/ui-tests` 的 dramas 场景，覆盖 A/B 切换、取址 403/410、源失败后位置回退；本轮以新增必要逻辑回归、既有播放器验收及实际 Preview/手机为准，不另起 mock 系统。

## 唯一正式手机轮次

推荐自动模式：手机打开入口，勾选同手机／网络／代理不变，点击一次「自动跑完三组」。全部正式尝试统一静音，页面依序 AB/BA/AB，在首帧/playing 后自动检查 72% 目标并测 seek；每次结束后间隔 400ms（不计入下次起播）再开始下一次。无论成功、超时、地址失败或目标已缓冲，都保留该次并推进，不补测。完成六次后自动关闭本机实验、回原路径保留位置，再提交报告。手机需保持前台；后台立即停止，保留中断，不自动重跑。手动流程仍可用。

结果通过现有鉴权 `POST /api/telemetry/drama-timing` 发送 `type=cdn_experiment` 的 strict 白名单结构，复用已有 32KiB、每用户/全局限流和 Pino。服务端再次检查 PR/TEST/真实鉴权/内部名单、固定样本和最多 18 条记录；只记 `drama.cdn_experiment_evidence`，不进入分析表或新队列。提交发生在测量和回退完成之后；5 秒有限等待、无自动重试。失败保留本机数据，可仅重发结果，不重跑。202 仅表示服务端接收，操作者还需在 Railway 实际读回该 round ID 的日志确认保留。普通播放观测不承载这份逐次报告，源地址/签名不进入报告。

自动模式的起播起点是每次开始取址的单调时刻（首次由按钮触发，后续由页面触发），包含取址和播放器调度；不包含先前页面导航或组间 400ms。分别保留首帧、playing+首帧就绪和 src→首帧；不把失败耗时作为成功起播，不与桌面口径混算。

1. 使用本次交付的测试 Telegram 入口，以获准内部账号在真实手机打开 Preview `/drama-cdn-experiment`。可先用标明“接入检查”的 A/B 确认能播放；它们只算功能记录。
2. 手机、网络和代理状态全程保持一致。勾选确认后开始正式轮次，依序 A/B、B/A、A/B 共六次；每次从头播放，URL 在该次起播/seek 中保持不变。失败保留，不补测替换。
3. 首帧到达后立即按“测 72% 未缓冲 seek”。程序先快照至多 16 个 buffered 区间，目标已缓冲或不可读则记 buffered/unknown_buffer，不另挑目标或补测。首目标帧和后续帧推进分别计时，播放恢复需未暂停、未 seeking。15 秒超时，无自动重试。
4. 手动模式起播为按按钮到首帧（包含取址 API 与播放器调度，不含此前页面导航）；同时记录现有 `source_set→first_frame`，明确 frame method。与桌面 src→首帧分开分析。seek 记录设置目标到目标帧及恢复推进的耗时。
5. 缓存状态仅来自真实媒体响应；WebView 不能读到时填 UNKNOWN。没有额外探针、TTFB 起播、未完成请求吞吐或小样本 P95。若手机后台/离页，保留中断与缺测。
6. 结果保存在本机有界 localStorage，最多 18 条（正式六次及功能/回退），刷新不能清空正式轮次。展开“结果 / 复制”，复制脱敏 JSON 回交；内容只含标识、时刻、状态、有限数值和 UNKNOWN，不含 URL token、JWT、Cookie、initData、密钥或原始 HAR。
7. 需要回退时按“关闭实验并回原路径”，停止本机后续正式/Bunny 尝试，重新请求 A，复用原播放器 checkpoint 尽量恢复位置。保留回退前/恢复位置。源签名失效须从原鉴权入口重新获取，不把 TEST 数据当生产样本。

## 停止与证据

收到手机结果后，只分析这一轮逐对差异、各路径带成功样本数的起播/seek 中位数、失败/超时/缺测/回退。不稳定收益则停止，不继续优化或更换 CDN。无手机数据时结论必须为待验收。

收尾开启 Bunny `Experiment closed`，关闭 PR 实验签发并验证阻断，清理临时本地秘密。保留代码、脱敏证据和普通原路径；不合并 dev/main、不发布生产、不实施托管点播。实际 URL、版本、配置核对与结果写入同目录 `evidence.json`。
