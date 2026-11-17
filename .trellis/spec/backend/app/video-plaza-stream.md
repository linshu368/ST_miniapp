# 广场Stream交付契约（本地候选，待TEST迁移/部署）

## 1. Scope / Trigger

生成视频交付、工作室/作品播放、下载和TEST13条迁移。短剧复用签名与底层装载，保留其原实验、手势和续看语义。运行手册见`docs/video-plaza-stream.md`。

## 2. Signatures

shared `VideoPlazaPlaybackSchema`；按artifact的GET playback/download与POST playback-observations。数据库enqueue/claim/publish/fail交付RPC，发布由UUID lease_token fencing，不沿用模型任务租约。

## 3. Contracts

Supabase只保存稳定UID/链接、封面和业务事实，短期JWT仅在响应中。播放复用DRAMA_STREAM三项，管理读取CLOUDFLARE_ACCOUNT_ID/API_TOKEN（现有VIDEO_STREAM_API_TOKEN别名），统一runtime-config。播放不依赖管理Token。

TUS创建先持久化creating，201必须保存stream-media-id与能力URL，再做HEAD/PATCH。允许供应商的upload.cloudflarestream.com和upload.videodelivery.net；无重定向、不向上传主机转发管理Token。每轮一块、独立五分钟租约；同attempt唯一job，源hash变化隔离。readyToStream不能替代完整转码和多档清单/真实分片检查。

## 4. Validation & Error Matrix

缺配置在预扣前拒绝；创建结果未知隔离，不重投模型、不盲重建；429有限退避并尊重Retry-After。publish结果未知先回读/新租约重进，不误删退款。确定失败与退款同事务，已退款/过期/旧token不能发布。私有越权/已删分享均404；attempt-less公开种子可播。观测strict、body/速率有界，客户端身份/URL一律拒绝。

## 5. Good / Base / Bad Cases

Good：断块用同一能力HEAD恢复，上传完成但转码中持续等待。Base：冷缓存立即返回签名HLS，不在取址关键路径调用管理API。Bad：创建超时盲重POST、将source MIME=MP4当作HLS播放格式、用attempt刷新种子，或在未知发布后删资产/退费。

## 6. Tests Required

shared strict消费、真实Pino安全投影、TUS响应丢失/偏移/hash/域名、多档不足/隐私拒绝；route覆盖本人/越权/种子/删除/下载处理中。SQL真实引擎验证扩展/收缩、CAS/租约更新/退款一次/迟到发布/ACL；多连接并发和真实模型仍需TEST验证。Android/iOS首帧、seek、stall不能填零或以模拟代替线上样本。

## 7. Wrong vs Correct

Wrong：只看调用点日志字段就宣称接入成功，或把business_module=video写入会被过滤的白名单。Correct：业务模块image，事件operation=video.delivery.\*，逐实体作用域及真实Pino JSON验证关联、脱敏、终态。失败诊断用固定error_code，不能只留下被脱敏的任意Error.message。
