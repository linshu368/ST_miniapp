# 实施与风险评估

## 审核与复用

2026-10-16 用户批准上一轮提出的“新增兼容迁移，恢复函数及两表约束，不覆盖既有 key”方案。本任务为该有限方案的轻量修复，不扩展产品需求。

复核图片广场 validator、20260916_reconcile_chat_image_managed_config_keys、20261012_image_plaza_v2、20261013_admin_platform_instruction_slots、20261014_image_plaza_tags_feature_and_prompt_zh；Admin saveDraft/upsert_config_draft 调用链沿用上一轮调查结论。复用现有 RPC、validator 与 CHECK 单调 OR 扩展模式；不新建组件、hook、repository 或契约。10/13 覆盖函数及 CHECK 是仓库事实；本轮上下文无法查看截图，不能当 TEST 结构快照。

## 对象归属与最小设计

admin 拥有运营白名单、草稿/发布边界。将现有 is_managed_config_key 改名为本次恢复的前置函数（保留 OID/owner/ACL/逻辑），创建同签名包装入口，只 OR 四个已有图片广场 key。前置函数由迁移写入，生命周期跟随兼容调用链；消费者为管理 RPC 与 CHECK，无新增跨 schema 依赖。配置权威仍为 app_core.runtime_config，保存不发布。不复制全量白名单、不改旧函数正文、不添加通用框架或依赖。

两表 CHECK 读取现有表达式并 OR 修复后的白名单入口，保留 convalidated。函数改名后的旧 CHECK 可能继续引用旧 OID，因此两表必须显式扩展，不仅替换入口函数。新入口禁止 PUBLIC/anon/authenticated/service_role 直调；原前置函数 ACL 不变，RLS/表 grants 不变。

## 可靠性与恢复

- 单事务；lock_timeout=5s、statement_timeout=60s；固定顺序锁 drafts/releases，锁失败停止，无自动重试。
- 一次性迁移：前置备份名称已存在则明确拒绝重跑；workflow 账本负责去重，禁止 force_rerun。
- CHECK 重建可能扫描历史行并持有 ACCESS EXCLUSIVE；运营低峰执行，超时不放宽阈值盲重试。无 backfill、外部调用、限流/降级/补偿需求。
- 前置对象、函数安全属性及校验链缺失则失败；不为未知 shape 静默降级。自检不读写业务行，常量 payload 通过当前 validator 验证；非法输入仍须 22023。
- TEST 单文件 workflow → 保存草稿回读 → 发布回读 → 历史恢复；production 独立审批。失败整体回滚；提交后保留兼容 key，用新 forward-fix，不删除草稿/历史记录或恢复旧窄白名单。

## 执行清单

- [x] 新迁移：前置检查、函数包装、CHECK 扩展与行为自检（尚未实际执行 SQL）。
- [x] 同步 README、架构、迁移 README 与数据库 spec，注明未部署。
- [x] 执行既有验证，结果见下。
- [x] 检查最终 diff，未修改已有 App.tsx/adminNavigation.ts 改动。
- [ ] TEST 人工：模型/分享提示/标签草稿保存；非法模型拒绝；平台规则/标签开关仍正常；只保存不影响正式配置；发布与历史恢复正常；viewer 仍只读。

本机无 psql/docker；MCP 无正式 TEST 项目权限，不执行远端 SQL。迁移内正反向自检必须随 TEST 单文件执行通过，不以 TypeScript 测试代替数据库运行验证。

## 验证结果

- migration lint、git diff --check 通过；shared 16 文件/142 测试通过，Admin 13 文件/110 测试通过。
- shared、CS、reply-renderer typecheck 通过；Admin 单独 typecheck 通过。
- 全仓 typecheck 被 Backend 的 undici 模块缺失阻塞；未改应用依赖或锁文件。
- 全仓 build：CS 通过，Frontend 因 Next.js 内部 ./impl 缺失失败；Admin 独立 build 因 css-tree 引用的 source-map-js/lib/source-map-generator.js 无法解析，在 Vite worker 打包失败，未声称构建全部通过。
- PostgreSQL 实际执行、锁/ACL 实况及 TEST UI 保存/发布/恢复未验证，任务保留 in_progress 等待这些门禁。
