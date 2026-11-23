-- Domain: miniapp_features（畅聊「保上」：运营点了保上的模型不再被自动下架，一直上着）
--
-- pinned = true 的模型：评估和真实请求都不会把它下架（质量越线、报价不达标、派不出去都不动），
-- 只在报价还有别家供应商时换供应商；已下架的保上模型不等冷却，初筛通过就上架。
-- 运营手动下架会同时取消保上。
-- 执行顺序：TEST → 生产 → 部署后端（只加带默认值的列，旧后端不受影响）。
-- 回滚：先回退后端，再 ALTER TABLE miniapp_features.free_zone_models DROP COLUMN pinned;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE miniapp_features.free_zone_models
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;

COMMIT;
