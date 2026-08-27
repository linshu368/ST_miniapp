# MiniApp 支付星尘不到账 — 修复待办

> 立项：2026-08-27。起因是多名用户在支付平台显示「已支付」但星尘未到账。
>
> 关联文档：
>
> - [`docs/payment-zqpay-v2-integration.md`](./payment-zqpay-v2-integration.md) — 支付链路接入说明（本文修正其中若干过时结论，见 P2-1）
> - [`ops/railway/README.md`](../ops/railway/README.md) — cron 服务的控制台创建步骤

---

## 1. 结论：钱收了，星尘为什么没发

入账逻辑本身没有缺陷。`complete_payment_order` 的事务性和 `credits_added` 幂等都工作正常，四个入账入口也确实共用同一条 `settlePaidOrder()` 路径。**问题在于四条入账路径实际只有两条半在跑。**

| 入账路径           | 触发者               | 生产实际状态                  |
| ------------------ | -------------------- | ----------------------------- |
| 异步通知 webhook   | 厂商服务器推送       | ⚠️ 极不稳定，7 天仅 1 条送达  |
| 同步回跳 return    | 用户浏览器跳转       | ✅ 有效，但依赖用户不中断跳转 |
| 前端轮询查单 query | 用户停留在订单详情页 | ✅ 有效，但依赖用户不关页面   |
| cron 定时查单      | 定时任务             | ❌ **生产环境从未部署**       |

前三条全部依赖「厂商愿意推」或「用户愿意等」。唯一由我方无条件发起的兜底是 cron，而它只存在于 development 环境。

**用户付完款直接关掉 MiniApp，就没有任何一方会去确认这笔支付。** 订单挂到超时，钱在厂商那边，星尘不发。

### 1.1 生产日志佐证（近 7 天）

```
payment.query.paid      4 条   全部 source=query（前端轮询）
payment.query.failed    0 条
payment.settle.completed  10 条 = query 4 / return 5 / webhook 1
```

`payment.query.failed` 仅在传输失败或响应解析失败时打点。**7 天零失败说明生产环境的查单接口完全健康**——问题从来不是「查单会失败」，而是「查单从未被发起」。

对照 08-26 当天更直观：00:36、10:59、13:45、17:25 四笔靠前端轮询查单成功入账；同一天 02:53、08:47 两笔没有。差别不在系统，在于前者用户留在页面上、后者付完就关掉了。

> 注：10 条 `settle.completed` 实际对应 **9 笔不同订单**。`MA_6b352671-...5328` 被记两次（先 `return`，260ms 后 `query`），是两条路径抢着确认同一笔订单，`credits_added` 幂等正确拦住了第二次，星尘没有重复发放。

### 1.2 本次涉及的 6 笔订单

| 订单号                                                       | 创建时间 (CST) | 报告时状态 | 处置                             |
| ------------------------------------------------------------ | -------------- | ---------- | -------------------------------- |
| `MA_8726d327-8e17-4c57-9a2e-c5b1f6687f64_1787797802869_6001` | 08-27 10:30    | pending    | ✅ 已补账 ¥6.00                  |
| `MA_aac417a0-7952-476c-b604-f14a01c45119_1787734032519_8859` | 08-26 16:47    | expired    | ✅ 已补账 ¥28.00                 |
| `MA_feb6dee5-12ab-41c7-804a-861ad6b15cdc_1787712787470_5362` | 08-26 10:53    | expired    | ❌ 超出 24h 对账窗口，待人工处理 |
| `MA_bacd7b51-8236-49e7-9a98-4b791d4eb6cd_1787626401507_9552` | 08-25 10:53    | 表中不存在 | ❓ 待核实，见 §5.2               |
| `MA_728e9245-6ac4-484c-8e8a-b8d3c44e74dc_1787630173937_2038` | 08-25 11:56    | 表中不存在 | ❓ 待核实，见 §5.2               |
| `MA_81fa58f4-ee00-4b5b-82bd-edee53f8149f_1787644943424_5084` | 08-25 16:02    | 表中不存在 | ❓ 待核实，见 §5.2               |

