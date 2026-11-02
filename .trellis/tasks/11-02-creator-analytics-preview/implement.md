# 执行计划

1. shared query/response契约与所有消费者校验。
2. creator只读聚合repository、鉴权route，参数化查询及超时。
3. frontend接真实API；首页3条、全部分页、选卡分页；移除preview-only gate。
4. 扩展固定ui-tests fixture及creator测试；真实本地PG验证自用/分支/重生成/退款/多卡/越权及分页。
5. shared测试、跨包typecheck/build、相关backend测试及手机320/390验收，记录边界与结果。
