# pr-525 普通短剧全量使用 Bunny

## 目标

在 PR #525 对应 Preview 中，从正常首页/剧场进入任意 TEST 可播短剧，实际视频均由 Bunny 分发；不需要独立实验页或用户/固定视频白名单。

## 已核实背景

- 工作区 /Users/qj/.codex/worktrees/drama-bunny-preview/ST_miniAPP，分支 codex/drama-bunny-preview；远端 PR base dev。
- 本轮开始时部署 e7225b2891e27c9752ddabe17b93c484dd3dc336，Railway gallant-insight / pr-525 / stminiapp。
- 普通播放 routes/drama.ts 仍调用 DramaSignedUrlCache；实验路由仅映射单生产样本。
- 既有 Bunny 专用 Zone 6882359 / stminiappvid20261028.b-cdn.net，历史记录显示收尾全路径阻断；上线前必须实况复核。
- 既有手机实验未证明提速；本轮验收功能可用性，不承诺性能改善。
- 既有未提交 ops/drama-bunny-preview/evidence.json 和 experiment-closed.png 是他人证据，保留，不混入本次提交。

## 需求

R1 普通播放接口在明确 pr-525 + TEST + 配置有效时返回 Bunny URL，覆盖首集、指定集、跨剧、预取和重试。
R2 移除独立实验页面、固定样本 manifest/play 接口及仅供实验的白名单/截止配置；清理独占客户端状态、shared 实验契约和上报分支，不修改普通遥测。
R3 保留 requireTelegramAuth、剧与集归属、可播判定、私有桶与有时限 URL。取消的是实验白名单，不允许任意用户传入 origin/URL。
R4 仅在本 Preview 生效。development/production 继续原 Supabase；不接入生产目录或生产 service-role。
R5 Bunny 通过对象级短期源签名回源；不把数据库/service-role/账号管理密钥交给 CDN 或前端。
R6 暂无自动静默回退，避免表面成功实际上走 Supabase；失败复用现有错误/重试，运维可关闭本 Preview CDN 配置回退。
R7 不迁移/复制/转码文件、不新增 DB 对象、队列、共享缓存或媒体中转服务。

## 验收

- 正常入口不同剧/不同集的 play_url 主机均为 Bunny；实际媒体起播与中间 Range 206、对象字节正确。
- 不需要内部账号名单；有效普通 TEST Telegram 账号可取址。无鉴权 401；不属于该剧/不可播/不存在对象维持原行为。
- 篡改对象路径、源 token 或 CDN token、过期/缺 token 均不能获得其他对象，热缓存也拒绝无效 CDN token。
- 旧实验 URL 不再开放实验功能；原普通播放器的切集、快进、续看、重试通过既有页面验收。
- typecheck、相关既有测试、shared tests、build、lint/静态检查通过或明确已有失败；部署后核对 SHA、Frontend 实际 API 目标与媒体请求。
- 真实 Telegram 手机起播/切集/快进仍需用户在 Preview 验收，模拟与 Range 探针不代替。
