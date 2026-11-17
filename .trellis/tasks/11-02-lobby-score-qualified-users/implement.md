# 执行

1. 审核本设计后start。仅修改ranking-stats聚合、关联注释/任务日志；保留评分数学和前端排序。
2. 风险评估：SQL时间边界/样本选择无法由字符串mock证明，新增一个显式本地Docker PG17 integration测试文件是必要回归。复用Vitest、pg现有依赖，默认单测不启动Docker、不接任何远端配置。加入固定test:lobby-ranking命令与现有验收README入口，不建第二套系统。
3. 覆盖资格AND、边界、失败空白、重生成、跨窗口、同卡不反向凑资格、回访观察期、n=0快照覆盖。真实聚合输出与独立期望断言，不复制生产算法作oracle。
4. 跑相关ranking tests、PG17集成与40万合成记录EXPLAIN、Backend全量test/typecheck、shared现有test、静态legacy与diff检查。无UI/HTTP变更，不重复浏览器截图。
5. 独立复核最终SQL/测试，修复发现的问题。同步README/ARCHITECTURE和backend.business.character-lobby模块；记录已执行与未执行验证，交付本地分支，不提交推送。

## 性能声明与联合发布

对齐 main `7a9ddf27` 后补齐本子任务 `meta.mobile_performance`，以离线任务的具体不适用理由通过门禁；运行 task validate 及门禁校验，不为补元信息重复全量测试。当前评分口径与轮换联合发布时，数据库迁移/qualified-v1 首次刷新由主任务统筹；页面与 API 的双端 P95 观察见 `11-02-lobby-quality-rotation`，不得把本地集成/EXPLAIN 耗时当生产指标。
