# MiniApp 支付：故障复盘与修复进度

> 适用场景：Telegram Mini App 充值链路（星尘商店）在真机上点「立即支付」后拉不起微信、或跳到厂商页看到报错。
> 相关代码：`packages/backend/src/features/payment`、`packages/backend/src/infrastructure/payment`、
> `packages/backend/src/routes/payment.ts`、`packages/frontend/src/lib/telegram/hooks.ts`、
> `packages/frontend/src/app/(main)/profile/recharge`。

## 交接状态（截至 2026-08-20）

接手请先读这一节，再按需往下翻。

**分支**：`dev_payment_fix`（基于 `origin/dev` 的 `3dc41cd`）。

**已提交**：

| 提交      | 内容                                                                                |
| --------- | ----------------------------------------------------------------------------------- |
| `8f2ef87` | T0 我方代码 bug 修复（`openLink` 回归、中转页取回、拉起顺序、测试护栏）+ 本文档初版 |
| 见下      | 生产配置核实结果 + 配置修正（`config.ts` 默认值、ops 两份文档）+ 本文档补充         |

工作区应为干净状态。若 `git status` 显示未跟踪的 `legacy/`，那不是本次产物，提交时排除。

**下一步**：按「下一轮方案：切支付宝通道（交接）」执行。改动只有两个文件，不需要迁移。

**两个卡口**：Railway 上 `PAYMENT_BASE_URL` / `MINIAPP_SHORT_NAME` 已改但**尚未部署**；
T0 的真机验证**还没做**，可与支付宝一起验。

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

分三层。第一层是我们自己的代码（已修），第二层是厂商上游（待换通道），第三层是配置（已核实，见下）。

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

### 第三层：配置（已于 08-20 用 Railway CLI 核实）

Railway 项目 `gallant-insight` / 环境 `production` / 服务 `stminiapp`
（`https://stminiapp-production.up.railway.app`，repo `linshu368/ST_miniapp`）。
核实前的值：

```
PAYMENT_ENABLED       = 'true'
PAYMENT_MERCHANT_ID   = '1002'
PAYMENT_MERCHANT_KEY  = <已设置，32 位>
PAYMENT_BASE_URL      = 'http://jlusdt.com'
PAYMENT_NOTIFY_URL    = 'https://stminiapp-production.up.railway.app/api/payment/webhook/jlpay'
PAYMENT_RETURN_URL    = 'https://stminiapp-production.up.railway.app/api/payment/return'
```

**结论 1：生产走 legacy 路径，不是 V2。** `PAYMENT_` 只有上面 6 个键，V2 那三个
（`PAYMENT_V2_BASE_URL`、`PAYMENT_MERCHANT_PRIVATE_KEY`、`PAYMENT_PLATFORM_PUBLIC_KEY`）**根本不存在**，
所以 `canUseV2()` 恒为假，走 `createLegacyPayment`，`pay_url` 永远是 https 收银台、不会是 `weixin://`。
**推论：`createV2Payment` 里那个微信 scheme 硬校验在生产是死代码，切支付宝时不用动它。**

**结论 2：`PAYMENT_NOTIFY_URL` 指向 Railway 后端，配置是对的**——此前基于 env 示例的怀疑不成立。
两个端点都实测存活：

| 探测                             | 结果                                                            | 说明                                       |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `GET /api/payment/webhook/jlpay` | `400` + body `fail`                                             | 路由存在且在验签，正是无签名请求的设计行为 |
| `GET /api/payment/return`        | `302` → `https://t.me/MIJINGAI_bot/app?startapp=payment_return` | 回跳正常                                   |

即**不存在「付了钱订单不到账」的问题**。有问题的只是 `ops/env/backend.env.production.example` 里
那句 `https://<your-vercel-domain>/...` 是错的示例（已于本轮改为 Railway 后端域名并加了警示注释）。

**已顺带修正的两处配置：**

- `PAYMENT_BASE_URL` 原为**明文 `http://`**，订单信息裸奔。已确认 `https://jlusdt.com/mapi.php`
  走 TLSv1.3、证书校验通过、返回体与 http 逐字节一致后，改为 `https://jlusdt.com`。
- `MINIAPP_SHORT_NAME` 原未设置。代码里 `payment.ts`、`growth.ts`、`botlink/auto_generate.py`
  三处默认值本就是 `app`，所以设置它行为等价，价值是把隐式默认变成明示。已设为 `app`。

