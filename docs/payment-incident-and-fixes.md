# MiniApp 支付：故障复盘与修复进度

> 适用场景：Telegram Mini App 充值链路（星尘商店）在真机上点「立即支付」后拉不起微信、或跳到厂商页看到报错。
> 相关代码：`packages/backend/src/features/payment`、`packages/backend/src/infrastructure/payment`、
> `packages/backend/src/routes/payment.ts`、`packages/frontend/src/lib/telegram/hooks.ts`、
> `packages/frontend/src/app/(main)/profile/recharge`。

## 问题现象

用户在 Telegram Mini App 里充值时：

1. 点「立即支付」后页面跳到「正在等待支付」并停在那里，微信从未被拉起，也没有任何付款二维码。
2. 在「正在等待支付」页点「重新打开支付页」，会跳到一个新页面，仍然没有微信付款码。该页面显示厂商的
   「站点提示信息：当前支付方式单笔最大限额为 15 元，请选择其他支付方式！」，偶发显示裸 JSON：

```json
{ "code": 500, "msg": "Internal Server Error", "data": null }
```

```json
{ "code": 400, "msg": "<GBK 乱码中文>", "data": null }
```

## 这个模块为什么会走到今天：一次回滚打回原点

支付链路在 7 月底到 8 月初经历了一串「fix 叠 fix」，最后被一次发布回滚整体打回：

