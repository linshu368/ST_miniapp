# 短剧生产 20% Bunny 对照：发布和首次比较

这是实现与操作步骤，不代表生产已发布或开流。当前交付状态见 `.trellis/tasks/10-29-drama-cdn-rollout/verification.md`。生产开流前完成以下检查；实际开始时间之前不启动 12 小时观察。

## 配置目标

仓库记录的 Railway 项目为 gallant-insight，生产 environment 为 production，API service 为 stminiapp；执行时先只读核对实际项目／环境／服务 ID、数据库 target 和发布 SHA。短剧不由支付 Cron 消费，不向其复制变量。Frontend 的 API、release 和 Backend 必须匹配。

后端集中配置如下，真实密钥仅在平台受保护配置中填写，不进入命令参数、日志或文档：

- `DRAMA_CDN_ENABLED`：唯一流量开关，默认 false。关闭时保留其余配置，确保原分组与去重身份稳定。
- `DRAMA_CDN_EXPERIMENT_ID`：本轮固定标识，字母／数字／下划线／连字符，最长 64；更换即新实验。
- `DRAMA_CDN_EXPERIMENT_KEY`：独立随机服务端密钥，至少 32 字符，各 API 实例相同；实验期间不能轮换。与 CDN 签名密钥分离。
- `DRAMA_CDN_BASE_URL`：专用生产 Bunny `https://<zone>.b-cdn.net` origin，无目录、端口、凭证或查询参数。生产拒绝已知 TEST Preview 主机，不能直接搬 TEST 配置。
- `DRAMA_CDN_TOKEN_KEY`：专用生产 Zone 的原生签名密钥，至少 32 字符。

生产还要求 Railway 环境名 production、target=production、源为已配置的 production Supabase origin，且鉴权旁路关闭。TEST 仅 pr-525／target=test，目录 `/preview-test/`；生产目录 `/production/`。未配置实验的既有 TEST Preview 保留历史全量 Bunny 行为；生产必须完整显式配置实验。

## 生产回源预检与发布顺序

1. 更新已合 dev 的 PR #525 之后的生产适配实现，重新审核最终代码与提交范围，完成独立 PR → dev 验证。复核 dev → main 的实际内容差异，不能只按提交列表判断是否夹带已由其他路径发布的功能。
2. main 合并前完成可独立执行的生产回源预检。在专用生产 Zone 启用原生 token 验证，默认拒绝非 `/production/*` 路径；源固定为 production 私有 `drama-videos`，不配置项目／service-role 密钥，不关闭缓存命中后的权限校验。Bunny 流量开关保持 false。
3. 当前对象为 `videos/<video_id>/original`，目录段模板为 `/storage/v1/object/sign/drama-videos/%{Path.1-2}/%{Url.Filename}?token=%{Query.origin_token}`。对象路径层级变化须重新核验，不使用会夹带旧 query 的 `Path.1-`；CDN HMAC 绑定完整对象、到期时间及原始 origin_token。
4. 在获准的独立预检环境／受控客户端完成生产对象的源/CDN起始和中段 Range 206、Content-Range 及小段字节比对；覆盖未签名、篡改、过期、对象替换和已热缓存负例。每请求有限超时和字节上限，非预期响应立即停，不整文件／全库下载；不开放用户可控制的 provider 参数。
5. 前置检查通过后审核 main 合并及部署操作。main 更新会触发生产自动部署，不能把合并与代码发布视作两个互不相关的动作。兼容 Backend 先就绪、Frontend 后验证；Bunny 开关保持 false，核对实际前后端 SHA 与路由兼容。
6. 开流前锁定 Frontend `NEXT_PUBLIC_DRAMA_TIMING_MODE=legacy` 并核对实际部署的全量 POST，包括 start 和成功终态。保留现有 Faro 投影、阶段唯一来源和停止分析库写入的行为；实验期间冻结其他播放优化。新代码在 unified 模式也全量上传有 delivery 的结果及 seek，但这不能替代完整 start 分母核验。仅慢日志／5%快速成功日志不能作为对照总体。
7. 验证真实 Telegram iOS、Android 的起播、未缓冲快进和关闭重取址。仅本地构建／206／测试通过均不能替代真机；新版本生产联调在关闭开关下完成，受控 Bunny 媒体链路另验，不将其计作正式实验样本。
8. 完成功能门禁并确认实际切流操作后，设置生产开关 true 并核对所有 API 实例。记录实际开始时间、实验标识、前后端 release、配置摘要（不含密钥）及操作者；此时开始 12 小时窗口。

