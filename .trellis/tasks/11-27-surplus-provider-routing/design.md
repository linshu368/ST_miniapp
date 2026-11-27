# 设计

## 1. 复用调研

| 检索对象                                                                                                          | 结论                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `shared/api/provider-routing.ts`（OpenRouter 规则 schema / resolve）                                              | 扩展：同 schema 加 `surplus_rules` 数组和 `resolveSurplusRoutingRule`；OpenRouter `rules` 不动                            |
| `shared/api/free-zone.ts` `SurplusRouteObjectiveSchema`、`SURPLUS_ALWAYS_BLOCKED_PROVIDERS`、`surplus_model` 正则 | 复用：路由目标沿用 latency / reliability，模型名正则一致                                                                  |
| `backend/platform/provider-routing.ts` 缓存读取                                                                   | 复用：同一份配置、同一缓存，不新增读取                                                                                    |
| `backend/features/generation/surplus-route.ts` `SurplusRoute`、`surplusRouteBody/Headers/Provider`                | 复用：新增 `catalogSurplusRoute(rule)` 映射，body/头的写法完全复用                                                        |
| `generation-prepare.ts` `resolveTransport`                                                                        | 扩展：付费 Surplus 首发时解析规则放进 `GenerationPreparation.surplusRoute`                                                |
| `generation-dispatch.ts` `resolveSurplusRoute`                                                                    | 扩展：没有自带路由（兜底的 surplusRoute / 畅聊 freeZone）的首发用 prepared 里的规则                                       |
| `surplus-reasoning.ts` 按供应商发思考参数、学拒绝                                                                 | 复用：`surplusRouteProvider(route)` 已按白名单 / 优先第一家；学拒绝从只看 freeZone 改为看首发白名单第一家（畅聊行为不变） |
| `free-zone/surplus-market.ts` `fetchSurplusMarketBook`                                                            | 复用：报价簿；同文件加 24h 供应商表现读取                                                                                 |
| `routes/admin-model-providers.ts` 余额接口、`admin-client/modelProvidersApi.ts`、CLI `model-provider` 命令        | 复用模式：新增 `/:provider/market` 只读接口、客户端函数、CLI 子命令                                                       |
| admin `RelayProviderBalance`（`useAdminApi`、环境隔离）                                                           | 复用模式：报价面板按环境身份丢弃过期响应                                                                                  |
| DB `admin.validate_llm_provider_routing_config`                                                                   | 不改：只检查 `rules`，额外键放行                                                                                          |

## 2. 数据结构

```ts
surplus_rules: Array<{
  surplus_model_id: string; // Surplus 标准模型名，如 deepseek-v4.1-flash-1017
  allowed_providers: string[]; // → body provider（白名单）
  preferred_providers: string[]; // → body provider_order
  blocked_providers: string[]; // → body providers_blocked（与 dashscope-cn 并集）
  min_discount_pct: number | null; // → X-Min-Discount
  route_objective: 'latency' | 'reliability' | null; // → X-SI-Route-Objective；null = 统一可靠优先
  price_tolerance_pct: number | null; // → X-SI-Route-Tolerance-Pct；null = 统一 100
  note: string;
}>; // max 100，默认 []
```

校验：模型不重复；单列表内不重复；屏蔽与白名单 / 优先不能重叠；设了白名单时优先必须是白名单子集；至少设了一项（任一列表非空、底线、目标或价格带）。旧值没有 `surplus_rules` 时 zod 默认 `[]`，线上 v6 原样可读。

## 3. 请求链路

`prepareGeneration → resolveTransport`：`model.provider === 'surplus' && !model.freeZone` 时，复用已发起的 `routingConfig`（对话链路 useFallback 时已读）或新读一次缓存，`resolveSurplusRoutingRule` → `catalogSurplusRoute` → `GenerationPreparation.surplusRoute`。

`createForward`：`surplusRoute = model.surplusRoute（兜底自带）?? freeZone 路由 ?? (首发 ? prepared.surplusRoute : undefined)`。body / 头写法与畅聊完全一致；`forwardToUpstream` 的统一可靠优先头在前，规则头覆盖；统一屏蔽照常合并。

## 4. 报价查询

`GET /api/admin/model-providers/:provider/market?model=<id>`（read 权限，仅 provider=surplus）：并行读公开 `/api/markets/{model}` 与 `/api/analytics/performance/{model}`（各 8 秒、不重试）。报价簿失败 → 502；表现失败 → 表现字段为 null、`performance_status=failed`。按供应商汇总在线卖家数（available && healthy）、最高 / 中位折扣、可信、是否统一屏蔽。

## 5. 可靠性

- 超时：报价两个公开接口各 8 秒；生成链路不新增外部调用。
- 重试：不新增。底线 / 白名单凑不到 → Surplus 404/503 → 既有首字兜底接手（OpenRouter）。
- 降级：配置读取 / 解析失败 → 空规则（沿用 `routing.config_invalid` / `routing.config_read_failed`）。
- 并发 / 事务 / 幂等：只读配置，无写入；Surplus 调用记录冻结的 request_parameters 自然带上新增 body 字段（< 16 KiB）。
- 容量：规则 ≤ 100，屏蔽 ≤ 20 + 统一 1，小于 Surplus 32 上限。
- 成本：非 price 目标 Surplus 按最贵可选报价预留余额，余额紧张时可能 402（沿用余额监控）。

## 6. 最小充分

不新建配置 key、不加迁移、不加表；不做按卖家指定（Surplus 不支持）、不做 max_latency_ms / min_privacy（用户未要求）；不把规则扩到畅聊 / 状态栏 / 记忆（各有配置）。新文件只有报价汇总一个模块和管理端 Surplus 规则子组件（避免路由编辑器超 500 行）。

## 7. 演进与恢复

发布顺序：后端 + 运营平台一起发；规则默认空，发布本身对线上零变化。随后由用户确认 diff 后发布 1017 规则。回滚：删规则（配置回滚）即恢复统一默认；代码回滚不影响已存配置（旧代码 zod 会丢弃 `surplus_rules`）。
