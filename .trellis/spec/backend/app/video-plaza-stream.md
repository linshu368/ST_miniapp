# 广场Stream交付契约（本地候选，待TEST迁移/部署）

2026-11-17 TEST 回读：预览缺配置已补齐、12个已发布作品链路通过；钱包类型修复已生效但仓库账本缺记录，新任务在 Venice queue 因402失败。生产未在本任务操作。

## 1. Scope / Trigger

生成视频交付、工作室/作品播放、下载和TEST13条迁移。短剧复用签名与底层装载，保留其原实验、手势和续看语义。运行手册见`docs/video-plaza-stream.md`。

TEST 发布核对同时覆盖每个 Railway 预览环境的签名/管理配置及现行钱包预扣 helper；只核验资产上传或列表封面不足以验收生成与详情。

## 2. Signatures

shared `VideoPlazaPlaybackSchema`；按artifact的GET playback/download与POST playback-observations。数据库enqueue/claim/publish/fail交付RPC，发布由UUID lease_token fencing，不沿用模型任务租约。

## 3. Contracts

Supabase只保存稳定UID/链接、封面和业务事实，短期JWT仅在响应中。播放复用DRAMA_STREAM三项，管理读取CLOUDFLARE_ACCOUNT_ID/API_TOKEN（现有VIDEO_STREAM_API_TOKEN别名），统一runtime-config。播放不依赖管理Token。

部署不会复制本地 `.env`；Railway 预览必须单独具备三项签名与两项管理配置。钱包调用 `reserve_media_plaza_video(uuid,uuid) → apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)`，类型 `media_plaza_video_reserve` 必须同时被 helper 和 ledger CHECK 接受。更新全局钱包函数必须保留所有调用方类型，视频修复不能覆盖新版分账主体。

TUS创建先持久化creating，201必须保存stream-media-id与能力URL，再做HEAD/PATCH。允许供应商的upload.cloudflarestream.com和upload.videodelivery.net；无重定向、不向上传主机转发管理Token。每轮一块、独立五分钟租约；同attempt唯一job，源hash变化隔离。readyToStream不能替代完整转码和多档清单/真实分片检查。

## 4. Validation & Error Matrix

缺配置在预扣前拒绝；创建结果未知隔离，不重投模型、不盲重建；429有限退避并尊重Retry-After。publish结果未知先回读/新租约重进，不误删退款。确定失败与退款同事务，已退款/过期/旧token不能发布。私有越权/已删分享均404；attempt-less公开种子可播。观测strict、body/速率有界，客户端身份/URL一律拒绝。

缺签名会使详情取址503，即使feed有封面。预扣 cause=P0001、源码 reserve 边界失败时先核对钱包守卫，不能据此判断模型/Cloudflare失败。新 wallet entry guard 迁移只接受唯一已知旧/新守卫；未知、重复或安全属性异常整事务拒绝，不清空余额、不自动重试生成。

## 5. Good / Base / Bad Cases

Good：断块用同一能力HEAD恢复，上传完成但转码中持续等待。Base：冷缓存立即返回签名HLS，不在取址关键路径调用管理API。Bad：创建超时盲重POST、将source MIME=MP4当作HLS播放格式、用attempt刷新种子，或在未知发布后删资产/退费。

## 6. Tests Required

shared strict消费、真实Pino安全投影、TUS响应丢失/偏移/hash/域名、多档不足/隐私拒绝；route覆盖本人/越权/种子/删除/下载处理中。SQL真实引擎验证扩展/收缩、CAS/租约更新/退款一次/迟到发布/ACL；多连接并发和真实模型仍需TEST验证。Android/iOS首帧、seek、stall不能填零或以模拟代替线上样本。

`scripts/test-video-wallet-reservation.mjs <PGlite路径>` 加载真实钱包和视频 reserve/refund 函数，再应用最小守卫修复，验证旧故障、一次扣/退、余额不足、聊天专项优先/图片main_only不变、幂等/ACL/未知形状拒绝。线上取址验证须涵盖详情→刷新→多档主/子清单→实际分片；客户端403须比较 User-Agent 与签名有效性，不输出JWT。

## 7. Wrong vs Correct

Wrong：只看调用点日志字段就宣称接入成功，或把business_module=video写入会被过滤的白名单。Correct：业务模块image，事件operation=video.delivery.\*，逐实体作用域及真实Pino JSON验证关联、脱敏、终态。失败诊断用固定error_code，不能只留下被脱敏的任意Error.message。

Wrong：为恢复视频类型重跑旧视频 migration 或用旧函数覆盖当前钱包。Correct：在当前函数定义上仅修复已核验的唯一守卫，保留分账与属性，单文件 TEST workflow/账本/真实消费分别核验。
