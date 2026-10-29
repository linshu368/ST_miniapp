# 最终审核说明

PR #525 只将普通播放的 Bunny TEST Preview 适配合进 dev。本次把已批准但未提交的生产20%实现迁到最新 dev `46159929`，等待最终内容审核后再提交／推送／开到dev的适配PR。生产没有部署、配置或开流。

## 最终行为

- 已鉴权用户经固定实验HMAC稳定分配20% Bunny／80% Supabase；去重码只在服务器生成，不建表。
- 生产专用源／CDN签名和缓存隔离；默认关闭，不能使用已知TEST节点。取址、签名或媒体失败保留原结果。
- 两组相同播放器和取址策略。每次新播放／重试确认当前地址，关闭后旧预取／迟到结果不能恢复Bunny。
- 起播和未缓冲seek分别保留实际等待、5秒快照、结果、平台和阶段；重试保留原失败与累计等待。只读比较按观察和实验用户去重，逐条列出超5秒，未知／冲突／退出不算成功。
- 保留上游v3阶段helper、home/detail归属、Faro质量窗口和接收接口不写分析库。seek不计startup；实验结果不受unified快速成功采样影响，正式实验还须确认legacy完整start／终态。

## 复用与取舍

复用/play、runtime-config、签名缓存、Pino、同一媒体观察器及固定@drama验收；原有试看用例明确等待真实进度>0以建立“已在追”前置，未改产品业务或测试时限。仅增加delivery helper、seek观察器、只读比较脚本三个实现文件。没有新依赖、表／迁移、代理、转码、自动熔断或实验平台。为关闭可靠，两组都放弃旧播放地址预取，保留详情预取与后端对象签名复用；取址等待由address_wait实测。

## 验证和发布门禁

验证见verification.md；线上只读证据与准确待执行操作见production-preflight.md；发布／恢复／12小时比较见ops/drama-cdn-rollout.md。账号只有旧TEST Zone，生产需独立节点、回源与热缓存鉴权、iOS／Android真机验证。没有生产实验样本，不能宣称每次5秒已达成。

## 提交范围

最终路径和每文件摘要由review-packet.json提供，它不自我包含哈希。旧工作区evidence.json、experiment-closed.png与主目录其他dirty／untracked不纳入。建议提交：`feat: add stable drama CDN rollout and real waiting diagnostics`，PR目标dev。推送、main合并／生产发布及配置切流按独立证据执行；当前未stage或commit。