同期成功入账 9 笔、已知失败至少 3 笔，**失败率约 25%**。这不是边缘个案。

---

## 2. 已完成（2026-08-27）

用生产环境变量在本地手工执行了一次 `payment:expire-orders`：

```
payment.query.paid            orderId=MA_aac417a0-...  source=cron
payment.settle.expired_order_reopened  orderId=MA_aac417a0-...  source=cron
payment.settle.completed      orderId=MA_aac417a0-...  amountCents=2800
payment.query.paid            orderId=MA_8726d327-...  source=cron
payment.settle.completed      orderId=MA_8726d327-...  amountCents=600
payment.cron.reconciled       checked=9  settled=2
Expired payment orders: 197
```

两个成果：

1. **补回 2 笔订单**（¥28 + ¥6）。其中 `MA_aac417a0` 在窗口关闭前约 20 分钟捞回，再晚就只能人工补。
2. **cron 逻辑在生产完成首次真实验证**——查单、`reopenExpired`、入账三段全通，`source=cron` 的查单在生产可用。cron 上线因此是「已验证」而非「待验证」。

同时暴露一个新问题：`Expired payment orders: 197`。cron 从未在生产运行，历史上所有超时未支付的 pending 订单一直挂着，这次一次性全部翻成 expired。详见 P0-3。

---

## 3. 待办清单

### P0-1　cron 服务上生产 🔴 紧急

**问题**：`stminiapp-payment-cron` 只存在于 development 环境，生产没有任何兜底查单。

**关键事实：零代码改动。** cron 的完整依赖闭包在 `main` 与 `dev` 之间逐字节一致：

```
packages/backend/src/scripts/expire-payment-orders.ts
packages/backend/src/features/payment/usecases/ExpirePaymentOrders.ts
packages/backend/src/features/payment/usecases/PaymentSettlement.ts
packages/backend/src/infrastructure/payment/ZqPaymentGateway.ts
.railway/railway.ts
ops/docker/Dockerfile.backend
```

`main` 的 `package.json` 已有 `payment:expire-orders` 脚本，`main` 的 `MiniappPaymentOrderRepository` 已有 `listUnsettledAroundExpiry` / `reopenExpired` / `expireAllPending` 全套方法，且使用 `.schema('miniapp')`——正好匹配未执行 099 的生产库。

**方案**：纯 Railway 基础设施操作，按 [`ops/railway/README.md`](../ops/railway/README.md) §「支付对账 Cron」在 production 环境用控制台创建服务。要点：

- 服务名逐字 `stminiapp-payment-cron`；Source 分支 **`main`**（不是 dev）
- Dockerfile Path `/ops/docker/Dockerfile.backend`
- Start Command `tsx src/scripts/expire-payment-orders.ts`
- Cron Schedule `*/5 * * * *`，Restart Policy **Never**，关闭 healthcheck，不生成域名
- 16 个变量全部用 `${{stminiapp.XXX}}` reference，不复制值

> ⚠️ **不要用 `railway config apply`。** 它会连 `stminiapp`（唯一对外服务）一起声明 desired state。仓库 SOP 已明令：plan 若显示会改动 `stminiapp` 的 source / 变量 / 域名 / healthcheck，立即停止改走控制台。

> ⚠️ **第一次 Run 前必须确认 `PAYMENT_ENABLED` 严格等于 `true`。** 见 `ExpirePaymentOrders.ts:42-69`——查单补账整段在 `if (paymentEnabled)` 里，而 `expireAllPending()` 在外面无条件执行。变量拼错或 reference 没接上，cron 会跳过全部对账直接判过期，变成纯粹的订单处决器。在 P0-2 护栏上线前，这个变量是唯一防线。

**验收**：手动 Run 一次，日志出现 `Reconciled before expiry: checked=… settled=…`，deployment 正常退出（exit 0）。`Expired payment orders` 应是很小的数（197 笔积压已清），若又出现几百说明连错了库。同时确认 `stminiapp` 服务未被改动。

