# TTZF 切换交付记录

## 交付状态

代码已切换为易支付：POST 建单、按用户再次指定的 GET 单笔查单、GET 通知验签、回跳/轮询恢复、有限并发对账。旧网关和注册 Webhook 脚本已移除，无数据库迁移。用户要求直接收尾，由工程师在 TEST 环境人工验证；后续本地测试、构建和 UI 验收已停止。

本次未提交、推送或部署，未发起真实支付，未访问远端数据库。

## 停止前的检查结果

- 支付专项：12 个测试文件、141 项通过，包括协议、仓储 CAS、通知/结算、GET 查单、限流调度及脱敏。
- Shared：18 个测试文件、210 项通过。
- `pnpm -r typecheck`：所有包通过。
- 旧引用检查和复杂度检查通过；复杂度检查仍提示仓库已有的其他模块增长项。
- Backend 全量：1372 项通过、3 项失败，位于 conversations-branch / conversations-thinking；包含 5 秒超时和超时后 mock 调用串扰。降低并发复跑仍失败，未认定其与本次改动无关，也未改动这些测试。
- 首轮 Frontend/Admin 构建和 import lint 遇到本地缺失依赖；已执行锁文件固定的 pnpm install --frozen-lockfile --force 修复，不改变依赖版本。Frontend 重跑已编译成功，在后续类型/lint 阶段按用户要求停止；Admin/import lint 未重跑。
- 未执行 UI 验收；本文件收尾后未再启动验证。源码/文档格式整理不代表验证通过。

## TEST 环境配置

- `TTZF_APP_ID`：应用 ID，不能填商户号。
- `TTZF_APP_KEY`：应用密钥，仅放环境变量。
- `TTZF_BASE_URL=https://ttzf8.com/api`。
- `PAYMENT_NOTIFY_URL=https://<TEST 后端域名>/api/payment/notify/ttzf`。
- `PAYMENT_RETURN_URL=https://<TEST 后端域名>/api/payment/return`。
- API、对账 Worker、过期 Cron 使用一致应用配置及 Railway 环境名；仅在准备好后打开 `PAYMENT_ENABLED`。
- 原 `test.txt` 在收尾时已不存在，当前 backend `.env` 也无 TTZF_APP_ID/TTZF_APP_KEY；本次没有写入真实新厂商凭据。工程师在目标环境配置，不应从测试 fixture 取值。

## 人工验收

1. 支付宝、微信分别建单，确认实际返回 HTTPS payurl 与平台交易号；只有 qrcode/urlscheme 的响应目前不会开放收银台。
2. 用文档 GET 单笔接口验证未付 status=0、已付 status=1；核对 pid、out_trade_no、trade_no、type、param、money。查单 key 不出现在应用日志、Sentry span、错误信息中。
3. 通知重复/并发、通知先于建单响应、丢失通知后查单、写库失败后重试、晚付恢复；星尘与 VIP 各确认一次履约，不能重复加权益。
4. 验签错误、重复参数、错金额/渠道/环境/交易号均不得入账；退款告警不自动扣余额；旧厂商未结单人工核对。
5. Android/iOS 真机支付唤起、关闭/重开、Telegram 回跳、订单结果和权益刷新；页面/API P95 按任务声明分别采样，缺样本保持未知。
6. 关闭新建单开关后，已配置的通知与查单仍恢复在途 TTZF 订单。不得用旧厂商版本回滚而遗留 TTZF 在途订单。

建议后续将成功支付回跳、未到账重开和迟到到账加入现有 `packages/ui-tests` 的 `@recharge` 场景，复用固定 fixture；它不能代替真实厂商及数据库验收。
