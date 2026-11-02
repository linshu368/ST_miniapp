# 执行计划

1. 独立审核prd/design/task后启动任务；共享契约先落地通知消费者。
2. backend agent负责shared DTO/config+单文件migration+纯排序+短事务service+routes+历史可信分；扩展相关单测。
3. frontend agent负责鉴权hooks、个人批次/浏览恢复、推荐行换批/撤回、曝光观察；相关既有unit测试。
4. admin agent负责两既有配置编辑器与文案/字段校验、必要管理端测试。
5. root扩展现有PG17集成测试和ui-tests fixture/server/roleplay.spec；核对跨层逻辑与文档，不互改同文件。
6. 运行shared tests、全消费者typecheck、后端测试、前端/admin既有相关测试、构建、变更lint、迁移命名/diff guard；固定UI跑@roleplay/@lobby-rotation含320/390；DB验证幂等并发、权限/归属、迁移重放、时间恢复和旧证据不回填。
7. 独立最终代码审核，修复有效问题；更新模块知识与README/architecture/ui-tests入口；打开本地预览供用户看。无commit/push/远端迁移/发布。

主要失败路径：无score、少候选、下架、锁超时、重复refresh/丢响应、CAS过期、undo重试、曝光重复/错误用户、账号切换、返回时跨24h、首次API失败回公共列表。保留旧版目录兼容consumer。

## 发布前对齐与性能观测

- 已对齐最新 main `7a9ddf27`；只读核对 gallery、roleplay 验收与 admin schema，保留同事的移动端性能预算和 fallback provider 配置。
- 两个任务补齐 `meta.mobile_performance` 并运行 task validate；本任务单独调用 mobile_performance 校验器验证声明，不重复全量测试。合入后的构建及必要回归由主任务执行。
- 发布顺序：先数据库迁移，再部署已包含新字段读写的后端并确认 qualified-v1 评分刷新，再核对前端/运营端；最后在运营配置保留原有评分参数并开启 10% 轮换、24 小时间隔。默认 enabled=false，单纯发版不会自动启用。
- 发布前后各两个完整 24 小时窗按 Android/iOS 与路由记录 Sentry 页面及接口 P95、样本量和来源；不足 100 样本的分组不判定达标。本地验证通过只能说明实现与行为通过，不能写成线上性能已达标。明显回退先关闭轮换开关；评分校准是全局口径，不随轮换灰度开关回退。
