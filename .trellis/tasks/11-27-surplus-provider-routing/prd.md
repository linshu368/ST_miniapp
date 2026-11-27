# 模型供应商路由支持 Surplus

## 背景

运营平台「模型供应商路由」（`llm_provider_routing_config`）目前只能给 OpenRouter 模型配屏蔽 / 优先供应商。Surplus 模型要放进付费模型目录（2026-11-27 16:27 模型目录 v129 已在轻量档启用 Surplus `deepseek-v4.1-flash-1017`），付费 Surplus 调用现在只有全平台统一默认（可靠优先、价格带 100%、屏蔽 dashscope-cn），不设折扣底线、不钉供应商，需要能按模型掌控。

用户 2026-11-27 确认：两边格式不必一样，但都在这一页选；生效范围只管付费模型目录里的 Surplus 模型。

## 需求

1. 同一个配置项、同一页，新增一组 Surplus 规则，按 Surplus 模型 ID 配置：
   - 只走这几家（Surplus body `provider` 白名单，硬限制）；
   - 优先这几家（`provider_order`，只排序，其余仍可派）；
   - 屏蔽这几家（`providers_blocked`，硬拒，与统一屏蔽 dashscope-cn 取并集）；
   - 折扣底线（`X-Min-Discount`，1–100，留空不设）；
   - 派单方式（可靠优先 / 首字优先，留空 = 统一的可靠优先）与价格带（留空 = 统一 100%）；
   - 备注。
2. OpenRouter 现有 7 条规则、字段、行为原样不变。
3. 生效范围：只作用于没有自带路由的 Surplus 首发调用，即模型目录付费档里的 Surplus 模型。畅聊候选、畅聊专用兜底、状态栏、长期记忆的路由不受影响。兜底（OpenRouter）不受影响。
4. 思考参数按规则钉住的那家（白名单第一家，否则优先第一家）的规矩发：mistral 这类不认 reasoning 的不发。
5. 选供应商时，运营平台能看到该模型在 Surplus 的各家：可信与否、在线卖家数、最高 / 中位折扣、全平台 24h 首字 p50 与可用率；统一屏蔽的 dashscope-cn 标出来。
6. CLI 同步：配置走 `config` 命令自动覆盖；新增报价查询接口要有对应 CLI 命令。

## 约束

- 不改数据库：DB 校验函数只检查 `rules`，新键 `surplus_rules` 由 shared zod（运营平台保存草稿、CLI、后端读取）校验。
- 配置读取或解析失败静默降级为空规则（与现有一致），绝不阻断生成。
- 凑不到折扣底线 / 白名单无卖家时 Surplus 返回 404/503，交给付费档既有兜底，不新增重试。
- 不提供「最便宜优先」选项（用户 11-24 定：Surplus 统一可靠优先）。

## 验收

- shared：新 schema 校验（重复、冲突、优先不在白名单内、空规则）与解析函数测试通过。
- backend：付费 Surplus 首发命中规则时 body 带 `provider` / `provider_order` / `providers_blocked`，头带 `X-Min-Discount` / 路由目标 / 价格带；未命中规则、畅聊候选、Surplus 兜底行为不变；钉 mistral 时不发 reasoning。
- admin：页面能新增 / 编辑 / 删除 Surplus 规则，查看报价，保存草稿通过校验；OpenRouter 区不变。
- CLI：`model-provider market <model>` 能读到报价；coverage 测试通过。
- 生产：发布后在 Railway 看 1017 付费轮次的请求参数与实际供应商；配置改动先把 diff 给用户确认再发布。