分组由已鉴权 Telegram 身份经有域隔离的 HMAC 稳定分配，约 20% Bunny／80% Supabase；不保证小样本恰好 20%。日志去重码仅实验专用且由服务器追加，不发送给浏览器。原始用户 ID 不记录。

## 关闭与失败保留

连续不可播或明显更长等待时可立即人工关闭，不等 12 小时。关闭 `DRAMA_CDN_ENABLED`，保留实验标识／HMAC key，部署并核对全部 API 实例；以全部实例生效为关闭生效点，不声称修改变量即即时生效。

新播放和用户重试都会请求当前 `/play`，前端不再消费预取的旧签名地址；两组采用相同策略，后端仍复用对象级签名缓存。当前已播媒体不强制中断，后续取址应为 Supabase。核对原 group=bunny、provider=supabase、reason=disabled，恢复位置和暂停状态；取址失败不能退回旧 Bunny 地址。若实验配置本身损坏，关闭仍恢复 Supabase，无法还原的分组／去重信息保持未知。确认新流量恢复后才考虑生产 Zone 阻断，避免伤及尚在使用旧有效地址的播放。

原观察终态不可覆盖。失败起播后的重试有独立观察和 parent/root 关联，累计时间保留重试间隔；两者可分别查看。已成功起播或已退出／后台的访问不会把已观看／后台时间算作新启动等待。5 秒快照不终止视频，不改变原 API／签名超时。关闭或重新尝试不能把原失败改成 Bunny 成功。

## 日志口径与 12 小时比较

现有 `drama.frontend_timing` 复用 POST/Pino，接收接口继续不写分析库。比较以完整、明确导出的 Pino 窗口为准；现有 Loki startup_diagnostic 只含慢启动明细且没有实验人数上下文，不能替代全量窗口。服务器附 environment、server_release、experiment_id、assigned_group、experiment_user；客户端报告 delivery、context、recovery 和可选 seek。未知路径保持 unknown，不能补成 Supabase。

同一 observation_id 的 start／slow／final／network 只算一次。起播 elapsed_ms 从播放触发到真实首帧，自动首页 entry_elapsed_ms 覆盖文档导航至首帧；recovery.cumulativeMs 从原尝试起算，包含重试间隔。`over_five_seconds` 用原始精度判断，比较器同时检查三个时间字段；恰好 5000ms 不属于超过，失败／早退仍不能算达标。

seek 从提交前计到目标帧，`seek.buffered=no` 是未缓冲核心样本；yes／unknown 分开。seeked 只是一段，不是成功。优先 rVFC；降级以实际播放推进观测并标方式。暂停 seek 无首帧验证能力时 outcome=unverified。首播后的错误不会改写已经完成的启动结果。

开流后 12 小时，导出明确 production 半开窗口 `[from,to)` 内的完整日志；检查分页、条数上限、首尾时间及丢报，不用工具“最近若干条”冒充全窗口。原始导出仅存本机安全临时路径，不提交 Git。

仓库根目录运行只读比较（占位参数按本轮实际值替换；文件里不能包含其他业务敏感数据）：

```bash
pnpm --filter @miniapp/backend exec tsx src/scripts/compare-drama-cdn.ts \
  --file /private/tmp/drama-window.ndjson --environment production \
  --experiment <experiment-id> --from <start-ISO> --to <end-ISO> \
  --release <frontend-release> --server-release <backend-release>
```

单次最多 24 小时、64MiB、5 万行，超过先拆窗口；跨窗口人数不可直接相加。输出按平台／观察类型／原分组／实际路径的尝试数、去重用户、超标次数及比例、受影响人数及比例、成功／失败／退出／帧未验证及 outcome 计数、缺 start/final、冲突／未知；`overLimit` 包含每条真实时间和分段。`seek_no` 才是未缓冲快进，回退的 Supabase 不算 Bunny 成功。

输出始终是描述性样本，不自动判断有效。缺报、离线、未知身份、截断、未验证帧不能算成功；missing final 的耗时只是已观测下界。冲突终态隔离到 unknown，不挑最快成功。多版本需要复核，缓存冷／热不可观测时写未知，不删冷缓存样本。

判断顺序：先排查失败或等待是否变差，再逐条看长尾是否减少，最后才考虑扩大比例。样本不足继续观察；即使相对更快，所有超 5 秒记录仍为下一轮待解决项。
