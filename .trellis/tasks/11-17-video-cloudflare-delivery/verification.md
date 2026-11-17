# 当前验证证据（2026-11-17，本地候选）

## 真实TEST资产和Cloudflare

目标zoqelpfhurwehlvypryl，13条=10种子+3生成，74,247,409字节。13/13源文件已独立备份并回读SHA-256，恢复目录位于Git之外。13/13已上传Stream并验证签名清单、多档子清单与实际分片；实际每条3～5档，匿名访问拒绝。单条MP4下载副本ready，签名下载经Cloudflare重定向后Range可读。首次未开始上传的创建回执已按精确test资产标记对账补偿，无盲重投；正式13条各有独立UID。

直接使用用户指定backend/.env；复用短剧签名，现有VIDEO_STREAM_API_TOKEN具实际Stream读写能力。原私钥多行未引用导致只读首行，已转换为等价Base64 PEM，并用既有短剧UID真实签名校验。通过同一短剧customer host匹配账户后仅补本地账户ID。未生成替换密钥、未改账户webhook或短剧资产，所有网络校验启用TLS。

TEST-API结构采集（不是MCP/生产结论）：现有video_quotes 13列、video_attempts 34列、video_artifacts 15列；video_delivery_jobs尚不存在。源自确认目标的PostgREST只读OpenAPI，与原20261027迁移相关形状相符。

数据库迁移、应用部署、原Supabase MP4清理均未执行。扩展/切换/收缩SQL已准备；只有本地生成文件不等于远端生效。

## 已运行检查

- shared：24文件253测试通过。
- Frontend：75文件843测试通过；lint通过，存在既有img/短剧Hook警告。
- Backend原全量178文件1910测试在测试专用代理隔离配置下通过；之后新增的取址/权限/种子/观测4条和TUS协议6条另行通过。后续变更继续按最终检查记录更新。
- 本地.env的HTTPS代理会把generation/upstream的localhost真实网络用例错误送往代理，默认命令该1条失败；Windows首次动态导入还会触发默认5秒超时及迟到mock。测试专用临时配置只让loopback绕开代理并将测试上限设20秒，未改产品代理行为或跳过断言；同一全量1910通过。
- pnpm -r typecheck全部8个消费者通过；后续新增测试再补Backend typecheck。
- Frontend和Admin生产构建通过；Admin有既有大chunk提示。Frontend现有构建配置自动上传Sentry source maps，无应用部署。
- 隔离PostgreSQL/WASM执行真实expand/contract SQL，验证旧/过期租约拒绝、更新token、发布重放、退款一次、迟到发布拒绝、未知隔离、浏览器ACL；真实13行数据SQL的环境守卫、CAS全事务回滚和重放通过。单连接不代替多连接锁竞争。
- fixtures协议12项通过；用户随后明确“不需要本地UI验证测试”，已停止相关进程，UI验收未完成。保留HLS fixture契约适配供后续复用。

## 待完成门禁

最终受影响文件校验、人工最终内容审查后才可暂存/提交；未经明确授权不推送。需要受审阅SQL进入远端分支才能走Database Migration TEST workflow。之后执行受理/worker维护、逐文件迁移、Stream应用发布、13/13 API/权限核验和一次受控新生成，最后清理原13个MP4。真实iOS/Android和发布后P95仍无本次样本，不填0，不用Cloudflare探针替代。

## 最终收尾补充

- 最近相关Backend复跑25文件209测试通过，包含取址/越权/attempt-less种子/观测4项、TUS6项、配置复用/坏密钥预拒绝与真实Pino JSON；全量1910及其测试环境修正见上文。
- 全8包typecheck再次通过；日志、复杂度、legacy、迁移命名、DB契约门禁通过。DB-contract只报既有drive_mode修改moving表的无关警告。
- 原lint:imports在Windows将空JSON参数错误解析；等价ESLint Node API按同一.eslintrc、禁inline配置检查1170源文件，0错误0警告。
- 13条数据SQL已在独立PG引擎测试身份拒绝、末行CAS失败导致前12行整笔回滚、13行成功与重复执行稳定。
- 新封面路径实测：Cloudflare JPEG获取、Supabase私有上传、同名upsert、签名回读SHA-256一致；随机临时TEST封面已清理，原13个封面未改动。
- 只读OpenAPI与样本下载的最终报告确认下载ready且Range可读。真实13条云端映射在Git外checkpoint保全；切库和源MP4清理尚未执行。
