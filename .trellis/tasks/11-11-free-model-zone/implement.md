# 实施计划（分 4 个 PR，按顺序合入）

## PR1 契约与配置

- shared：`free_zone_config` 的 schema；公开的 `PublicFreeZone` / `selection_notice`；目录返回里加两个可选字段。
- admin-client：在 configSchemas 和菜单里登记 `free_zone_config`。CLI 自动支持，跑 admin-cli 的 typecheck 和测试确认。
- 验证：shared 测试，加上 `pnpm -r typecheck`。

## PR2 状态表与评估任务

- 迁移：
  - 在 `miniapp_features` 下建 `free_zone_models`、`free_zone_events`；
  - 在 `analytics_grafana` 下建 `v_free_zone_model_metrics` 视图，评估任务和 Grafana 共用这一份口径；
  - RLS 开启，授权只给 service_role 和 Grafana 只读账号；
  - 附回滚说明，先在 TEST 执行。
- backend `features/free-zone/`：
  - Surplus 公开接口客户端；
  - 评估纯函数；
  - 任务本体（advisory lock 和执行记录，照搬大厅排序任务）。
- 失败路径：接口超时或返回 404、数据为 null、配置非法、拿不到锁、写库失败。

## PR3 线上读路径、生成与扣费

- 栏目快照缓存；目录接口返回 `free_zone` 和 `selection_notice`；选择接口接受免费模型；自动换模型。
- resolve-model 和 turn-preparation：免费模型用栏目的首字参数；Surplus 请求带折扣底线头和供应商白名单。
- 扣费：新增畅聊类别，应扣 0；调用明细记畅聊标记。
- 失败路径：开轮时已经不开放（换模型并给提示，不扣费）；状态读失败（用缓存，没有缓存就当栏目关闭）；Surplus 凑不到折扣返回 404（交给兜底）。

## PR4 前端与本地预览

- 栏目组件、面板和顶栏接入、换模型提示、到点重新拉目录、亮金色和光带样式。
- ui-tests 加场景：开放、福利期未开始、仅限自创、暂未开放、换模型提示；再加 `@free-zone` 自动验收组。390/320 截图。

## Grafana（PR2 合入后）

- 先列出现有模型相关看板，选定放在哪个看板，再加一组「畅聊」面板：平均实际价格、平均输入长度、业务指标趋势、模型状态和上下架记录。

## 上线

1. 迁移：先 TEST，再生产。
2. 部署后端，总开关保持关闭。
3. 部署前端。
4. 通过 CLI 写入运营配置：草稿 → 看差异 → 你确认 → 发布。

上线后观察 24 小时：任务执行记录、状态变化事件、首字统计、调用明细。
