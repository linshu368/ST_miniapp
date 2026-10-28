# pr-525 普通短剧 Bunny Preview

本目录保留旧单样本手机实验的脱敏证据；evidence.json 与 experiment-closed.png 的既有未提交内容不是本次修改，不覆盖。历史手机结果不代表本次全量链路已验收，也不保证提速。

## 当前状态

本分支代码已接入普通播放路径，独立实验页面/API/名单/手工源URL与实验截止配置已删除。本次云配置尚未发布；控制台动态回源表单仅准备，未保存或解除阻断。

## 代码边界

所有正常入口仍使用 GET /api/dramas/:id/play；前端无需路由选择或指定样本。先通过 requireTelegramAuth 和本剧video归属/可播判定，再复用缓存申请TEST对象签名。
Backend getDramaPlaybackCdnConfig 仅允许 pr-525 + TEST；其他环境保持Supabase。启用但key/源站/真实鉴权配置错误时返回不可播，不自动静默直连。源桶仍私有。
Bunny URL 使用 /preview-test/<object_path>，包含对象级短期 origin_token 和原生CDN token/expiry。HMAC覆盖路径、expiry与原始origin_token；不绑定IP。CDN到期不晚于源exp减60秒，最多约1小时；完整URL缓存最多30分钟并留余量。
不把Supabase service-role、Bot token或账号管理key交给Bunny；不新建代理/刷新服务、存储复制、转码或DB对象。

## 待执行的准确云操作

1. Railway gallant-insight / pr-525 / stminiapp：设置 DRAMA*CDN_ENABLED=true，并将该服务已有专用Zone签名key安全迁至 DRAMA_CDN_TOKEN_KEY。移除该服务的五个 DRAMA_CDN_EXPERIMENT*\* 废弃变量；秘密不放命令参数/输出，值只经受保护本机输入或stdin。其他服务和环境不写。
2. Bunny Zone 6882359：新增规则 Preview TEST drama origin，Request URL 匹配 https://stminiappvid20261028.b-cdn.net/preview-test/*；Origin Override 固定为：
   https://zoqelpfhurwehlvypryl.supabase.co/storage/v1/object/sign/drama-videos/%{Path.1-}?token=%{Query.origin_token}
   实况先验证原查询的转发行为不会覆盖源token；不接收用户控制host。
3. 保持原生token验证开启，不忽略签名校验中的查询参数；保持query维度缓存、20分钟edge缓存、large-object Range优化、既有流量限额。额度不足则报告，不自动扩额/购买。
4. 将原 Experiment closed 的全路径阻断收窄为“Request URL 不匹配上述 /preview-test/_ 时阻断”，旧 /experiment/_ 继续403；默认deny origin不开放其他路径。该步改变外部访问范围，须用户在执行时确认。
5. 经最终内容审核/commit/push发布现有PR，核对Railway部署SHA、Frontend实际bundle API必须为 https://stminiapp-pr-525.up.railway.app。不能只看部署SUCCESS。
6. 使用正常有效TEST Telegram账号从普通页面选不同剧/集，确认返回Bunny主机，真实起播与中间Range206、Content-Range和少量字节匹配。过期/缺失/篡改CDN token及源token/对象替换负例，包含热缓存，均应拒绝。每个探针有明确超时和读取上限；非206立即停止，不下载完整视频。
7. 旧实验页404；复核首页/剧场、跨剧、换集、快进、位置恢复、重试。记录真实Telegram手机结果，不能以桌面或虚构UI验收代替。

原生动态回源如果不成立，停止并报告，不擅自加Worker、媒体代理或给CDN宽权限key。API取址成功不代表媒体可播；HTTP206也不代替首帧与持续播放。

## 本地验证

复用 pnpm --filter @miniapp/shared test、相关Backend tests、pnpm --filter @miniapp/frontend test、pnpm -r typecheck、pnpm -r --if-present build、frontend lint/import guard及 pnpm test:ui --grep @drama。
具体结果和最终提交范围见本次Trellis任务 verification.md/review.md。旧影像广场media-cache的5条失败若仍复现，单独记录，不当作本次播放变更失败或私自修补。

## 恢复

先关闭 pr-525 的 DRAMA_CDN_ENABLED 并部署，核对普通API恢复Supabase及位置恢复，再恢复Bunny全路径阻断。失效旧Bunny URL不伪造续期；重新取址。不动production、TEST数据、他人dirty证据，不修改历史migration。

## 依据

[原生签名算法](https://github.com/BunnyWay/BunnyCDN.TokenAuthentication/blob/master/nodejs/token.js)、[动态Origin变量](https://bunny.net/docs/cdn/edge-rules/variable-expansion)、[私有源短期URL](https://supabase.com/docs/guides/storage/serving/downloads)。