> ⚠️ 这两个变量用 `railway variable set --skip-deploys` 写入，**尚未重新部署，生产仍在跑旧值**。
> 下次部署（支付宝那轮）会一并生效。

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

**为什么中转页也要取回**：`openLink` 只支持 http(s)，`weixin://` 交给它打不开。当时网关路径未确认，
若生产跑 V2（返回 `weixin://`）则不带中转页的 T0 等于没修，所以两条路径一起覆盖。

> 事后核实生产走 legacy（见上「第三层」），legacy 只返回 https 收银台，**因此中转页在当前生产是休眠的**，
> 真正起作用的是 `openExternalUrl` 改走 `openLink` 这一条。中转页保留有价值：它本就是被误删的代码，
> 且 `PAYMENT_SCHEME_PATTERN` 已含 `alipays?://`，一旦启用 V2 或厂商改返回 scheme 会自动生效。

**刻意没做**：没有恢复 `resolveAlipayScheme`（#229 那个抓厂商收银台三跳链路再拼 `alipays://` 的实现）。
`479c212` 说「真机上仍未稳定唤起」指的就是它，本次只取回与微信相关、且属于我方 bug 的部分。

验证结果：

- 前端全量 13 files / 53 tests 通过；改动文件 eslint、prettier 干净。
- 护栏有效性经过反向验证：把 `openExternalUrl` 临时换回坏实现，6 条里挂 5 条，含那条具名护栏。
- `tsc --noEmit` 仅剩 4 条 `.next/types` 历史残留报错（指向 `src` 中已不存在的
  `init-st-session`、`tavern`），与本次改动无关。
- **真机拉起未验证**，需在 Telegram 客户端实机过一遍。

### 已完成：生产配置核实与修正（08-20）

见上「根因 · 第三层」。两个疑点都已闭环：生产走 legacy 路径；`PAYMENT_NOTIFY_URL` 配置正确、
回调链路健康。顺带把 `PAYMENT_BASE_URL` 切到 https、补了 `MINIAPP_SHORT_NAME`，
并修正了 ops 两份文档里的错误示例。

### 待办

| 事项                                                    | 归属            | 状态                       |
| ------------------------------------------------------- | --------------- | -------------------------- |
| 确认生产走 legacy 还是 V2 路径                          | 运维 / Railway  | ✅ 已确认 legacy           |
| 核对 `PAYMENT_NOTIFY_URL` 生产实际值                    | 运维 / Railway  | ✅ 配置正确，端点实测存活  |
| 切支付宝通道、前后端白名单都去掉 `wxpay`                | Dev             | **下一轮，方案见下**       |
| 部署使 `PAYMENT_BASE_URL` / `MINIAPP_SHORT_NAME` 生效   | 运维 / Railway  | 待随支付宝那轮一起部署     |
| T0 真机验证（Telegram 客户端实机走一遍）                | QA              | 未做                       |
| 下单即失败时给用户可见错误（现在只静默留 pending 订单） | Dev             | 未排期                     |
| 厂商 wxpay 单笔 15 元限额能否提额                       | 业务 / 厂商后台 | 未跟进（已决定改走支付宝） |

## 下一轮方案：切支付宝通道（交接）

> 决策前提：厂商 wxpay 通道单笔限额 15 元、所有档位价格都高于它，且限额不可控。
> 已决定不再确认支付宝限额，直接实现支付宝路径、微信暂时下掉。

### 核心结论

**因为生产走 legacy 路径，改动比预想的小得多：两个数组 + 一个默认值，网关代码一行不动，不需要迁移。**

依据（都已核实）：

- `createLegacyPayment` 把 `type: params.type` 原样透传给 `mapi.php`，MD5 签名逻辑与通道无关。
  **支付宝在网关层已经是现成的**——当初 #228「后端放行 alipay」改的也只是路由白名单，不是网关。
- `createV2Payment` 里 `payType === 'scheme' && /^weixin:\/\//` 的硬校验在生产是死代码，不用碰。
  留着也安全：将来若启用 V2 而忘了改它，会以 400「支付厂商未返回微信直达 scheme」显式失败，不会静默走错。
