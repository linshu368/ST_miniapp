# 技术设计（待审核）

## 复用与最小方案

- 复用 CreatePage/useImagePlazaFeedQuery 的 tag id、查询缓存与分页，不过滤浏览器已加载列表。
- Shared feed/标签目录/snapshot.prompt_zh 已足够，不增加公开字段；tag 参数形状不变，匹配语义按需求改变。
- publicImagePlazaFeedTags 移除开关依赖，只返回启用并排序的目录。
- feed route 移除开关关闭时拒绝筛选的分支；保留目录校验，将 label 交给 repository。
- listWorks 将 tags contains 换为中文译文 ILIKE，复用 escapeIlikePattern，保留软删除、搜索、游标与 limit+1。
- 保留 share 自动打标判断；复用 Admin Switch/configMetadata，仅更新开关名称、说明和页面介绍。
- 已检查 config.test.ts/routes/image-plaza.test.ts，可扩展；建议新增单个 repository mock 测试锁定查询字段、转义与组合条件，不连远端。
- 不新增数据库对象/RPC/migration/依赖，不建立同义词或语义检索框架，不新增翻译调用。
- 历史迁移/旧任务的“展示+打标总开关”是旧语义，不改写；当前 README/架构/相关 spec 同步新规则。

## 可靠性

- 只读查询，无新增事务、写入幂等、补偿；分享并发/返利不变。
- 无新增外部服务或重试，沿用配置读取及错误返回。既有 Supabase client 无统一超时是基线缺口，实施前评估本查询有界超时，不声称已修复。
- label 来自目录；转义百分号、下划线、反斜杠，验证 PostgREST 星号别名边界，避免意外扩大查询。
- 无译文不命中，不回退英文/tags；未知/禁用 tag 400；搜索 OR、标签和 cursor 取交集。
- 保留有界分页；前后通配可能增加扫描量，TEST 需测耗时，不凭推断建索引；持续超时/延迟恶化停止发布或回滚。
- 沿用 pino 错误路径，不记录提示词；必要诊断只记允许的 tag id、计数和耗时。

## 演进与恢复

- 先 Backend 再 Admin 文案；Frontend 无协议升级。旧客户端继续传 id；混部可能短暂不同，旧缓存刷新后更新。
- 不回填/删除数据，未译作品在标签筛选中不可见为明确限制。
- 回滚应用提交即可恢复旧语义，不需恢复数据；自动打标开关不能回滚筛选行为。