---

### P0-2　给 cron 加护栏：查单不健康时不判过期 🔴

**问题**：`expireAllPending()` 目前无条件执行。

```
packages/backend/src/features/payment/usecases/ExpirePaymentOrders.ts:64-70
```

若某天查单整体不通（例如 development 环境撞到的 HTML 响应），这一轮会一笔都对不上账，然后照样把所有 pending 判死。`reopenExpired` 虽能救回，但前提是订单还在 24h 窗口内被再次查到；查单持续不通就永远救不回。

**方案**：统计本轮 `payment.cron.reconcile_failed` 占比，超过阈值（如样本 ≥5 且失败过半）跳过 `expireAllPending()` 并打 error 日志。判过期晚一轮零代价，判错了要靠人工捞。

**验收**：单测覆盖「查单全失败时不执行 expireAllPending」。

**与 P0-1 同批做**——这是本清单里唯一建议和紧急修复捆绑发布的代码改动。

---

### P0-3　存量订单审计 🔴

**问题**：那 197 笔刚被判过期的订单**从未被查过单**，现在全部超出 24h 对账窗口。绝大多数应是用户建单未付的正常废单，但其中有多少是已付未入账的，目前完全未知。加上 `MA_feb6dee5-...5362`（超窗）。

**方案**：分两步，只读在前。

1. 写一次性**只读**审计脚本：遍历所有 `credits_added = false` 的订单逐笔 `queryOrder()`，只输出报告不写库。厂商对过老订单可能不再保留查询记录，报告会直接给出可追溯边界。
2. 人工确认清单和金额后，再决定补账范围与执行方式。

**验收**：产出审计报告（订单号 / 金额 / 厂商返回状态 / 建议动作），经确认后再动写操作。

---

### P1-1　订单列表接口不该在不查单的情况下判过期

**问题**：`routes/payment.ts:171-172`

```ts
const dbUser = await getOrCreateDbUser(request.user);
await orders.expirePendingForUser(dbUser.id);
```

这是本次两笔 expired 订单的直接成因：用户付完款关掉详情页，随后打开订单列表想确认，**这次打开反而把订单判死了**。对比订单详情接口（`payment.ts:152`）先 `reconcileWithGateway` 再返回，这里的不对称是明确缺陷，也违反接入文档 §6.2 反复强调的「顺序不能反」。

这是在制造问题，不是漏兜底，cron 兜不住。

**方案**：倾向直接**移除**这个只读接口里的 expire 调用，判过期完全交给 cron。列表接口做写操作本就不合适，cron 上线后每 5 分钟一轮，及时性足够。备选方案是先对该用户未到账订单 reconcile 再 expire，但会给列表接口引入外部请求延迟。

**依赖**：必须在 P0-1 之后，否则拿掉唯一的 expire 触发点会让 pending 无限堆积。

---

### P1-2　补观测

**问题一**：无法区分「没查单」和「查了但厂商说未支付」。`PaymentSettlement.ts:151`

```ts
if (!result.paid) return false;
```

此处完全静默。本次排查中「4 条 paid / 0 条 failed」这类统计因此无法自证完整性。

**方案**：补一条 `payment.query.unpaid`（info，带 orderId 和 source）。

**问题二**：厂商请求根本没打过来时，没有任何日志。现在只有验签失败才有 `payment.webhook.verify_failed`，「零日志」既可能是没调用也可能是别的。这正是 webhook 送达情况长期说不清的原因。

**方案**：在 `handleZqPayWebhook` 入口、验签**之前**打一条 `payment.webhook.ingress`，使「零日志」可确定性解读为「厂商未调用」。

**问题三（低优先级）**：`QUERY_MIN_INTERVAL_MS` 节流是进程内 `Map`，API 多实例时失效。cron 是独立进程不受影响。

---

### P1-3　webhook timestamp ±10 分钟会误杀厂商重推

