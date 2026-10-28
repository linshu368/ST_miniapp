# 图片广场种子数据与 Storage 生产迁移

## 2026-10-20 执行授权更新（优先于下方历史记录）

用户明确授权使用本机 `G:\JobLib\ST_miniapp\packages\backend\.env` 和 Supabase MCP 直接迁移 Storage，无需再次审批；本阶段不执行 SQL。采用本地暂存、6 路有限并发、生产回读校验。MCP 仅确认目标及只读 catalog，图片通过 Storage API 搬迁。用户授权不代表 Dashboard 用量、来源审核或业务 SQL 前置条件已验证。

## Goal

2026-10-21 用户明确要求不再重复生产回读已完成图片、直接补传剩余项。允许沿用同一清单的已验收 receipt；未完成对象仍必须上传并回读校验。报告必须区分历史验收与本轮验收，不代表本轮重新证明全部远端对象当前状态。SQL 仍未授权。

将已审核的 TEST civitai_seed 快照及真实 Storage 图片迁移到 production，保留内容而不迁移用户行为。

## Requirements

- 用户已确认来源 TEST zoqelpfhurwehlvypryl，目标 production wbtsfzozlmurljvglhpn；当前只批准规划和只读预检。
- 范围为 8032 条未软删除种子作品及关联 artifact、8032 个图片对象，共 16637199531 字节；不包括用户生成内容、孤立 artifact、点赞、账务或配置。
- 目标重新生成 UUID；保留 snapshot（含中文提示词）、标签、发布时间与来源信息；不迁移 initial_feed_order。
- 不覆盖不同内容、不恢复软删除、不删除已有文件。图片实体必须先复制并验收，随后才导入数据库。
- 凭据、业务数据与对象清单不得提交 Git；生产写入、容量费用、备份恢复和来源审核需独立确认。
- 无新数据库对象、应用接口或运行时行为改动。
- 2026-10-20 用户选择 TEST 本地暂存方案：按固定 manifest 下载原始文件并保存 SHA-256，再上传 production，生产全量回读校验后才导入 SQL；不从来源站重新抓取，不重跑原 seed importer。
- 留到明天（2026-10-21）继续处理，当前仅记录规划，保持 planning；不启动下载、不安排自动执行，生产 Storage/SQL 写入仍需分别批准。

## Acceptance Criteria

- [x] 本地完整导出及 SQL/payload/manifest/template hash、数量、Git 忽略校验通过。
- [ ] 生产实际结构、RPC、约束、RLS/grant、迁移账本/checksum、bucket 和模型兼容验证通过。
- [ ] 隔离环境验证新增、重复、冲突、缺图、超时、中途失败与回滚。
- [ ] 8032 个图片对象的路径、大小、MIME、实际内容逐项一致，大图签名访问通过。
- [ ] 数据库提交确认；新增/跳过总数、关联完整性、中文提示词与标签一致；生产原有内容/点赞不变。
- [ ] 广场详情、筛选、用同款、点赞及初始排序发布顺序验收，记录恢复边界。

## Notes

- 已通过 MCP 确认生产项目及 Pro 组织元信息，不等于已连接生产数据库或核验结构；未由本任务启动图片迁移或 SQL 导入，实际生产待执行迁移未知。
