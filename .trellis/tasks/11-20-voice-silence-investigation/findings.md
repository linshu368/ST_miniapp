# 2026-11-20 语音无声反馈排查

调查日期：2026-11-20；以下时间均为 Asia/Shanghai。对象为用户在对话中指定的 TGID，仓库不保存该标识。

## 结论

目前无法将反馈定性为“语音生成成功后播放无声”。反馈窗口只找到语音读取请求，未找到该用户的语音生成 POST，未取得对应 audioId、音频 URL 或播放错误。已确认线上播放器存在错误提示及遥测缺口，但尚不能证明它触发了本次反馈。

## 事实

- Railway：gallant-insight / production / stminiapp。当时部署为 3bc9ed9a-71e6-4909-861c-6cde2e3db719，commit f5e20f97a11f432332fb05b4512e36be79ab81c8；北京时间 01:12 创建部署。Sentry 客户端 release 与其一致。日志工具服务级响应中的 deploymentId 是当前最新部署，不可用它判断历史日志版本。
- Sentry：st-miniapp、production、Android 16、Telegram 12.3.1、tg_platform=android。
- 用户 HTTP 查询窗口为 11-19 23:00–11-20 02:10（UTC 15:00–18:10），按用户和 @operation:http.request 过滤得到 224 条，实际命中 01:38–01:57；语音专项窗口 23:00–02:00 按用户和 @business_module:voice 过滤得到 167 条。两者均未达到 500 条限制。
- 语音 HTTP 均为 GET；未找到该用户的生成 POST。两段会话语音读取返回 200，服务端处理约 40–60ms。01:52 的一次语音列表 GET 为客户端 3563ms、服务端约 48ms，同一 requestId 为 42c6c624-067e-414c-9375-295d80abdd00。客户端耗时不能当成服务器处理耗时。
- Sentry breadcrumb 中两段会话的语音读取 response_body_size=36，状态 200。没有读取响应正文或业务数据库行。
- Sentry 的 api.request_failed 涉及分组、收藏、会话和社交信息；未发现语音失败日志。01:54:51 的 page_stall 在 /wishes，不能直接解释语音无声。
- 按用户查近 24h Replay 返回空。issue 详情的 related replay 属于问题组，不能当成该用户回放。
- 当时线上 commit 的 chat-message-voice.tsx：play().catch 只重置 playing=false；audio 没有 onError，没有播放错误提示或专用播放失败遥测。工作区保留同样行为。

## 推断与证据边界

- 当时路由的空列表成功响应序列化为 {"success":true,"data":{"audio":[]}}，长度为 36，与 breadcrumb 一致，支持“这些会话当时没有语音记录”的推断；字节数不能替代响应正文或数据库实况。
- 未发现 POST 不能证明用户没有点击，仍可能是请求未发出、入口误认、不同账号/时间/入口或遥测缺失。
- 没有关联的音频可供验证；未验证文件编码、静音、可达性和真机播放。没有证据指向 MiniMax 异常或全量用户受影响。
- 静默处理播放失败能解释为何产品可能不提示，但没有证据证明该用户确实进入播放器并发生 play rejection 或媒体 error。

## 下一步

先确定用户实际操作的页面与那条消息，最好取得含语音条/时长的截图或短录屏，确认聊天语音、短剧声音或其他入口，再关联 messageId/audioId。设备信息已从 Sentry 取得。

若后续修复播放器，应规划播放拒绝和媒体加载/解码失败的用户提示与脱敏遥测，保持手势播放和有界恢复，避免盲目重新生成或扣费。建议扩展 packages/ui-tests 的现有聊天流程验证失败与恢复，实际声音与系统音量仍需 Android/iOS 真机验收。

## 复核

- [Sentry 用户事件检索入口](https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&project=4511818663788624&start=2026-11-19T17%3A00%3A00Z&end=2026-11-19T18%3A10%3A00Z)：添加对话中提供的 user.id 过滤。event af1f92113ea8424ca3995833a31f868e 可核对设备；event 2ca9d3095f43476db4f87b6916b25c80 可核对语音列表慢请求；event 71a9759299e34005b334b478c9480885 的 breadcrumbs 含语音列表请求。
- [Railway 生产服务](https://railway.com/project/ce38c0c0-88cd-407a-9c04-06124cd42e97/service/8bd593b7-7c40-4ab6-8808-c0863f27a22a?environmentId=f03d6c61-84e3-434d-a81a-0ae209167ef5)：上述 UTC 窗口，加 @telegram_user_id 和 @operation:http.request / @business_module:voice 过滤。
- 仅新增排查文档；无产品代码修改，未运行产品测试，未改线上配置、数据库或部署。