- DB 约束 `payment_type IN ('alipay','wxpay')` 自 `014_miniapp_payment_wallet.sql` 起就允许 alipay，
  **不需要迁移**；`prisma/schema.prisma` 里该列是裸 `String`，也不用改。
- 前端 `paymentTypeLabel()`（已处理 alipay）、`AlipayIcon`（`components/icons.tsx` 里已有）、
  订单页都是按动态 `payment_type` 渲染，**历史 wxpay 订单照常展示**。

### 具体改动（两个文件）

**`packages/backend/src/routes/payment.ts`** —— `PAYMENT_TYPES` 改为仅 `['alipay']`，
注释写明 wxpay 因厂商单笔 15 元限额停用。

**`packages/frontend/src/app/(main)/profile/recharge/page.tsx`** —— 同文件内的 `PAYMENT_TYPES`
同步为 `['alipay']`；`useState<PaymentType>('wxpay')` 改成 `'alipay'`。
底部支付方式 chip 里 `isAlipay ? AlipayIcon : WeChatPayIcon` 的三元**保留不动**，
两个 icon 都还在引用，不会产生未使用 import 的 lint 错误。

前后端两个白名单必须同时改（这是上一轮确认过的口径），否则缓存了旧前端的客户端选微信会拿到 400。

### 唤起链路（T0 已打通，无需再改）

```
legacy 返回 https 收银台
  → openPaymentUrl 走非 scheme 分支
  → openExternalUrl
  → SDK openLink（web_app_open_link 桥）
  → Telegram 用真实浏览器打开
  → 厂商页 auto-submit 到支付宝官方 H5 收银台
  → 浏览器把后续交给支付宝 App
```

注意这条路**不经过 `launch.html`**（没有 scheme）。这与 #229 那套抓收银台再拼 `alipays://` 的做法
是两回事：链路更短，不依赖厂商实现细节。**不要恢复 `resolveAlipayScheme`**，
`479c212` 所说「真机上仍未稳定唤起」指的就是它。

### 建议补的测试

`JLPaymentGateway.test.ts` 整个文件只测 V2——**生产实际在跑的 legacy 路径目前零测试覆盖**。
建议照现有 stub `fetch` 的写法补两条：

1. `type=alipay` 时请求体确实带 `type=alipay`，且 MD5 签名可被独立复算验证；
2. 厂商返回 `code=1 + payurl` 时 `createPayment` 返回 `{ success: true, paymentUrl }`。

支付路由本身没有测试文件（全后端只有 `admin-supabase-proxy.test.ts` 一个路由测试），
给它搭 Fastify 测试环境要 mock 鉴权和 Supabase，成本不成比例，不建议这轮做。

### 风险与回滚

- 开关面就是那两个数组，回滚 = 把 `wxpay` 放回去。
- 存量 pending wxpay 订单不受影响（白名单只约束新建订单）。
- **真机验证是必须的**：支付宝唤起正是 #229–#231 反复折腾的地方，只不过这次走 H5 收银台而非
  scheme 直达。同一次真机测试可以把 T0 的微信侧修复一起验了。
- 这轮部署会同时让 `PAYMENT_BASE_URL`（https）和 `MINIAPP_SHORT_NAME` 生效，
  真机验证时留意收银台是否仍能正常打开。

若支付宝通道也卡限额，换通道解决不了问题，需要考虑拆单或更换服务商。

## 关键诊断方法

### 判断生产走哪条路径

`JLPaymentGateway.canUseV2()` 要求三个变量同时非空，否则落 legacy：

```bash
railway variables --environment production --service stminiapp --kv | grep '^PAYMENT_'
```

> `--kv` / `--json` 会打印**明文值**，包含 `PAYMENT_MERCHANT_KEY`。分享输出前先打码。

- `PAYMENT_V2_BASE_URL` + `PAYMENT_MERCHANT_PRIVATE_KEY` + `PAYMENT_PLATFORM_PUBLIC_KEY` 齐全 → V2，
  `pay_url` 是 `weixin://` scheme。
- 任一为空 → legacy `mapi.php`，`pay_url` 是 https 收银台。**（2026-08-20 实测：生产属于这一种）**

### 不下单也能验回调链路是否健康

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://stminiapp-production.up.railway.app/api/payment/webhook/jlpay
```

`400`（body `fail`）= 路由存在且在验签，正常。`404` = 回调地址配错了，订单永远不会 `completed`。

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