**问题**：`routes/payment.ts:367-371`

```ts
function isRecentTimestamp(value: string | undefined): boolean {
  if (!value || !/^\d{10}$/.test(value)) return false;
  const timestampMs = Number(value) * 1000;
  return Number.isSafeInteger(timestampMs) && Math.abs(Date.now() - timestampMs) <= 10 * 60 * 1000;
}
```

易支付系的通知失败后通常延迟重推，间隔可能数小时。带 `timestamp` 的重推会被判 `stale_timestamp` 直接 400 拒绝——而这恰恰是最需要接住的那一次。

代码注释自己写明「防重放由 RSA 验签和 `credits_added` 幂等承担」，10 分钟窗口边际收益接近零，误杀成本是真金白银。

**方案**：放宽到 24 小时，或直接移除该项校验。同步更新接入文档 §5 第 4 条。

---

### P1-4　放宽对账回溯窗口

**问题**：`RECONCILE_WINDOW_MS = 24h`（`ExpirePaymentOrders.ts:16`）。cron 每 5 分钟正常运行时绰绰有余，但本次 197 笔说明——**一旦 cron 停摆，窗口再宽也没用；而窗口太窄会让停摆期间的订单永久失去自动补救机会**。`MA_feb6dee5-...5362` 就是差了几小时。

**方案**：放宽到 72 小时作为停机容忍余量。查单已按 `credits_added = false` 过滤，放宽窗口不会显著增加请求量。

---

### P2-1　更正接入文档中的过时结论

`docs/payment-zqpay-v2-integration.md` 有两处结论已被生产数据推翻：

| 位置                                     | 现有表述                                                                           | 应更正为                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| §6 第 206-208 行                         | 「production、development、pr-276 三个环境**一条请求都没有**——异步通知根本没送达」 | 厂商**偶尔会推**：生产 7 天内有 1 条 webhook 成功入账。属于不可靠而非完全不通 |
| §「星尘不到账时的排查顺序」第 427-431 行 | 「没有任何请求 → 厂商没推送」                                                      | 同上，且在 P1-2 的 ingress 日志上线前该判据不可靠                             |

`PaymentSettlement.ts:10` 的文件头注释（「2026-08-21 实测有整条没推的订单」）同理。

**为什么重要**：「完全不通」和「不稳定」会导向完全不同的后续动作——前者指向配置错误值得找厂商排查，后者指向必须靠自己兜底。

---

## 3.1 回调监控（已实现，2026-08-27）

监控每日「当天创建且已入账」的订单：入账路径分布、cron 查单成功率、cron 追回耗时。

**为什么不是一套仪表盘。** 前两问的数据源不同：路径分布和耗时是订单状态，落在订单行上用一条
SQL 就够；查单成功率是尝试流，**查单失败的订单永远不会变成 completed**，订单表上根本没有
「失败」这件事，只能看 cron 的汇总日志。硬做成一个看板要先建日志管道，日均十几笔的量级不值得。

### source 取值只有四种

`webhook | return | query | cron`，定义在 `packages/shared/src/api/payment.ts` 的
`PaymentSettlementSource`，日志 `source` 字段与 `payment_orders.settled_by` 列共用它。
**没有 `core`**——口头说的 core 指 Railway 上那两个 cron 服务
（`stminiapp-payment-reconcile-cron` 快速查单 / `stminiapp-payment-cron` 过期兜底），
两者的查单与入账都记 `source=cron`，在日志和日报里不区分。

### Q1 路径分布 / Q3 cron 追回耗时 → 订单表

migration 101 给订单加了 `settled_by`，在 `complete_payment_order` 里与翻状态同一个事务写入，
只有真正入账那一次写。重复确认走 `credits_added` 幂等的提前返回、不覆盖，所以两条路径抢同一笔
（本文 §1.1 记的那种）在日报里只算先到的那条一笔，不会双计。

```bash
pnpm exec railway run -e production -s stminiapp -- \
  pnpm --filter @miniapp/backend payment:callback-report
```

