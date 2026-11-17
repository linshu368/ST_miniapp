# 上线交接

本批封面按用户确认写入 main 项目私有 media-plaza-video。通过 Storage API 新建同名桶，参数对齐 TEST 原桶，且生产对象回读字节一致。生产迁移 20261027_media_plaza_video.sql 以 ON CONFLICT 同步同名桶参数。应用所需视频表和旧导入 RPC 在 main 只读预检时尚缺失。本批仅改动远程 Storage 资产和 Cloudflare Stream 视频。

本地交接目录 G:/JobWork/ST/video-plaza-seed/main-stream-20261117/sql。00 为 main 结构只读检查，01 为 5,082 条表格原始输入，02 为独立核验的真实封面及已验证的稳定 Stream UID 回执。03 报告全量覆盖和缺口，04 可提取封面和签名 HLS 都已通过的子集。01、02、03、04 的暂存对象只存在同一 PostgreSQL 会话。发布代码需兼容视频产物的稳定 Stream UID 与私有封面路径，典型旧 MP4 seed RPC 不能直接使用。完整业务迁移应从最终核验输入构造，经 TEST 验证后选择正式 Database Migration 单文件流程执行。

本地 SQL 使用 PGlite 校验 5,082 条与 6 模型、实际回执的外键关联完整性、错误路径和重复回执拒绝、全量缺回执拦截及模拟完整回执通过。模拟数据只在本地引擎存在。Backend typecheck 成功，相关 3 个既有测试文件的 12 条用例通过。

验收证据包含匿名访问拒绝、样本真实签名主清单、最低带宽变体及分片和五档码率。发布新播放器时复用 packages/ui-tests 的 @image、@drama 场景，在 Android/iOS Telegram 实机补签名刷新、首帧、快进和旧 MP4 回归。
工作区的 Stream 扩展已定义 video_artifacts 的 stream_uid 和 playback_url，使用 05 实际写入模板绑定该契约。render-production-release.py 根据最终回执生成 500 条/文件的自包含事务 SQL 与 SHA256 manifest。SQL 逐文件验证私有桶、每个对应封面对象、模型映射、重复执行和已存在冲突；仅以真实成对回执发布。生产未应用视频基线与两列；不执行远程业务 DML。采用本地签名核密钥提升批量验收速率，只暂存新增密钥的 ID，退出时回收，凭据和签名链接不落交接文件。

按 21:40 后更新的目标，下载已明确返回源站 HTTP 404 的来源 ID 跳过并进入 unpaired 清单；HTTP 520、读取超时、体积或编码异常应恢复后重新核验。正常通道 32 路下载，4 路 FFmpeg，8 路 Storage；Stream 管理 API 有间隔，转码队列与分片核验独立，结果持久化在外部交接目录。副本修复优先使用本地源文件，验证替换 UID 后以实际送入 Stream 的字节数生成迁移。
