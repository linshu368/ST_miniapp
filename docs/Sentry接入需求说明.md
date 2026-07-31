# Sentry 接入需求说明

负责人：林术  
优先级：T0  
预计工作量：半天到一天

## 一、背景与目标

目前测试人员在手机 Telegram WebView 中遇到卡顿、JavaScript 报错或页面异常时，工程侧通常无法复现，只能依赖截图和口头描述，现场信息丢失严重。

接入 Sentry 后，测试人员只需提供问题发生时间和相关用户或角色，工程人员即可在 Sentry 后台查询当时的错误堆栈、Console 日志、网络请求、操作过程及性能数据，减少人工复现和猜测。

本次接入主要解决以下四类问题：

1. **错误捕获**：自动上报线上 JavaScript 错误，包含完整堆栈、Console 与网络请求上下文，以及错误发生前的用户操作路径（Breadcrumb）。
2. **会话回放**：通过 Session Replay 记录用户的真实操作和页面状态，便于直接还原问题现场。
3. **性能监控**：记录接口请求耗时、长任务和卡顿数据，并在 Sentry Performance 中查看 P50、P75、P95 等耗时分位数，逐步替代现有手动维护的耗时统计。
4. **主动发现**：通过 Sentry Alert 和 Webhook，将首次出现的新错误推送到飞书或 Telegram 工作群。

## 二、接入要求

### 1. Sentry 项目与 SDK

- 使用 Sentry 云版（sentry.io）创建项目，平台选择与本项目实际前端技术栈匹配的类型。
- 安装对应的 Sentry 前端 SDK。
- 在应用入口完成初始化，并结合现有代码结构评估是否采用延迟加载。

### 2. 初始化配置

初始化配置需要包含：

- `dsn`：Sentry 项目的 DSN。
- `environment`：区分生产与测试数据。
  - 生产环境使用 `production`。
  - 测试环境（包括 dev 分支部署）使用 `development`。
- `release`：每次发布携带可识别的版本号，用于定位问题从哪个版本开始出现。
- `browserTracingIntegration()`：启用性能监控。
- `replayIntegration()`：启用 Session Replay。

初始采样配置为：

```ts
tracesSampleRate: 1.0;
replaysSessionSampleRate: 1.0;
replaysOnErrorSampleRate: 1.0;
```

当前用户量较小，性能数据和正常会话先全量采样，后续根据实际额度使用情况决定是否下调。错误会话必须保持 100% 采样。

### 3. Session Replay 内容

Replay 采用以下配置：

```ts
Sentry.replayIntegration({
  maskAllText: false,
  blockAllMedia: false,
});
```

本项目的问题排查与对话内容强相关，因此不做全量文本脱敏，回放中需要能够直接看到用户输入和模型输出。

### 4. 用户标识

登录成功或进入应用并取得业务用户 ID 后，调用：

```ts
Sentry.setUser({ id: '<业务用户ID>' });
```

Sentry 后台需要能够按照业务用户 ID 检索该用户的错误和会话。

### 5. 性能监控

性能监控需要能够采集并展示：

- 接口请求耗时。
- 长任务和卡顿数据。
- 与错误关联的性能数据。
- P50、P75、P95 等耗时分位数。

### 6. 告警推送

在 Sentry 后台配置 First Seen Error 告警规则，并通过 Webhook 接入现有飞书或 Telegram 群机器人。告警规则及 Webhook 配置属于 Sentry 和群机器人后台工作，不在前端代码中实现。

## 三、注意事项

### 1. Telegram WebView 真机验证

项目主要运行在手机 Telegram WebView 中。Session Replay 基于 rrweb 录制 DOM，接入后必须在真机 Telegram 中验证错误、回放和性能数据能够正常上报。

### 2. 首屏性能

当前入口加载时间约为 10～15 秒。接入时需要关注 Sentry SDK 对首屏包体和初始化耗时的影响，可根据项目结构采用 lazy-load，或通过接入前后数据确认首屏耗时没有明显退化。

### 3. Sentry 额度

免费额度约为每月 5,000 条错误和 50 次 Replay，预计可能不足。上线后根据实际使用量决定是否降低正常会话采样率，或升级 Team 版（约 26 美元/月）。

### 4. eruda

可在测试构建中增加 eruda，供测试人员在手机端现场查看 Console：

- 仅测试环境启用。
- 默认隐藏。
- 可通过连续点击版本号 5 次等隐藏入口唤起。
- 不进入生产构建或由可靠的测试环境开关控制。

eruda 是顺手项，不影响 Sentry 主接入和验收。

## 四、验收标准

1. 在生产环境手动抛出一个测试错误后，Sentry 后台能看到错误信息及对应 Session Replay。
2. 在真机 Telegram WebView 中完成一次操作后，Sentry 后台能查询到该会话的 Replay 和性能数据。
3. 首次出现的新错误能够通过 Webhook 推送到工作群。
4. Sentry Performance 面板能够查看接口耗时分布，包括 P50、P75 和 P95。
