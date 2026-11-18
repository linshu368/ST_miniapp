# 合并设计

## 来源与复用调研

HEAD cad341d5 合入 be737c2，共21个unmerged文件。复用10-16-creation-plaza-video-planning与10-30-fix-video-studio-experience的设计和验收。检索repository-model/feed/worker、image-plaza-errors、video-repository/job/upstream、shared图片/视频契约、StudioReferencePicker、React Query hooks、admin-client configSchemas/menu及ui-tests。

上游拆分repository并迁移admin-client，采用其边界恢复视频能力。保留上游从billing查询首次分享记录、自动打标恒开启和移除PostHog的行为。视频目录注册共享菜单供网页与CLI使用；保留上游参考图选择及角色描述入口。已有图片/视频回归测试足够覆盖本次整合，不新建测试文件。

## 可靠性、简洁与恢复

保留queue超时不自动重投、retrieve/download有限重试、幂等key、报价预扣、失败退款、worker租约和并发上限、终态停止轮询。复用鉴权、限流和签名缓存；运行时HTTP/worker接入现有观测，离线JSON种子CLI按既有离线导入器模式登记。保留数据库错误cause，禁止记录提示词、签名URL和凭证。

不新增产品API、数据库对象、状态源或依赖，不建通用框架。拆分仅服务真实模块职责。无迁移、旧数据回填或发布顺序变化。合并停止条件为类型/关键功能失败；保留合并开始时工作树备份，可逐文件恢复本次改动，不能reset用户全部合并。不操作线上环境；mock成功不代替真实计费与供应商验收。

## 范围审查

用户授权为解决当前合并并保全已有视频功能，逐项对照两侧实现，最终保留可审查工作树。暂存/提交遵循workflow最终人工审查门禁。