只读，不查厂商也不写库，随时可对生产跑。`-- --days-ago=1` 看昨天（日报在 00:xx 跑时要的就是它），
`-- --json` 出机器可读结果。输出形如：

```text
支付回调日报 2026-08-27 (CST)  2026-08-26T16:00:00.000Z → 2026-08-27T16:00:00.000Z
当天建单 7 笔｜已入账 5 笔（71.4%）｜金额 174.00 元
订单状态 pending=1 completed=5 expired=1 failed=0

入账路径            笔数     占比     平均耗时     最长耗时     金额(元)
webhook                0     0.0%            -            -         0.00
return                 1    20.0%        31.0s        31.0s       128.00
query                  1    20.0%        42.0s        42.0s         6.00
cron                   2    40.0%        87.5s        95.0s        34.00
unknown                1    20.0%       120.0s       120.0s         6.00
```

口径三条，看数前先对齐：

- **划天按 `created_at`（CST）**，问的是「当天下的单最后由哪条路径入账」。跨天才追回的订单仍归
  下单那天，否则兜底路径的耗时会被算到第二天去。
- **耗时是 `paid_at - created_at`**，即建单到入账，**含用户付款前的停留时间**。厂商的真实支付时刻
  本地没有，这是现有数据能做到的最稳口径。快速 cron 正常时 `cron` 行应落在 60–90 秒。
- **`unknown` 是 101 之前入账的历史订单**，来源无法追溯，单列一行不摊进四条路径。上线满一天后
  当天订单里不该再出现它。

### Q2 cron 查单成功率 → cron 汇总日志

快速 cron 每轮打一条 `payment.fast_cron.reconciled`，带
`checked / claimed / settled / unpaid / failed`：

```bash
railway logs -e production -s stminiapp-payment-reconcile-cron --json --since 24h \
  | jq -s '[.[] | select(.event == "payment.fast_cron.reconciled")]
           | {claimed: (map(.claimed) | add), settled: (map(.settled) | add),
              unpaid: (map(.unpaid) | add), failed: (map(.failed) | add)}
           | . + {failure_rate: (if .claimed > 0 then .failed / .claimed else 0 end)}'
```

- **查单失败率** = `failed / claimed`
- **`unpaid` 不算失败**——那是「查通了，用户还没付」。绝大多数轮次都是 unpaid 占满，把它算进
  失败会得出一个恒定 90% 以上的假失败率
- 过期 cron 的 `payment.cron.reconciled` 也已补上 `failed`，两个服务同口径

失败率是本清单 P0-2 护栏的输入信号：样本 ≥5 且失败过半时 cron 会跳过判过期并打
`payment.cron.expiry_skipped`。日报里看到失败率抬头，先查 §5.1 的出口 IP / WAF 一类环境差异。

### 上线顺序：迁移必须先于代码

1. 先执行 `packages/shared/migrations/101_payment_settled_by.sql`（test、production 各一次）。
   它自己探测订单表在 `miniapp` 还是 `billing`，两个环境同一份文件，与 099 排期解耦。
2. 再部署代码。

**顺序不能反。** 101 把入账函数换成三参签名，第三参 `DEFAULT NULL`，所以**迁移先跑、旧代码还在
线上时照样能入账**（只是 `settled_by` 留空）；反过来先发代码，RPC 带着 `p_settled_by` 打到只有
两参的函数上，四条入账路径会一起失败——那正是本文要修的故障。

新旧签名不能共存（两参调用会因重载而歧义，099 preflight 也拒绝同名重载），所以 101 把建新函数和
删旧函数放在同一个 DO 块里，一个事务内完成。迁移末尾的 `NOTIFY pgrst, 'reload schema'` 是让
PostgREST 丢掉缓存的两参签名，漏掉它 rpc 调用会继续按旧签名解析。

---

## 4. 分支与排序约束

当前拓扑：`origin/main` 完整包含在 `origin/dev` 中，`dev` 领先 11 个提交。