| 提交             | 日期  | 内容                                                                       |
| ---------------- | ----- | -------------------------------------------------------------------------- |
| `dde1bbf`        | 07-22 | 走 JLPay V2 直接拉起微信                                                   |
| `c4649ab`        | 07-22 | V2 响应必须是微信直达 scheme，否则拒绝                                     |
| `e77cbec`        | 07-31 | 支付宝下单直接唤起 App                                                     |
| `769e956` (#228) | 08-01 | 后端放行 alipay                                                            |
| `f90825d` (#229) | 08-01 | 支付宝改用 H5 容器唤起（含抓厂商收银台的 `resolveAlipayScheme`）           |
| `9c3af43` (#230) | 08-01 | **新增 `public/pay/launch.html` 中转页**，把 App scheme 交给真实浏览器唤起 |
| `903708b` (#231) | 08-01 | **`openExternalUrl` 改走 SDK 的 `openLink`**，修复支付无法唤起             |
| `479c212`        | 08-01 | **发布回滚**：剔除支付宝直达链路，支付相关文件「整份回退到 main」          |

关键在最后一行。`479c212` 的意图是「本次发布不带支付宝直达唤起，因为该链路在真机上仍未稳定」——这个决定本身没问题。
但它的执行方式是把 `telegram/hooks.ts`、`JLPaymentGateway.ts`、`public/pay/launch.html` 等**整份回退到 main**，
于是 #230 和 #231 这两个**与支付宝无关、修的是微信侧我方 bug** 的提交被一起丢掉了。

结果：`dev` 上跑的是 #231 修复之前的坏代码，而 #231 的 commit message 逐字描述了本次上报的现象。

## 根因

分三层。第一层是我们自己的代码（已修），第二层是厂商上游（待换通道），第三层是配置隐患（待核实）。

### 第一层：我方代码 —— 症状 1 的全部原因

**a) `openExternalUrl` 的 Telegram 分支永远走不到。**
它判断 `window.Telegram.WebApp.openLink`，而这个全局只有引入官方 `telegram-web-app.js` 才存在。
本项目全仓搜 `telegram-web-app` 零命中，用的是 `@telegram-apps/sdk-react`。
所以判断恒为假，一律退化成 `window.location.assign(url)` —— Mini App 原地导航，
而不是让 Telegram 开浏览器。

**b) `weixin://` 被直接 `location.assign`。**
Mini App 跑在 Telegram 的 WebView 里，WebView 分发不了自定义协议，导航过去只会得到
`ERR_UNKNOWN_URL_SCHEME`，端上表现为静默失败或「无法加载」。

**c) 首次拉起被 SPA 跳转吃掉，且永不重试。**
充值页在 `router.push(...)` **之后**才调 `openPaymentUrl`，原地导航与 Next 客户端路由抢跑被丢弃；
而等待页的自动拉起 effect 又被 `payment_started=1` 短路
（`payUrlOpened` 用它初始化成 `true`，充值页每次都带这个参数）。两条叠起来 = 一次都没拉起。

> 附一个预期差：**当前设计里不存在二维码分支**。`JLPaymentGateway.test.ts` 明确断言收到
> `pay_type: 'qrcode'` 就拒绝，产品形态是直达 App，不是出码。所以「没有二维码」不是 bug 而是设计现状。

### 第二层：厂商上游 —— 症状 2 的原因

症状 2 里那个页面，是厂商收银台被渲染在 Mini App 的 WebView 里（因为第一层的 bug 导致原地导航）。
但**页面内容是厂商自己的业务拒绝**，修好第一层也不会消失：

- 「单笔最大限额为 15 元」是厂商 wxpay 通道的限额规则。运营台 `miniapp_payment_plans` 里的档位价格
  全部高于 15 元，厂商直接拒绝出码。
- 那两段 JSON 用的是 `{code, msg, data}` 信封。**我方后端不是这个形状**——见
  `packages/shared/src/api/envelope.ts`，我方是 `{success, error: {code, message}}`，
  且全 `packages/` 搜不到 `Internal Server Error` 字面量。所以这是厂商 API 的报错直接暴露给了用户。
- 400 那条的乱码是厂商返回 GBK 中文被按 UTF-8 解码。反解可还原出含「已」的片段，
  对应易支付「订单号已存在」这类拒单文案，是真实拒单而非随机损坏。

**后端对此完全无感知**：`createLegacyPayment` 只要 `code === 1 && payurl` 就算成功，
`RechargeUseCase` 立刻返回 `pay_url` 并把订单留在 `pending`。
限额拒绝发生在之后加载收银台的时刻，所以订单会白挂 15 分钟，用户也拿不到任何错误提示。

### 第三层：配置隐患（待核实）

**`PAYMENT_NOTIFY_URL` 可能指向 Vercel。** `ops/env/backend.env.production.example` 写的是
`https://<your-vercel-domain>/api/payment/webhook/jlpay`，但这是 Fastify 后端路由；
前端只有 `/api/lobby-characters` 一个 Next route，`next.config.mjs` 也没有 rewrites。
若生产照抄示例，厂商回调会 404，**用户付了钱订单也永远不会变 `completed`**。

**V2 三个变量未出现在生产 env 示例里。** `PAYMENT_V2_BASE_URL`、`PAYMENT_MERCHANT_PRIVATE_KEY`、
`PAYMENT_PLATFORM_PUBLIC_KEY` 在 `ops/README.md` 和 `backend.env.production.example` 中都没有登记，
只有 legacy MD5 那套。这暗示生产走的是 legacy `mapi.php` 路径（`pay_url` 是 https 收银台，
与症状 2 的截图相符），但**需要核实**，因为它决定 `createV2Payment` 里的微信 scheme 硬校验要不要放宽。

## 为什么 CI 没拦住这次回归

`hooks.test.ts` 用 `vi.stubGlobal` 把 `window.Telegram.WebApp.openLink` **凭空造了出来**，
然后断言这条路走通了：

```ts
vi.stubGlobal('window', {
  location: { assign },
  Telegram: { WebApp: { openLink } }, // 真机上不存在的全局
});
```

测试全绿，回归完全隐形。这是本次故障能活到生产的直接原因。

## 当前修复进度

### 已完成：T0（我方代码 bug）

分支 `dev_payment_fix`，四个文件：

| 文件                                                         | 改动                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/frontend/src/lib/telegram/hooks.ts`                | `openExternalUrl` 改走 SDK 的 `openLink`（`web_app_open_link` 桥）；`openPaymentUrl` 的 scheme 分支改为经中转页交给真实浏览器。恢复后与 #231 版本逐字节一致 |
| `packages/frontend/public/pay/launch.html`                   | 取回 #230 的静态中转页；文案改为通道中性（原版写死「支付宝」，微信支付时会闪错 App 名）                                                                     |
| `packages/frontend/src/app/(main)/profile/recharge/page.tsx` | `openPaymentUrl` 移到 `router.push` 之前，消除隐形顺序依赖                                                                                                  |
| `packages/frontend/src/lib/telegram/hooks.test.ts`           | 改为 mock SDK 的 `openLink`；`stubWindow()` 刻意不挂 `window.Telegram`；新增具名护栏 `never relies on the telegram-web-app.js global`                       |

**为什么中转页也要取回**：`openLink` 只支持 http(s)，`weixin://` 交给它打不开。
若生产跑 V2 路径（返回 `weixin://`），不带中转页的 T0 等于没修。网关路径待确认前，两条路径一起覆盖。

**刻意没做**：没有恢复 `resolveAlipayScheme`（#229 那个抓厂商收银台三跳链路再拼 `alipays://` 的实现）。
`479c212` 说「真机上仍未稳定唤起」指的就是它，本次只取回与微信相关、且属于我方 bug 的部分。

验证结果：

- 前端全量 13 files / 53 tests 通过；改动文件 eslint、prettier 干净。
- 护栏有效性经过反向验证：把 `openExternalUrl` 临时换回坏实现，6 条里挂 5 条，含那条具名护栏。
- `tsc --noEmit` 仅剩 4 条 `.next/types` 历史残留报错（指向 `src` 中已不存在的
  `init-st-session`、`tavern`），与本次改动无关。
- **真机拉起未验证**，需在 Telegram 客户端实机过一遍。

### 待办

| 事项                                                    | 归属            | 状态                 |
| ------------------------------------------------------- | --------------- | -------------------- |
| 确认生产走 legacy 还是 V2 路径                          | 运维 / Railway  | 进行中               |
| 核对 `PAYMENT_NOTIFY_URL` 生产实际值                    | 运维 / Railway  | 进行中               |
| 切支付宝通道、前后端白名单都去掉 `wxpay`                | Dev             | 待网关路径确认后开工 |
| 确认厂商支付宝通道已开通及其单笔限额                    | 业务 / 厂商后台 | 未开始               |
| 下单即失败时给用户可见错误（现在只静默留 pending 订单） | Dev             | 未排期               |

若支付宝通道也卡 15 元，换通道解决不了问题，需要考虑拆单或更换服务商。

## 关键诊断方法

### 判断生产走哪条路径

`JLPaymentGateway.canUseV2()` 要求三个变量同时非空，否则落 legacy：

```bash
railway variables --environment production --service <backend> | grep PAYMENT_
```

- `PAYMENT_V2_BASE_URL` + `PAYMENT_MERCHANT_PRIVATE_KEY` + `PAYMENT_PLATFORM_PUBLIC_KEY` 齐全 → V2，
  `pay_url` 是 `weixin://` scheme。
- 任一为空 → legacy `mapi.php`，`pay_url` 是 https 收银台。

### 区分报错来自我方还是厂商

看响应信封形状，不用猜：

| 形状                                                             | 来源                                              |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| `{"success": false, "error": {"code": "...", "message": "..."}}` | 我方后端（`packages/shared/src/api/envelope.ts`） |
| `{"code": 500, "msg": "...", "data": null}`                      | 厂商 API                                          |

### 排查 Telegram 外链唤起

在 Mini App 里任何「打不开 / 无法加载」的外链问题，先确认走的是 SDK 的 `openLink` 而不是
`window.location.assign`。判据是本项目**从不引入** `telegram-web-app.js`，
因此任何依赖 `window.Telegram.WebApp` 的代码都是死分支。
