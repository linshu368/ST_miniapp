# 移动端预览与固定验收

日常页面修改先复用本环境。真实 Next.js 页面、React Query 和 SSE consumer 照常运行，API 由本机虚构数据提供；无需数据库、Telegram 登录、支付或模型密钥。不是生产联调环境。

## 快速开始

仓库根目录运行，Node >=22，pnpm 9：

```bash
# 首次安装，以后锁文件未变化可跳过
pnpm install --frozen-lockfile
pnpm test:ui:install

# 保持运行，页面源文件修改自动更新
pnpm preview:ui
```

场景选择：[http://127.0.0.1:3121](http://127.0.0.1:3121)。选择状态后进入真实页面；也可直接打开 [http://127.0.0.1:3120](http://127.0.0.1:3120)。浏览器 MCP / Codex 内置浏览器均可访问同一入口，不需要逐次写临时浏览器脚本。

若共享MCP浏览器提示已被其他会话占用，不终止他人的浏览器。独立MCP实例可使用官方 `--isolated` 模式；也可直接用内置浏览器查看预览、用上述固定命令验收。回归测试使用独立浏览器上下文，不依赖共享MCP浏览器的登录或锁状态。

首次访问新页面仍需要 Next 编译；日常让服务保持运行，后续修改热更新。Ctrl+C 停止自己的前端和模拟服务。端口占用时报错，不终止未知进程。模拟接口或场景数据修改后重启预览一次。

## 按修改范围运行

```bash
pnpm test:ui --grep @profile       # 签到、VIP、充值与社群展示
pnpm test:ui --grep @roleplay      # 角色发现、进入对话与返回
pnpm test:ui --grep @chat          # 深度思考、回复偏好、多行输入、余额不足
pnpm test:ui --grep @image         # 同款、设置、生成、失败、保存原图入口
pnpm test:ui --project=android    # 390×844，全部固定流程
pnpm test:ui --project=narrow     # 320×568，关键布局流程
pnpm test:ui                     # 两种尺寸全部已配置流程
pnpm test:ui:report              # 可视化结果、截图、请求摘要、失败 trace
pnpm test:ui:fixtures            # 模拟服务本身的协议与隔离检查
```

自动检查自行启动并关闭3130/3131，不会重置手动预览3120/3121。连续复跑时可先运行 `pnpm preview:ui --test` 保留自动检查环境，随后命令会复用；用例会校验服务标识和工作目录。分别使用 `.next-ui-preview` / `.next-ui-test` 缓存，不覆盖普通 `.next` 构建。

每套环境一次一个场景，自动检查 workers=1、每轮重新初始化。运行自动检查时勿手动操作3130，也不要用 `--workers` 增加并发；需要并行时先设计独立状态。

## 固定场景

| 场景               | 用途                                          |
| ------------------ | --------------------------------------------- |
| `standard`         | 普通用户、可签到、VIP引导、基本聊天与影像路径 |
| `vip`              | 会员身份、签到150、充值与续费展示             |
| `checked`          | 今日已签到、不可再次领取                      |
| `checkin-error`    | 点击签到失败、保留重试、模拟余额不变          |
| `vip-error`        | 权益读取失败，收益未确认时不显示引导          |
| `community-joined` | 已确认加入及领奖，入口隐藏                    |
| `empty`            | 角色、会话及作品为空                          |
| `chat-slow`        | 发送后先展示思考，正文出现时折叠              |
| `chat-error`       | 发送后流内失败与重试入口                      |
| `no-balance`       | 聊天/图片余额不足反馈                         |
| `image-error`      | 触发生成后失败，保留重试且不扣模拟余额        |
| `image-pending`    | 触发生成后保持进行中，可返回看记录            |

`fixtures/data.ts` 是场景与初始数据入口。金额仅为验收示例，不同步线上配置或用户资料。不要将 token、initData、生产响应、聊天或数据库导出放进 fixture / trace。聊天中的语音与附图仅提供静态配置和空记录，本轮不模拟它们的生成。

## 扩展方式

1. 优先在已有分组增加断言，复用 `tests/fixtures.ts` 的场景重置、网络检查和报告。
2. 新状态加在 `fixtures/data.ts`；新接口在 `fixtures/server.ts` 用 shared DTO/schema 适配。不要另起临时 mock。
3. 未实现接口返回 `501 preview_route_missing`，并使自动检查失败。不要用通配空响应或真实后端兜底。
4. 用 role、label、placeholder 定位；等待可观察结果，不固定等待秒数。布局检查关键按钮和横向溢出。
5. 日常按组检查，本工具不自动加入每个PR的完整CI；发布继续遵守既有质量门禁。

## 覆盖边界与清理

验证链路是浏览器 → API请求 → 模拟HTTP/SSE → 真实页面反馈。模拟余额仅验证UI同步，不证明真实记账、OpenRouter/Venice请求参数或支付回调正确。手机尺寸模拟不会产生安卓系统输入法，也不能证明Telegram原生保存、相册权限正常；这些继续专项验收。

既有Vitest、后端计费/并发/SSE/迁移测试有独立覆盖，保留。旧临时UI fixture及浏览器脚本只有在相同行为被接替且实际跑通后才清理；历史截图和验收记录不随意删除。

`output/playwright/` 的结果、日志、截图、trace、HTML报告及Next缓存均不提交。最新报告覆盖旧报告，需要留证时先另存任务指定位置。

依据：[Playwright webServer](https://playwright.dev/docs/test-webserver)、[fixtures](https://playwright.dev/docs/test-fixtures)、[网络控制](https://playwright.dev/docs/network)。
