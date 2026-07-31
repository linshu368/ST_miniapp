# Sentry 接入进度与真机验收交接

更新时间：2026-07-30  
开发分支：`dev_sentry_setup`  
实现提交：

- `2883e20 feat: add browser Sentry observability`
- `2f836a3 fix: redact Telegram credentials from URL fragments`

## 1. 当前部署

- Vercel Development：
  `https://st-miniapp-frontend-git-dev-3213527545-4308s-projects.vercel.app`
- Sentry 项目：`wangqiao/st-miniapp`
- 部署环境：`development`
- 当前真机事件 Release：`233edad8ff32`
- Vercel 构建状态：成功。
- Railway development backend：最新版本已部署。
- Node.js、Edge、Client Source Map：均已成功上传 Sentry。
- 构建日志中没有 Sentry 鉴权或 Source Map 上传错误。

## 2. 已实现能力

- 浏览器 JS 错误、未处理 Promise 和 App Router 根错误捕获。
- Error Breadcrumb、Console 上下文和 Fetch 性能 Trace。
- Session Replay 动态加载，不进入首包。
- Replay 配置为 `maskAllText: false`、`blockAllMedia: false`。
- Telegram ID 关联到 Sentry User；角色卡 UUID 记录为 `character_id`。
- 100% Trace、正常 Replay 和错误 Replay 采样。
- 以下关键业务 Span：
  - `bridge.boot`
  - `tavern.open`
  - `tavern.ensure_character`
  - `tavern.select_character`
- Bridge 异常、停摆、恢复结果和请求失败结构化日志。
- API 请求通过 `X-Request-Id` 与后端 Pino 日志关联。
- `rawInitData`、Authorization、Cookie、Token、Secret、`tgWebAppData` 等敏感字段清理。
- URL query、fragment、Error、Breadcrumb、Replay 和 Transaction/Trace 共用脱敏逻辑。
- Source Map 与 Git Commit SHA release 关联。
- 现有 iframe timing POST 保留，与 Sentry 双写。

## 3. 已完成验收

### Vercel 构建与 Source Map

- [x] Preview 构建和部署成功。
- [x] Sentry Auth Token 鉴权成功。
- [x] Node.js、Edge、Client Source Map 上传成功。

### B. 错误 + Replay

- [x] 手动抛出 `sentry-production-acceptance-test`。
- [x] Sentry Issues 收到错误事件。
- [x] 环境显示为 `development`。
- [x] Issue 中存在对应 Replay。
- [x] Replay 能正常播放并显示错误发生前的页面。
      结论：B 阶段核心验收通过。普通浏览器没有 Telegram 身份，因此显示
      `Anonymous User` / Users 为 0 属正常现象。
      控制台注入的 `<anonymous>` 错误不适合验证业务源码行列还原；Source Map 上传已确认，
      最终源码还原应在应用自身产生错误时再次验证。

### CORS 与跨部署验证

- [x] Railway development backend 已部署包含 `X-Request-Id` 白名单的版本。
- [x] 使用实际 Vercel Development Origin 执行 OPTIONS 预检，响应为 HTTP 204。
- [x] `Access-Control-Allow-Origin` 精确返回实际 Vercel Development 域名。
- [x] `Access-Control-Allow-Headers` 同时包含 `X-Init-Data` 与 `X-Request-Id`。
- [x] 普通浏览器大厅、收藏、设置、钱包、支付/订单和许愿池冒烟正常。

验证命令：

```bash
curl -i -X OPTIONS \
  https://stminiapp-development.up.railway.app/health \
  -H "Origin: https://st-miniapp-frontend-git-dev-3213527545-4308s-projects.vercel.app" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-init-data,x-request-id"
```

关键响应：

```text
HTTP/2 204
access-control-allow-origin: https://st-miniapp-frontend-git-dev-3213527545-4308s-projects.vercel.app
access-control-allow-headers: Content-Type, Authorization, X-Init-Data, X-Request-Id, ...
```

结论：此前的 `X-Request-Id` CORS 阻塞已解除。

## 4. C. 真机 Telegram 验收步骤

### 2026-07-30 真机验收记录