**`dev` 不能直接合进 `main`。** 那 11 个提交里有 `6054639 refactor: 业务表按归属域访问`，会把 `getDomainDb('billing')` 带上生产；而 migration 099 只在测试库执行过，生产库没有 `billing` schema。后果是 `Invalid schema: billing` 全线报错，影响远不止支付。

因此：

1. **P0-1 不需要合任何代码**，纯基础设施操作，与 099 排期完全解耦。cron 的 Source 钉在 `main`，`main` 不随 `dev` 移动。
2. **P0-2 及后续代码改动**从 `main` 切干净的 hotfix 分支：

   ```bash
   git fetch origin
   git switch -c hotfix/payment-cron-guard origin/main
   ```

3. ⚠️ **凡是走 hotfix 直接进 `main` 的改动，事后必须前向合并回 `dev`。** 现在的包含关系一旦被打破，将来 `dev → main` 会用旧版本静默覆盖掉 hotfix，护栏被无声回退。
4. 099 / PR 289 的生产上线排期单独设计，不阻塞也不被本清单阻塞。

---

## 5. 未决问题

### 5.1 development 环境查单返回 HTML，根因未证实

生产查单 7 天零失败，dev 环境却返回 HTML。同一份 `queryOrder()` 代码、同一个 URL、同一份签名参数——**差异在环境（出口 IP / WAF / 商户凭据），不在代码，也与触发方式（cron 还是前端轮询）无关**。

已不阻塞生产，但**不能就此搁置**：若根因是出口 IP 白名单一类，而 Railway 出口 IP 并不保证长期不变，生产不能假定永远免疫。这正是 P0-2 护栏要防的场景。

排查工具已就绪：`packages/backend/src/scripts/diagnose-zqpay-query.ts`（只读，捕获实际 HTTP 交换的 URL / 状态码 / content-type / 响应体预览）。

### 5.2 三笔「表中不存在」的订单

`RechargeUseCase.createOrder()` 是**先写库、再调厂商下单**，所以订单号能出现在子千易那边，就说明当时库里一定有这行。生产代码没有任何删除 `payment_orders` 的路径，schema 拆分也没丢数据。

**最可能的解释**：这三笔写进的是测试库而非生产库。dev/test 与生产**共用同一个 `PAYMENT_MERCHANT_ID`**（它在 `.railway/railway.ts` 的 `COMMON_API_VARIABLES` 里，两个环境都有），子千易商户后台会把两个环境的订单混在一起展示。

**待办**：去测试库 `zoqelpfhurwehlvypryl` 按这三个订单号查一次，证实或推翻。

**衍生问题**：共用商户号本身是运维隐患——厂商后台无法区分环境，排障时容易把测试订单误判为生产事故（本次就发生了）。应评估申请独立测试商户号，或至少在文档中固化这个已知混淆点。

### 5.3 webhook 送达率

7 天 1 条。需对比 `recharge.order.create` 日志里的 `notifyUrl` 与厂商商户后台配置的异步通知地址。此项在 P1-2 的 ingress 日志上线后才能得到可靠判据。

---

## 6. 建议执行顺序

| 批次   | 内容                                    | 性质                 |
| ------ | --------------------------------------- | -------------------- |
| 第一批 | P0-1（基础设施）+ P0-2（hotfix 分支）   | 止血，新订单不再漏账 |
| 第二批 | P0-3 只读审计 → 确认后补账              | 清理存量             |
| 第三批 | P1-1 / P1-2 / P1-3 / P1-4 合并为一个 PR | 消除成因与观测盲区   |
| 随手   | P2-1 文档更正                           | 随第三批一起         |

---

## 变更记录

| 日期       | 内容                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 2026-08-27 | 立项。手工补账 2 笔（¥28 + ¥6），cron 逻辑完成生产首次验证，清理 197 笔历史积压 pending 订单                         |
| 2026-08-27 | 补回调监控（§3.1）：migration 101 落 `settled_by`，新增只读日报 `payment:callback-report`，过期 cron 汇总补 `failed` |