- 测试时间：北京时间 2026-07-30 13:01～13:05。
- Telegram User ID：`8821752131`。
- 角色 UUID：`e8f83f2b-8966-41fc-8bb3-f2eeb872fece`。
- Sentry Replay：
  [d450f34d](https://wangqiao.sentry.io/explore/replays/d450f34d521b4e88b0f27261067a9e84/)。
- 对应停摆 Log：北京时间 `13:04:10.990`，`tavern.gate_stall`。
- Log 属性：
  - `environment=development`
  - `release=233edad8ff32`
  - `user.id=8821752131`
  - `characterId=e8f83f2b-8966-41fc-8bb3-f2eeb872fece`
  - `result=stalled`

### 本轮已确认

- [x] 真机 Telegram 会话成功关联到 Sentry User。
- [x] 能按 Telegram User ID、时间和角色 UUID 定位 Log、Trace 与 Replay。
- [x] Replay 能记录父页面导航、点击和网络请求。
- [x] Console、结构化 Log 和基础网络请求信息存在。
- [x] 页面 Navigation 与 Fetch Trace 存在，包含耗时和状态码。
- [x] `environment=development`。
- [x] release 与当前部署版本关联。
- [x] URL fragment 中 `tgWebAppData` 显示为 `[Filtered]`。
- [x] Replay Current URL、Network URL 和 Trace URL 均未出现 Telegram initData 明文。

### 当前真机阻塞

点击角色卡后持续停留在开屏动画，未进入聊天。Sentry 证据链如下：

1. MiniApp 启动约 2 秒后，`POST /api/init-st-session` 返回 HTTP 500。
2. Replay Console 记录：
   `"[STIframe] st-session failed: init-st-session failed: 500"`。
3. 点击角色后，下列请求均成功：
   - 角色详情：HTTP 200。
   - `POST /api/bridge/st-character/<UUID>`：HTTP 200。
   - Tavern 页面请求：HTTP 200。
   - free-quota：HTTP 200。
4. 进入 Tavern 页面约 15 秒后产生 `tavern.gate_stall`。
5. iframe timing 诊断为 `stall_doc: iframe unavailable`。
6. 没有 `select_stall` 或 `tavern.select_character_failed`，说明 Bridge 闸门没有打开，
   角色选择流程尚未开始。
7. Sentry Issues 中按该用户查询无事件；该 500 被应用捕获并写入 Console/Replay，
   不是未处理异常。

结论：当前开屏卡死不是角色接口或 `X-Request-Id` CORS 导致；首要排查
`/api/init-st-session` 的 HTTP 500。需要查询北京时间约 `13:02:28` 的 Vercel Function
日志及 Railway `/api/bridge/st-session` 日志。

以下成功路径验收仍被该故障阻塞：

- [ ] Replay 能看到同源 SillyTavern iframe。
- [ ] Replay 能看到用户输入、模型输出和实际对话操作。
- [ ] 成功产生 `chat_ready`。
- [ ] 成功路径的 `bridge.boot`、`tavern.open`、`tavern.ensure_character`、
      `tavern.select_character` Span 完整结束并可查询。

### 操作准备

1. 确认 Telegram 测试 Mini App 指向上述 Vercel Development 部署。
2. 记录测试开始时间、Telegram 用户 ID、角色卡名称及角色卡 UUID。
3. 在真机 Telegram 中打开 Mini App，进入角色卡并完成一次对话操作。
4. 等待约 1～2 分钟，供 Replay 和 Trace 完成上传。

### Sentry 检查

- [x] 使用 `user.id:<Telegram用户ID>` 查询到对应 Log、Trace 和 Replay。
- [x] `user.id` 与实际 Telegram ID 一致。
- [ ] 在事件 Tags 中单独复核 `telegram_user_id`。
- [x] `character_id` / `characterId` 与操作的角色卡 UUID 一致。
- [x] Replay 能看到父页面的点击和页面变化。
- [ ] Replay 能看到同源 SillyTavern iframe。
- [ ] Replay 中可看到用户输入、模型输出和实际操作。
- [x] Console 和基础网络请求信息存在。
- [x] environment 为 `development`。
- [x] release 为本次部署 Git Commit SHA。

### 性能检查

- [x] Sentry Performance/Traces 中存在页面与 Fetch Trace。
- [ ] 能查询到 `bridge.boot`。
- [ ] 能查询到 `tavern.open`。
- [ ] 能查询到 `tavern.ensure_character`。
- [ ] 能查询到 `tavern.select_character`。
- [x] Fetch 请求包含耗时、状态码等基础信息。
- [ ] 数据积累后能查看 P50、P75、P95。

## 5. 后续验收

真机 development 验收通过后：

1. 部署 Production，并确认 environment 为 `production`。
2. 在 Production 重新验证错误、Replay、用户关联及源码行列还原。
3. 配置 First Seen Error Alert。
4. 接入飞书或 Telegram Webhook；若机器人 payload 不兼容，需要增加格式转换服务。
5. 观察 100% Replay/Trace 的额度和首屏性能，再决定是否降采样。

## 6. 本地验证结果

- Frontend typecheck：通过。
- Frontend lint：通过。
- Frontend tests：17 个通过。
- Sentry sanitizer 专项测试：4 个通过。
- Frontend production build：通过。
- Backend typecheck：通过。
- Backend tests：54 个通过。
